'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const analysis = require('../../api/analysis');

function fixture(imagesFileDir) {
    const project = {
        devices: {
            dev1: {
                id: 'dev1', name: 'PLC-1', type: 'opcua', tags: {
                    tag1: { id: 'tag1', name: '压力', unit: 'kPa', type: 'real' },
                    hidden: { id: 'hidden', name: '隐藏', hidden: true, unit: 'kPa', type: 'real' }
                }
            }
        },
        mes: [{ id: 'mes-1', name: '工序', tagId: 'tag1' }],
        ems: [{ id: 'ems-1', name: '电表', unit: 'kWh', tagId: 'tag1' }],
        recipes: [{ id: 'recipe-1', name: '配方', entries: [{ tagId: 'tag1' }] }],
        reports: [{ id: 'report-1', name: '报表', tagIds: ['tag1'] }],
        scripts: [{ id: 'script-1', name: '脚本元信息', mode: 'SERVER', code: 'secret-code', tagId: 'tag1' }]
    };
    const runtime = {
        settings: { secureEnabled: false, imagesFileDir, calibration: { enabled: true } },
        checkPermission: (_permission, item) => item && item.hidden ? { show: false, enabled: false } : { show: true, enabled: true },
        project: { getProject: async () => project },
        devices: {
            getTagValue: async id => ({ id, value: 42, quality: 'good', timestamp: Date.now() - 1 }),
            getDevicesStatus: async () => ({ dev1: 'connected' })
        },
        daqStorage: {
            querySeries: async ids => ({ status: Object.fromEntries(ids.map(id => [id, 'ok'])), series: Object.fromEntries(ids.map(id => [id, [{ t: Date.now() - 1000, v: 1 }, { t: Date.now() - 500, v: 2 }]])), gaps: {} })
        },
        alarmsMgr: {
            getAllAlarmsValues: async () => [{ name: 'A1', status: 1, text: '高压' }],
            getAlarmsHistory: async () => [{ name: 'A1', status: 1, ontime: Date.now() - 1000 }]
        },
        calibrationService: { getProfiles: async () => [{ id: 'cal-1', name: '标定', sourceTagId: 'tag1', model: 'linear' }] },
        schedulerStorage: { getAllSchedulers: async () => [{ id: 'scheduler-1', data: { settings: { enabled: true } } }] },
        scriptsMgr: { isAuthorised: () => true }
    };
    return runtime;
}

function writeVideoEvidence(dir) {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'ai-tracks.json'), JSON.stringify({ camera: 'cam-1', updatedAt: now, detections: [] }));
    fs.writeFileSync(path.join(dir, 'ai-counts.json'), JSON.stringify({ today: 'today', byKind: { VMD: 2 }, total: { VMD: 2 }, updatedAt: now }));
    fs.writeFileSync(path.join(dir, 'ai-captions.json'), JSON.stringify({ updatedAt: now, captions: [] }));
}

