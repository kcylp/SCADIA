'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bad = message => Object.assign(new Error(message), { code: 'INVALID_MODEL_CONFIG' });
const DEFAULT_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

class ModelConfig {
    constructor(workDir) { this.file = workDir ? path.join(workDir, 'analysis-model.json') : null; }
    read() {
        let saved = {};
        if (this.file) {
            try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
            catch (e) { if (e.code !== 'ENOENT') { throw bad('模型配置文件无法读取，请管理员检查'); } }
        }
        return { baseUrl: saved.baseUrl || process.env.DEEPSEEK_BASE_URL || DEFAULT_URL,
            model: saved.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
            apiKey: Object.hasOwn(saved, 'apiKey') ? saved.apiKey : process.env.DEEPSEEK_API_KEY || '',
            updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null };
    }
    status() {
        const c = this.read();
        return { configured: !!c.apiKey, baseUrl: c.baseUrl, model: c.model,
            keyConfigured: !!c.apiKey, updatedAt: c.updatedAt, updatedBy: c.updatedBy };
    }
    save(body, actor) {
        if (!this.file) { throw bad('工程工作目录未配置'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['baseUrl','model','apiKey','clearKey'].includes(k))) { throw bad('模型配置字段不合法'); }
        const current = this.read();
        const baseUrl = body.baseUrl === undefined ? current.baseUrl : body.baseUrl;
        const model = body.model === undefined ? current.model : body.model;
        let url;
        try { url = new URL(baseUrl); } catch (_) { throw bad('服务地址不合法'); }
        // Credentials are sent only to the supported provider, including when following a saved configuration.
        if (url.origin !== DEFAULT_URL || url.username || url.password || url.search || url.hash || !['/','/v1','/v1/'].includes(url.pathname)) { throw bad('当前仅支持 https://api.deepseek.com 或 /v1'); }
        if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model)) { throw bad('模型名称不合法'); }
        if (body.clearKey !== undefined && typeof body.clearKey !== 'boolean') { throw bad('清除密钥选项不合法'); }
        if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 1024 || /[\r\n\x00]/.test(body.apiKey))) { throw bad('密钥格式不合法'); }
        const key = body.apiKey?.trim();
        if (body.clearKey && key) { throw bad('不能同时保存和清除密钥'); }
        const value = { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey: body.clearKey ? '' : key || current.apiKey,
            updatedAt: Date.now(), updatedBy: actor || 'unknown' };
        const temp = this.file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
        try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, this.file); }
        finally { if (fs.existsSync(temp)) { fs.unlinkSync(temp); } }
        return this.status();
    }
}
module.exports = { ModelConfig };
