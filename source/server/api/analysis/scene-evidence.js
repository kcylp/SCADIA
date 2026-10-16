'use strict';

const SCENE_TARGETS = [
    ['V1', '门口进入'], ['V2', '跌倒复核'], ['V3', '抽烟复核'], ['V4', '安全帽'],
    ['V5', '人员聚集'], ['V6', '禁区 / 滞留'], ['V7', '烟火 / 通道 / 画质'], ['T1', '红外辅助']
].map(([id, name]) => ({ id, name, source: id === 'T1' ? 'thermal' : 'visible' }));
const text = (v, max = 500) => typeof v === 'string' ? v.slice(0, max) : '';
const time = v => Number.isSafeInteger(v) && v > 0 ? v : null;
const reviewStates = ['pending', 'running', 'completed', 'failed', 'timeout', 'unavailable'];
function review(value) {
    if (!value || typeof value !== 'object') return null;
    return { reviewStatus: reviewStates.includes(value.reviewStatus) ? value.reviewStatus : 'unavailable',
        verdict: ['支持', '不支持', '证据不足'].includes(value.verdict) ? value.verdict : null,
        text: text(value.text, 2000), limitations: text(value.limitations, 1000),
        frameAt: time(value.frameAt), reviewedAt: time(value.reviewedAt), errorCode: text(value.errorCode, 100), modelVersion: text(value.modelVersion, 128) };
}