describe('AI analysis evidence gate', function () {
    let tempDir;
    let oldKey;
    let oldBase;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-analysis-'));
        writeVideoEvidence(tempDir);
        oldKey = process.env.DEEPSEEK_API_KEY;
        oldBase = process.env.DEEPSEEK_BASE_URL;
        delete process.env.DEEPSEEK_API_KEY;
        delete process.env.DEEPSEEK_BASE_URL;
        analysis.init(fixture(tempDir), () => {}, () => -1);
    });
    afterEach(function () {
        if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
        if (oldBase === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = oldBase;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('publishes a closed module and intent whitelist', function () {
        const ids = analysis.MODULES.map(m => m.id);
        assert.deepEqual(ids, ['scada', 'mes', 'ems', 'video', 'alarms', 'recipes', 'schedules', 'reports', 'calibration', 'devices', 'platform']);
        for (const module of analysis.MODULES) assert(module.intents.length > 0);
    });

    it('returns evidence_insufficient for unknown targets without touching the model', async function () {
        const original = https.request;
        https.request = () => { throw new Error('DeepSeek must not be called'); };
        try {
            const result = await analysis._ask({ userId: 'u1' }, { module: 'scada', intent: 'free_form', question: '任意问题' });
            assert.equal(result.status, 'evidence_insufficient');
            assert(result.evidenceQuality.missing.some(x => x.code === 'invalid_target'));
        } finally { https.request = original; }
    });

    it('returns evidence_insufficient for a hidden or unknown tag before reading it', async function () {
        let reads = 0;
        const runtime = fixture(tempDir);
        runtime.devices.getTagValue = async () => { reads++; return null; };
        analysis.init(runtime, () => {}, () => -1);
        const result = await analysis._ask({ userId: 'u1' }, { module: 'scada', intent: 'current_anomalies', tagIds: ['hidden'], from: Date.now() - 1000, to: Date.now(), question: '检查异常' });
        assert.equal(result.status, 'evidence_insufficient');
        assert.equal(reads, 0);
        assert(result.evidenceQuality.missing.some(x => x.code === 'tags_unavailable'));
    });

    it('has one sufficient evidence path for every supported module', async function () {
        const cases = [
            ['scada', 'current_anomalies'], ['mes', 'configuration_review'], ['ems', 'metering_integrity'],
            ['video', 'detection_freshness'], ['alarms', 'current_alarms'], ['recipes', 'definition_review'],
            ['schedules', 'definition_review'], ['reports', 'definition_review'], ['calibration', 'definition_review'],
            ['devices', 'connection_status'], ['platform', 'runtime_status']
        ];
        for (const [module, intent] of cases) {
            const result = await analysis._context({ userId: 'u1' }, { module, intent, tagIds: ['tag1'], from: Date.now() - 3600000, to: Date.now() });
            assert.equal(result.status, 'ready', module + '/' + intent + ': ' + JSON.stringify(result.evidenceQuality.missing));
            assert(result.evidenceIds.length > 0, module + '/' + intent);
        }
    });

    it('has an evidence-insufficient path for every supported module', async function () {
        for (const module of analysis.MODULES) {
            const target = module.intents[0];
            const result = await analysis._context({ userId: 'u1' }, { module: module.id, intent: target.id, from: 10, to: 5 });
            assert.equal(result.status, 'evidence_insufficient', module.id);
            assert(result.evidenceQuality.missing.some(x => x.code === 'invalid_window'), module.id);
        }
    });

    it('does not call DeepSeek when history is missing, and calls it for sufficient evidence', async function () {
        let calls = 0;
        const original = https.request;
        https.request = (_options, callback) => {
            calls++;
            const req = new EventEmitter();
            req.end = () => {
                const response = new EventEmitter();
                response.statusCode = 200;
                response.setEncoding = () => {};
                callback(response);
                response.emit('data', JSON.stringify({ choices: [{ message: { content: '基于证据的回答' } }] }));
                response.emit('end');
            };
            return req;
        };
        process.env.DEEPSEEK_API_KEY = 'test-key';
        const runtime = fixture(tempDir);
        runtime.daqStorage.querySeries = async ids => ({ status: Object.fromEntries(ids.map(id => [id, 'no-data'])), series: Object.fromEntries(ids.map(id => [id, []])), gaps: {} });
        analysis.init(runtime, () => {}, () => -1);
        try {
            const insufficient = await analysis._ask({ userId: 'u1' }, { module: 'scada', intent: 'history_trend', tagIds: ['tag1'], from: Date.now() - 3600000, to: Date.now(), question: '看趋势' });
            assert.equal(insufficient.status, 'evidence_insufficient');
            assert.equal(calls, 0);
            const sufficient = await analysis._ask({ userId: 'u1' }, { module: 'scada', intent: 'current_anomalies', tagIds: ['tag1'], from: Date.now() - 3600000, to: Date.now(), question: '看当前异常' });
            assert.equal(sufficient.status, 'ok');
            assert.equal(calls, 1);
            assert.equal(sufficient.module, 'scada');
            assert.equal(sufficient.intent, 'current_anomalies');
        } finally { https.request = original; }
    });

    it('accepts production tracker timestamps when the top-level timestamp is absent', async function () {
        fs.writeFileSync(path.join(tempDir, 'ai-tracks.json'), JSON.stringify({ camera: 'cam-1', detections: [{ timestamp: Date.now(), label: 'person' }] }));
        const result = await analysis._context({ userId: 'u1' }, { module: 'video', intent: 'detection_freshness', from: Date.now() - 3600000, to: Date.now() });
        assert.equal(result.status, 'ready');
    });

    it('rejects stale, empty or cleared video count evidence', async function () {
        fs.writeFileSync(path.join(tempDir, 'ai-counts.json'), JSON.stringify({ today: 'today', byKind: {}, total: {}, updatedAt: Date.now(), clearedAt: Date.now() }));
        const result = await analysis._context({ userId: 'u1' }, { module: 'video', intent: 'event_counts', from: Date.now() - 3600000, to: Date.now() });
        assert.equal(result.status, 'evidence_insufficient');
        assert(result.evidenceQuality.missing.some(x => x.code === 'video_missing_or_stale'));
    });

    it('marks stale video evidence insufficient instead of saying there is no anomaly', async function () {
        fs.writeFileSync(path.join(tempDir, 'ai-tracks.json'), JSON.stringify({ updatedAt: Date.now() - 60000, detections: [] }));
        const result = await analysis._context({ userId: 'u1' }, { module: 'video', intent: 'detection_freshness', from: Date.now() - 3600000, to: Date.now() });
        assert.equal(result.status, 'evidence_insufficient');
        assert(result.evidenceQuality.missing.some(x => x.code === 'video_missing_or_stale'));
    });
});
