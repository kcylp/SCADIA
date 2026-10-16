'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const ids = { visible: ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7'], thermal: ['T1'] };
const bad = message => Object.assign(new Error(message), { code: 'AI_BAD_PAYLOAD' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function normalize(source, scenes) {
    if (!ids[source] || !object(scenes) || Object.keys(scenes).length !== ids[source].length ||
        Object.keys(scenes).some(id => !ids[source].includes(id))) { throw bad('规则必须完整对应当前视频源的场景'); }
    const result = {};
    for (const id of ids[source]) {
        const rule = scenes[id], allowed = ['enabled', ...(id === 'V5' ? ['count'] : id === 'V6' ? ['seconds'] : [])];
        if (!object(rule) || typeof rule.enabled !== 'boolean' || Object.keys(rule).some(key => !allowed.includes(key))) {
            throw bad('场景 ' + id + ' 规则字段无效');
        }
        result[id] = { enabled: rule.enabled };
        if (id === 'V5' || id === 'V6') {
            const key = id === 'V5' ? 'count' : 'seconds', min = id === 'V5' ? 2 : 1, max = id === 'V5' ? 100 : 3600;
            if (!Number.isInteger(rule[key]) || rule[key] < min || rule[key] > max) { throw bad(id + ' 阈值需为 ' + min + '–' + max + ' 的整数'); }
            result[id][key] = rule[key];
        }
    }
    return result;
}
class SceneRules {
    constructor(workDir) { this.workDir = workDir; }
    file(source) {
        if (!ids[source]) { throw bad('无效视频源'); }
        return path.join(this.workDir, source === 'thermal' ? 'ai-tracker-thermal.json' : 'ai-tracker.json');
    }
    config(source) {
        const cfg = JSON.parse(fs.readFileSync(this.file(source), 'utf8'));
        if ((cfg.streamKind === 'thermal' ? 'thermal' : 'visible') !== source) { throw bad('规则文件与视频源不匹配'); }
        return cfg;
    }
    read(source) {
        const cfg = this.config(source), scenes = {};
        for (const id of ids[source]) {
            const rule = cfg.scenes?.[id] || {};
            scenes[id] = { enabled: rule.enabled !== false };
            if (id === 'V5') { scenes[id].count = rule.count ?? 4; }
            if (id === 'V6') { scenes[id].seconds = rule.seconds ?? 30; }
        }
        return { source, version: cfg.rulesVersion || 'none', scenes: normalize(source, scenes) };
    }
    save(source, body, user) {
        const scenes = normalize(source, body?.scenes), cfg = this.config(source);
        if (body.version !== (cfg.rulesVersion || 'none')) {
            throw Object.assign(new Error('规则已被其他操作更新，请重新读取后编辑'), { code: 'AI_RULES_CONFLICT' });
        }
        cfg.scenes = { ...cfg.scenes };
        for (const [id, rule] of Object.entries(scenes)) { cfg.scenes[id] = { ...cfg.scenes[id], ...rule }; }
        cfg.rulesVersion = randomUUID(); cfg.rulesUpdatedAt = Date.now(); cfg.rulesUpdatedBy = user;
        const file = this.file(source), tmp = file + '.' + randomUUID() + '.tmp';
        try { fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, file); }
        finally { if (fs.existsSync(tmp)) { fs.unlinkSync(tmp); } }
        return this.read(source);
    }
}
module.exports = { SceneRules, normalize };