function snapshotQuery(filters, scene, from, to) {
    const query = { scene, from, to: to - 1 };
    for (const key of ['eventId', 'source', 'kind', 'camera', 'reviewStatus', 'verdict', 'acknowledged']) {
        if (filters[key] != null && filters[key] !== '') query[key] = filters[key];
    }
    return query;
}
async function collectSceneEvidence(runtime, permission, sceneId, from, to, now, filters = {}, snapshot = null) {
    const target = SCENE_TARGETS.find(s => s.id === sceneId);
    const missing = [], health = [];
    const fail = (code, message) => missing.push({ code, message, remediation: '检查所选场景、时间窗及持久事件证据后刷新' });
    const warn = (code, message) => health.push({ code, message });
    const result = { target, state: null, patrol: null, events: [], count: 0, limit: 30, health, missing };
    if (!target) { fail('invalid_scene', '未知场景'); return result; }
    const admin = !runtime.settings?.secureEnabled || [-1, 255].includes(permission) || permission?.groups === 255;
    if (!admin) { fail('video_permission', '八场景汇总需要平台管理员权限'); return result; }
    const store = runtime.cameraScenes;
    if (!store) { fail('scene_unavailable', '八场景事件服务未就绪'); return result; }
    // Current source health is context, not a prerequisite for reading durable historical events.
    try {
        const status = store.status();
        const source = status[target.source];
        const state = source?.scenes?.find(s => s.sceneId === sceneId);
        if (state) result.state = { sceneId, source: target.source, camera: text(source.camera, 128),
            updatedAt: time(source.updatedAt), status: text(state.status, 100), detail: text(state.detail),
            calibrationVersion: text(source.appliedCalibrationVersion, 128), calibrationError: text(source.calibrationError, 128) };
        const patrol = status.reviews?.byScene?.[sceneId];
        if (patrol && !patrol.eventId && patrol.sceneId === sceneId && patrol.camera === source?.camera && patrol.source === target.source) result.patrol = review(patrol);
        if (!state || !time(source.updatedAt) || now - source.updatedAt > 8000 || source.updatedAt > now + 1000 || source.streamKind !== target.source) warn('scene_stale', '当前检测状态缺失、源不匹配或超过8秒未更新');
        if (sceneId === 'V1' && (!source?.entryGate?.enabled || !source?.entryGate?.verified || !source.appliedCalibrationVersion || source.appliedCalibrationVersion !== source.entryGate.calibrationVersion || source.calibrationError)) warn('door_calibration_required', '当前门口实际标定未应用，不能生成新的进入记录');
    } catch (_) { warn('scene_status_failed', '当前检测状态读取失败，历史账本单独读取'); }
    try {
        // One ledger SELECT anchors detail, count, grouping and trend to the same snapshot.
        const data = snapshot || await store.exportEvents(snapshotQuery(filters, sceneId, from, to));
        const rows = data.rows.filter(row => row.sceneId === sceneId), sample = rows.slice(0, 30);
        result.count = rows.length;
        result.snapshotAt = data.generatedAt;
        result.summary = { count: rows.length, groups: data.groups.filter(g => g.sceneId === sceneId),
            trend: data.trend.filter(g => g.sceneId === sceneId), window: data.window,
            timezone: data.timezone, generatedAt: data.generatedAt };
        result.sample = { returned: sample.length, total: rows.length, truncated: rows.length > sample.length, order: 'at_desc_eventId_desc' };
        for (const row of sample) {
            if (row.sceneId !== sceneId || !row.camera || row.source && row.source !== target.source || !time(row.at) || row.at < from || row.at >= to) {
                fail('scene_source_mismatch', '历史事件的场景、视频源或时间与所选目标不一致'); continue;
            }
            if (sceneId === 'V1' && (!row.calibrationVersion || row.calibrationVersion === 'none')) fail('event_calibration_missing', '历史进入事件缺少有效标定版本，仅保留候选记录');
            result.events.push({ eventId: text(row.eventId, 32), sceneId, sceneName: target.name, source: target.source,
                sourceBinding: row.source ? 'recorded' : 'legacy_scene_mapping', camera: text(row.camera, 128), at: row.at, kind: text(row.kind, 100), label: text(row.label, 200),
                trackId: text(row.trackId, 128), calibrationVersion: text(row.calibrationVersion, 128),
                reviewStatus: reviewStates.includes(row.reviewStatus) ? row.reviewStatus : 'unavailable', review: review(row.review),
                evidenceFrames: (row.evidenceFrames || []).slice(0, 3).map(f => ({ at: time(f.at) })), ackAt: time(row.ackAt), ackBy: text(row.ackBy, 128) });
        }
        if (!result.events.length) fail('scene_events_missing', '所选场景在该时间窗没有可用事件记录；巡视结果不能代替事件');
    } catch (_) { fail('scene_read_failed', '本场景历史事件读取失败'); }
    return result;
}
async function collectSceneOverview(runtime, permission, from, to, now, filters = {}) {
    const selected = filters.sceneIds == null ? SCENE_TARGETS.map(s => s.id) : filters.sceneIds;
    if (!Array.isArray(selected) || !selected.length || selected.some(id => !SCENE_TARGETS.some(s => s.id === id))) {
        return { target: { id: 'all', name: '八场景综合', source: 'visible / thermal' }, events: [], count: 0,
            missing: [{ code: 'invalid_scene', message: '场景筛选无效', remediation: '重新选择八场景' }] };
    }
    let snapshot = null;
    const admin = !runtime.settings?.secureEnabled || [-1, 255].includes(permission) || permission?.groups === 255;
    if (admin && runtime.cameraScenes) {
        try { snapshot = await runtime.cameraScenes.exportEvents(snapshotQuery(filters, [...new Set(selected)], from, to)); }
        catch (_) { return { target: { id: 'all', name: '八场景综合', source: 'visible / thermal' }, events: [], count: 0,
            missing: [{ code: 'scene_read_failed', message: '综合历史快照读取失败或超过100000条，请缩小窗口', remediation: '检查账本及筛选窗口' }] }; }
    }
    const parts = await Promise.all([...new Set(selected)].map(id => collectSceneEvidence(runtime, permission, id, from, to, now, filters, snapshot)));
    const events = parts.flatMap(p => p.events).sort((a,b) => b.at-a.at || b.eventId.localeCompare(a.eventId)).slice(0, 30);
    const count = parts.reduce((n,p) => n+p.count,0);
    return { target: { id: 'all', name: '八场景综合', source: 'visible / thermal' }, events, count, snapshotAt: snapshot?.generatedAt,
        sample: { returned: events.length, total: count, truncated: count > events.length, order: 'at_desc_eventId_desc' },
        summary: { count, groups: parts.flatMap(p => p.summary?.groups || []), trend: parts.flatMap(p => p.summary?.trend || []),
            window: { from, to, interval: '[from,to)' }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        scenes: parts.map(p => ({ target: p.target, count: p.count, state: p.state, health: p.health })),
        missing: parts.flatMap(p => p.missing.filter(m => m.code !== 'scene_events_missing')),
        health: parts.flatMap(p => p.health || []) };
}
module.exports = { SCENE_TARGETS, collectSceneEvidence, collectSceneOverview };
