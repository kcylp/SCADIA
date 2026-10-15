'use strict';

const fs = require('fs');
const path = require('path');
const MAX_TAGS = 80;
const MAX_RANGE_MS = 86400000;
const MAX_AGE_MS = 30000;
const intent = (id, name, requirement) => ({ id, name, requirement });
const MODULES = [
    { id: 'scada', name: 'SCADA / DAQ', source: '权限可见实时标签与历史', intents: [intent('current_anomalies', '当前异常', 'current'), intent('history_trend', '历史趋势', 'history'), intent('data_quality', '质量与断点', 'current')] },
    { id: 'mes', name: 'MES', source: 'MES 定义、绑定变量与历史', intents: [intent('configuration_review', '工序/订单定义与绑定审阅', 'definitions'), intent('production_trend', '生产指标历史', 'history')] },
    { id: 'ems', name: '能源管理', source: '能源定义、单位、绑定变量与历史', intents: [intent('metering_integrity', '计量完整性', 'definitions'), intent('energy_trend', '时段趋势', 'history')] },
    { id: 'video', name: '视频与 AI', source: '检测与事件文件时间证据', intents: [intent('detection_freshness', '检测新鲜度', 'tracks'), intent('event_counts', '事件计数', 'counts')] },
    { id: 'alarms', name: '报警', source: '权限过滤的当前与历史报警', intents: [intent('current_alarms', '当前报警', 'alarms'), intent('history_frequency', '历史频率与恢复', 'alarm_history')] },
    ...[['recipes', '配方'], ['schedules', '调度与脚本'], ['reports', '报表'], ['calibration', '标定']].map(([id, name]) => ({ id, name, source: '权限可见定义元信息（不代表已执行）', intents: [intent('definition_review', '定义完整性与关联审阅', 'definitions')] })),
    { id: 'devices', name: '设备与协议', source: '可见设备状态与标签质量', intents: [intent('connection_status', '连接状态', 'devices'), intent('tag_quality', '标签质量', 'current')] },
    { id: 'platform', name: '平台', source: '本次进程运行状态', intents: [intent('runtime_status', '服务运行状态', 'runtime')] }
];
const LIMITATIONS = ['模型仅分析，不写设备、不改报警、不执行脚本', '配置不代表生产事实或已执行；不得推算 OEE、产量、费用或节能收益', '陈旧、缺失、空事件与未知质量不能解释为现场正常；历史质量 unknown 不得改为 good'];
function scalar(v) { return v === null || ['string', 'number', 'boolean'].includes(typeof v); }
function text(v) { return typeof v === 'string' ? v.slice(0, 256) : ''; }
function timestamp(v) { const t = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) || Date.parse(v) : NaN); return Number.isFinite(t) && t > 0 ? t : null; }
function freshness(ts, now) { return ts && now >= ts && now - ts <= MAX_AGE_MS ? 'fresh' : (ts ? 'stale' : 'missing_timestamp'); }
function rows(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return [];
    if (!Array.isArray(value) && value.id) return [value];
    return Object.values(value).flatMap(v => rows(v, depth + 1));
}
// Bindings are structural keys, never text guessed from names, expressions or client evidence.
function bindings(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return [];
    const out = [];
    for (const [key, v] of Object.entries(value)) {
        if (/^(tagId|variableId|sourceTagId|.*TagId)$/.test(key) && typeof v === 'string') out.push(v);
        else if (key === 'tagIds' && Array.isArray(v)) out.push(...v.filter(x => typeof x === 'string'));
        else if (v && typeof v === 'object' && !/^(code|script|credentials|connection|property)$/i.test(key)) out.push(...bindings(v, depth + 1));
    }
    return [...new Set(out)];
}
function canRead(runtime, permission, item) {
    if (!item) return false;
    if (typeof runtime.checkPermission !== 'function') return !runtime.settings?.secureEnabled;
    try { return !!runtime.checkPermission(permission, item).show; } catch (_) { return false; }
}
function tagsFor(runtime, permission, project) {
    const out = [];
    for (const [deviceId, dev] of Object.entries(project?.devices || {})) {
        if (!canRead(runtime, permission, dev)) continue;
        for (const [id, tag] of Object.entries(dev.tags || {})) {
            if (canRead(runtime, permission, tag)) out.push({ id, name: text(tag.name) || id, deviceId, unit: text(tag.unit), type: text(tag.type) });
        }
    }
    return out;
}
function definition(row, allowed) {
    const tagIds = bindings(row).filter(id => allowed.has(id));
    // Explicit field projection prevents connection options, code and credentials entering evidence.
    const out = { id: text(row.id), name: text(row.name), type: text(row.type), unit: text(row.unit || row.sourceUnit), tagIds };
    for (const key of ['model', 'mode', 'enabled', 'version']) if (scalar(row[key]) && row[key] !== undefined) out[key] = typeof row[key] === 'string' ? text(row[key]) : row[key];
    out.bindingCount = bindings(row).length;
    out.visibleBindingCount = tagIds.length;
    return out;
}
async function collect(runtime, req, body, permission) {
    const now = Date.now();
    const module = MODULES.find(m => m.id === body.module);
    const goal = module?.intents.find(i => i.id === body.intent);
    const ctx = { module: module?.id || null, intent: goal?.id || null, analysisGoal: goal?.name || null, generatedAt: now, tags: [], selectedTagIds: [], evidence: [], evidenceIds: [], evidenceQuality: { sufficient: false, missing: [] }, limitations: LIMITATIONS.slice(), status: 'evidence_insufficient' };
    const missing = (code, message, remediation) => ctx.evidenceQuality.missing.push({ code, message, remediation });
    const add = (id, kind, data, status = 'available') => { ctx.evidence.push({ id, kind, collectedAt: now, status, data }); ctx.evidenceIds.push(id); };
    const finish = () => { ctx.evidenceQuality.sufficient = !ctx.evidenceQuality.missing.length; ctx.status = ctx.evidenceQuality.sufficient ? 'ready' : 'evidence_insufficient'; return ctx; };
    if (!goal) { missing('invalid_target', '必须选择白名单内的 module 和 intent', '从 /api/analysis/modules 选择模块与目标'); return finish(); }
    const kind = goal.requirement;
    const from = body.from === undefined ? now - 3600000 : body.from;
    const to = body.to === undefined ? now : body.to;
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > MAX_RANGE_MS || to > now + 1000) {
        missing('invalid_window', '时间窗必须为有效毫秒时间戳，正向且不超过24小时', '选择过去24小时内的分析窗口'); return finish();
    }
    ctx.window = { from, to, interval: '[from,to)' };
    if (module.id === 'platform' && kind === 'runtime') {
        add('platform:runtime', 'runtime_status', { observedAt: now, uptimeSeconds: Math.floor(process.uptime()), nodeVersion: process.version });
        ctx.limitations.push('仅证明分析服务所在进程可响应，不证明外部数据库、现场设备或其他服务就绪');
        return finish();
    }
    let project;
    try { project = await runtime.project?.getProject(req.userId, permission, { lazyViews: true }); } catch (_) { /* reported below */ }
    if (!project) { missing('project_unavailable', '工程不可用', '检查工程加载状态'); return finish(); }
    const tags = tagsFor(runtime, permission, project);
    const allowed = new Set(tags.map(t => t.id));
    if (body.tagIds !== undefined && (!Array.isArray(body.tagIds) || body.tagIds.length > MAX_TAGS || body.tagIds.some(id => typeof id !== 'string' || !allowed.has(id)))) {
        missing('tags_unavailable', '所选标签不存在、不可见或超过80个', '重新选择当前账号可见标签'); return finish();
    }
    let ids = [...new Set(body.tagIds || [])];
    const boundModule = ['mes', 'ems'].includes(module.id);
    if (boundModule || kind === 'definitions') {
        let definitions;
        try {
            if (module.id === 'calibration') {
                definitions = runtime.settings?.calibration?.enabled === false ? [] : await runtime.calibrationService?.getProfiles();
            } else if (module.id === 'schedules') {
                const stored = await runtime.schedulerStorage?.getAllSchedulers();
                // Scheduler settings are admin-owned; do not expose global definitions to ordinary users.
                const admin = !runtime.settings?.secureEnabled || [-1, 255].includes(permission) || permission?.groups === 255;
                definitions = admin ? (stored || []).map(s => ({ ...s.data?.settings, id: s.id })) : [];
                const scripts = rows(project.scripts).filter(s => !runtime.scriptsMgr?.isAuthorised || runtime.scriptsMgr.isAuthorised(s, permission));
                definitions = definitions.concat(scripts);
            } else definitions = rows(project[module.id]);
            definitions = rows(definitions).filter(r => canRead(runtime, permission, r));
        } catch (_) { definitions = []; missing('definitions_unavailable', '定义读取失败', '检查对应模块存储与权限'); }
        const visible = definitions.filter(r => bindings(r).every(id => allowed.has(id))).slice(0, MAX_TAGS).map(r => definition(r, allowed));
        if (!visible.length) missing('definitions_missing', '没有可见的模块定义', '配置该模块并检查定义及绑定标签权限');
        const bound = [...new Set(visible.flatMap(r => r.tagIds))];
        if (boundModule && visible.some(r => r.bindingCount === 0 || r.visibleBindingCount === 0)) missing('bindings_missing', '模块定义缺少权限可见的绑定变量', '为每个模块定义绑定可见标签');
        if (module.id === 'ems' && (!visible.length || visible.some(r => !r.unit && r.tagIds.some(id => !tags.find(t => t.id === id)?.unit)))) missing('unit_missing', '计量单位缺失', '为能源计量定义或标签配置单位');
        add(module.id + ':definitions', 'configuration_only', visible);
        if (kind === 'definitions') { ctx.limitations.push('本目标仅审阅定义，不证明已下装、已执行、已生成报表或标定已生效'); return finish(); }
        
        ctx.tags = tags.filter(t => bound.includes(t.id)).slice(0, MAX_TAGS);
        if (!ids.length) ids = ctx.tags.map(t => t.id);
        if (ids.some(id => !bound.includes(id))) missing('unbound_tags', '所选标签未绑定该模块', '选择该模块的绑定标签');
    } else ctx.tags = tags.slice(0, MAX_TAGS);
    if (['current', 'history'].includes(kind) && !ids.length) ids = ctx.tags.map(t => t.id);
    if (['current', 'history'].includes(kind)) {
        ctx.selectedTagIds = ids;
        if (!ids.length) missing('tags_missing', '没有选定可见且与目标关联的标签', '勾选标签或配置模块绑定变量');
        if (ctx.evidenceQuality.missing.length) return finish();
        const current = [];
        for (const id of ids) {
            try {
                const raw = await runtime.devices?.getTagValue(id, true);
                const ts = timestamp(raw?.timestamp ?? raw?.ts);
                current.push({ id, value: scalar(raw?.value) ? raw.value : null, quality: scalar(raw?.quality) && raw.quality !== undefined ? raw.quality : 'unknown', timestamp: ts, freshness: freshness(ts, now) });
            } catch (_) { current.push({ id, value: null, quality: 'unknown', timestamp: null, freshness: 'unavailable' }); }
        }
        add(module.id + ':current', 'current', current);
        if (kind !== 'history' && current.some(t => t.freshness !== 'fresh' || t.value === null || t.value === undefined || (typeof t.value === 'number' && !Number.isFinite(t.value)))) missing('current_missing_or_stale', '当前值缺失或原始时间超过30秒', '恢复采集并取得带原始时间的新鲜样本');
        if (kind === 'history') {
            try {
                const history = await runtime.daqStorage?.querySeries(ids, from, to, { limits: { maxTags: MAX_TAGS, maxRangeMs: MAX_RANGE_MS, maxPointsPerTag: 1000, timeoutMs: 5000 } });
                const series = ids.map(id => ({ id, status: history?.status?.[id] || 'unavailable', points: (history?.series?.[id] || []).filter(p => p && Number.isFinite(p.t) && p.t >= from && p.t < to && scalar(p.v) && p.v !== null), gaps: history?.gaps?.[id] || [] }));
                add(module.id + ':history', 'history', series);
                if (series.some(s => s.status !== 'ok' || s.points.length < 2)) missing('history_missing', '所选时间窗历史不足或读取失败（每标签至少2点）', '启用归档并采集至少两个历史样本，或调整时间窗');
            } catch (_) { missing('history_unavailable', '历史读取失败', '检查归档服务和时间窗'); }
        }
    } else if (kind === 'tracks' || kind === 'counts') {
        const filename = kind === 'tracks' ? 'ai-tracks.json' : 'ai-counts.json';
        try {
            const root = runtime.settings?.imagesFileDir;
            if (!root) throw new Error('unavailable');
            const file = path.join(root, filename);
            if (fs.statSync(file).size > 1024 * 1024) throw new Error('too_large');
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const detectionTimes = kind === 'tracks' && Array.isArray(data.detections) ? data.detections.map(item => timestamp(item?.timestamp)).filter(Boolean) : [];
            const ts = timestamp(data.updatedAt) || (detectionTimes.length ? Math.max(...detectionTimes) : null);
            const state = freshness(ts, now);
            // Files are platform-wide. Without per-camera ACLs, secure mode requires project-admin access.
            if (runtime.settings?.secureEnabled && ![-1, 255].includes(permission) && permission?.groups !== 255) { missing('video_permission', '视频汇总需要平台管理员权限', '使用有权查看平台视频汇总的账号'); return finish(); }
            const summary = { updatedAt: ts, ageMs: ts ? now - ts : null };
            let valid = false;
            if (kind === 'tracks') { valid = Array.isArray(data.detections); summary.detectionCount = valid ? data.detections.length : null; summary.camera = text(data.camera); }
            else {
                const todayCounts = data.byKind && typeof data.byKind === 'object' ? data.byKind : null;
                valid = !!todayCounts && Object.keys(todayCounts).length > 0 && Object.values(todayCounts).every(v => Number.isFinite(v) && v >= 0) && !timestamp(data.clearedAt);
                summary.counts = valid ? Object.fromEntries(Object.entries(todayCounts).slice(0, 80).map(([key, v]) => [text(key), v])) : null;
                summary.period = text(data.today);
                summary.clearedAt = timestamp(data.clearedAt);
                ctx.limitations.push('事件证据使用 today/byKind 当天桶；total 是跨日累计，只作为背景，不能替代当天计数');
            }
            add('video:' + filename, 'video', summary, state);
            if (state !== 'fresh' || !valid) missing('video_missing_or_stale', '视频证据过期或结构缺失', '恢复对应检测/事件采集服务，确认30秒内时间戳');
        } catch (_) { missing('video_unavailable', '视频证据文件缺失或无法读取', '检查视频采集输出目录及文件结构'); }
    } else if (kind === 'alarms' || kind === 'alarm_history') {
        try {
            const data = kind === 'alarms' ? await runtime.alarmsMgr?.getAlarmsValues(null, permission) : await runtime.alarmsMgr?.getAlarmsHistory({ start: from, end: to }, permission);
            if (!Array.isArray(data) || !data.length) missing('alarms_missing', '没有可见报警记录，无法据此判断系统无报警', '检查报警权限、采集和查询窗口');
            const alarms = (Array.isArray(data) ? data : []).slice(0, 500).map(a => Object.fromEntries(['name', 'type', 'status', 'ontime', 'offtime', 'acktime', 'value', 'text', 'group'].filter(k => scalar(a[k]) && a[k] !== undefined).map(k => [k, typeof a[k] === 'string' ? text(a[k]) : a[k]])));
            add('alarms:' + kind, 'alarms', alarms);
            if (data?.length > 500) ctx.limitations.push('报警记录超过500条，仅发送前500条，不能当作完整频率统计');
        } catch (_) { missing('alarms_unavailable', '报警读取失败', '检查报警存储及权限'); }
    } else if (kind === 'devices') {
        try {
            const status = await runtime.devices?.getDevicesStatus();
            const deviceIds = [...new Set(tags.map(t => t.deviceId))];
            const devices = deviceIds.filter(id => status && status[id] !== undefined && status[id] !== null).map(id => ({ id, name: text(project.devices[id].name), protocol: text(project.devices[id].type), status: scalar(status[id]) ? status[id] : text(status[id]?.status), observedAt: now, tagIds: tags.filter(t => t.deviceId === id).map(t => t.id) }));
            add('devices:status', 'runtime_status', devices);
            if (!devices.length || devices.some(d => d.status === '')) missing('device_status_missing', '没有可见设备的运行状态', '检查设备权限与驱动运行状态');
            ctx.limitations.push('observedAt 是服务读取时间，不是设备现场心跳；连接状态不证明测量正确');
        } catch (_) { missing('device_status_unavailable', '设备状态读取失败', '检查驱动运行状态'); }
    } else if (kind === 'runtime') {
        add('platform:runtime', 'runtime_status', { observedAt: now, uptimeSeconds: Math.floor(process.uptime()), nodeVersion: process.version });
        ctx.limitations.push('仅证明分析服务所在进程可响应，不证明外部数据库、现场设备或其他服务就绪');
    }
    return finish();
}
module.exports = { MODULES, collect };
