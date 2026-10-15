'use strict';

const express = require('express');
const https = require('https');
const { MODULES, collect } = require('./evidence');
const { ModelConfig } = require('./model-config');
const jwt = require('jsonwebtoken');
const authJwt = require('../jwt-helper');
let modelConfig;

const MAX_QUESTION = 4000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_BYTES = 512 * 1024;
let runtime;
let secure;
let groups;
let activeRequests = 0;

function init(_runtime, _secure, _groups) {
    runtime = _runtime;
    secure = _secure;
    groups = _groups;
    modelConfig = new ModelConfig(runtime.settings.workDir);
}
function fail(res, status, code, message) {
    return res.status(status).json({ error: code, message });
}
function safeText(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}
function permission(req) {
    return groups ? groups(req) : null;
}
function isTargetBody(body) {
    return body && typeof body.module === 'string' && typeof body.intent === 'string';
}
function insufficient(result, configured) {
    return {
        configured,
        status: 'evidence_insufficient',
        module: result.module,
        intent: result.intent,
        evidenceIds: result.evidenceIds,
        generatedAt: result.generatedAt,
        evidenceQuality: result.evidenceQuality,
        limitations: result.limitations,
        analysisGoal: result.analysisGoal,
        window: result.window,
        tags: result.tags,
        selectedTagIds: result.selectedTagIds,
        evidence: result.evidence
    };
}
function requireAdmin(req, res, next) {
    const token = req.headers['x-access-token'];
    if (!token) return fail(res, 401, 'login_required', '请先登录管理员账号');
    try {
        const decoded = jwt.verify(token, authJwt.secretCode, { algorithms: ['HS256'] });
        const user = runtime.users?.getUserCache(decoded.id);
        if (decoded.type === 'refresh' || !user || !authJwt.haveAdminPermission(user.groups)) return fail(res, 403, 'admin_required', '仅管理员可配置和测试模型');
        req.modelActor = decoded.id;
        next();
    } catch (_) { fail(res, 401, 'login_required', '会话已失效，请重新登录'); }
}
function requestJson(url, body, timeoutMs, apiKey) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (_) { reject(new Error('invalid_endpoint')); return; }
        if (parsed.protocol !== 'https:') { reject(new Error('DeepSeek endpoint must use HTTPS')); return; }
        const payload = JSON.stringify(body);
        const request = https.request({
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: timeoutMs
        }, response => {
            let raw = '';
            let size = 0;
            response.setEncoding('utf8');
            response.on('data', chunk => {
                size += Buffer.byteLength(chunk);
                if (size <= MAX_UPSTREAM_BYTES) raw += chunk;
                else response.destroy(new Error('upstream_response_too_large'));
            });
            response.on('end', () => {
                if (size > MAX_UPSTREAM_BYTES) return reject(new Error('upstream_response_too_large'));
                try {
                    const data = JSON.parse(raw);
                    if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('upstream_' + response.statusCode));
                    resolve(data);
                } catch (_) { reject(new Error('invalid_upstream_response')); }
            });
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('upstream_timeout')));
        request.on('error', reject);
        request.end(payload);
    });
}
async function buildEvidence(req, body) {
    if (!isTargetBody(body)) {
        return { module: null, intent: null, evidenceIds: [], generatedAt: Date.now(), evidence: [], limitations: [], evidenceQuality: { sufficient: false, missing: [{ code: 'target_required', message: 'module and intent are required', remediation: 'Choose a module and intent from /api/analysis/modules' }] } };
    }
    return collect(runtime, req, body, permission(req));
}
async function ask(req, body) {
    const evidence = await buildEvidence(req, body);
    const config = modelConfig.read();
    const configured = !!config.apiKey;
    if (!evidence.evidenceQuality.sufficient) return insufficient(evidence, configured);
    if (!configured) return { configured: false, status: 'not_configured', module: evidence.module, intent: evidence.intent, evidenceIds: evidence.evidenceIds, generatedAt: evidence.generatedAt, evidenceQuality: evidence.evidenceQuality, evidence: evidence.evidence };
    if (activeRequests >= 2) return { configured: true, status: 'busy', module: evidence.module, intent: evidence.intent, evidenceIds: evidence.evidenceIds };
    const question = safeText(body.question, MAX_QUESTION).trim();
    activeRequests++;
    const started = Date.now();
    try {
        const base = config.baseUrl.replace(/\/$/, '') + '/chat/completions';
        const model = config.model;
        const analysisGoal = evidence.analysisGoal;
        const answer = await requestJson(base, {
            model,
            temperature: 0.1,
            messages: [
                { role: 'system', content: '你是 SCADIA 工业平台分析助手。只基于结构化证据回答，按事实/异常/可能原因/需要补证/建议人工动作组织；明确区分实时、历史、配置、陈旧、缺失和推测。不得执行控制、写设备、修改报警、执行脚本或补造数值。' },
                { role: 'user', content: JSON.stringify({ analysisGoal, module: evidence.module, intent: evidence.intent, question, evidence: evidence.evidence, evidenceQuality: evidence.evidenceQuality, limitations: evidence.limitations }) }
            ]
        }, 20000, config.apiKey);
        const text = answer?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) return { configured: true, status: 'empty_upstream_response', module: evidence.module, intent: evidence.intent, evidenceIds: evidence.evidenceIds, elapsedMs: Date.now() - started };
        return { configured: true, status: 'ok', model, elapsedMs: Date.now() - started, module: evidence.module, intent: evidence.intent, evidenceIds: evidence.evidenceIds, generatedAt: evidence.generatedAt, evidenceQuality: evidence.evidenceQuality, answer: text, evidence: evidence.evidence, limitations: evidence.limitations };
    } catch (err) {
        return { configured: true, status: 'upstream_error', module: evidence.module, intent: evidence.intent, evidenceIds: evidence.evidenceIds, message: err.message === 'upstream_timeout' ? 'DeepSeek request timed out' : 'DeepSeek request failed' };
    } finally {
        activeRequests--;
    }
}
function app() {
    const analysisApp = express();
    analysisApp.get('/api/analysis/modules', secure, (_req, res) => res.json({ modules: MODULES }));
    analysisApp.get('/api/analysis/status', secure, (_req, res) => {
        try { const s = modelConfig.status(); res.json({ configured: s.configured, model: s.model, activeRequests }); }
        catch (_) { fail(res, 503, 'model_config_unavailable', '模型配置暂不可用'); }
    });
    analysisApp.get('/api/analysis/config', secure, requireAdmin, (_req, res) => {
        try { res.json(modelConfig.status()); } catch (_) { fail(res, 503, 'model_config_unavailable', '模型配置暂不可用'); }
    });
    analysisApp.post('/api/analysis/config', secure, requireAdmin, express.json({ limit: 4096 }), (req, res) => {
        try { const s = modelConfig.save(req.body, req.modelActor); runtime.logger?.info('analysis model configuration updated by ' + req.modelActor); res.json(s); }
        catch (e) { fail(res, e.code === 'INVALID_MODEL_CONFIG' ? 400 : 500, 'model_config_save_failed', e.code === 'INVALID_MODEL_CONFIG' ? e.message : '模型配置保存失败'); }
    });
    analysisApp.post('/api/analysis/context', secure, express.json({ limit: MAX_BODY_BYTES }), async (req, res) => {
        try {
            const result = await buildEvidence(req, req.body || {});
            res.json(result.evidenceQuality.sufficient ? result : insufficient(result, modelConfig.status().configured));
        } catch (_) { fail(res, 500, 'analysis_context_failed', 'Unable to collect analysis evidence'); }
    });
    analysisApp.post('/api/analysis/chat', secure, express.json({ limit: MAX_BODY_BYTES }), async (req, res) => {
        try { res.json(await ask(req, req.body || {})); } catch (_) { fail(res, 500, 'analysis_failed', 'Unable to run analysis'); }
    });
    analysisApp.post('/api/analysis/test', secure, requireAdmin, async (req, res) => {
        try { res.json(await ask(req, { module: 'platform', intent: 'runtime_status', question: '请报告模型连接状态，并严格说明没有提供的事实。' })); } catch (_) { fail(res, 500, 'analysis_test_failed', 'Unable to test analysis model'); }
    });
    return analysisApp;
}
module.exports = { init, app, _context: buildEvidence, _ask: ask, MODULES };
