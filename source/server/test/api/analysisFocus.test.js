'use strict';

/**
 * 变更项 A：统一 AI 分析页只呈现八种算法（V1–V7 + T1）。
 *
 * 这里守住两条：
 *   1. 下发列表只含 video 模块的 10 个目标（八场景综合 / 单事件 / V1–V7 / T1）；
 *   2. 直接请求被隐藏的 module/intent 会被拒，而不是绕开前端继续算。
 * 开关（settings.analysisFocus='full'）必须能回到旧行为，否则无法回滚。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const analysis = require('../../api/analysis');
const { MODULES, modulesFor, allows } = require('../../api/analysis/evidence');
const { SCENE_TARGETS } = require('../../api/analysis/scene-evidence');

const EXPECTED = ['all_scenes', 'scene_event', ...SCENE_TARGETS.map(s => s.id)];

describe('Analysis focus: eight scene algorithms only', () => {
    let dir, server, base;
    const runtime = () => ({ settings: { workDir: dir, analysisFocus: process.env.SCADIA_ANALYSIS_FOCUS }, project: {} });

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-focus-'));
        analysis.init({ settings: { workDir: dir }, project: {} }, (_req, _res, next) => next(), () => -1);
        server = analysis.app().listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        base = 'http://127.0.0.1:' + server.address().port;
    });
    after(async () => {
        await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.SCADIA_ANALYSIS_FOCUS;
    });

    it('keeps the full module table for internal callers (nothing was deleted)', () => {
        assert(MODULES.length >= 11);
        assert(MODULES.some(m => m.id === 'platform'));
    });

    it('exposes only the video module with exactly the eight algorithms plus overview/event', () => {
        const modules = modulesFor(runtime());
        assert.equal(modules.length, 1);
        assert.equal(modules[0].id, 'video');
        assert.deepEqual(modules[0].intents.map(i => i.id), EXPECTED);
        assert(!modules[0].intents.some(i => i.id === 'detection_freshness' || i.id === 'event_counts'));
    });

    it('serves the focused list from /api/analysis/modules', async () => {
        const res = await fetch(base + '/api/analysis/modules');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.modules.map(m => m.id), ['video']);
        assert.deepEqual(body.modules[0].intents.map(i => i.id), EXPECTED);
    });

    it('rejects a hidden module or intent at the server boundary', async () => {
        for (const body of [
            { module: 'scada', intent: 'current_anomalies' },
            { module: 'video', intent: 'detection_freshness' },
            { module: 'alarms', intent: 'current_alarms' }
        ]) {
            const res = await fetch(base + '/api/analysis/context', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            assert.equal(res.status, 200);
            const result = await res.json();
            assert.equal(result.status, 'evidence_insufficient');
            assert(result.evidenceQuality.missing.some(m => m.code === 'target_not_allowed'), JSON.stringify(result.evidenceQuality));
            assert.deepEqual(result.evidence, []);
        }
    });

    it('allows every exposed scene target', () => {
        for (const id of EXPECTED) assert(allows(runtime(), 'video', id), id);
        assert.equal(allows(runtime(), 'video', 'tracks'), false);
        assert.equal(allows(runtime(), 'platform', 'runtime_status'), false);
    });

    it("restores the full table when the switch is 'full'", () => {
        process.env.SCADIA_ANALYSIS_FOCUS = 'full';
        try {
            assert.deepEqual(modulesFor(runtime()).map(m => m.id), MODULES.map(m => m.id));
            assert(allows(runtime(), 'platform', 'runtime_status'));
        } finally {
            delete process.env.SCADIA_ANALYSIS_FOCUS;
        }
    });
});
