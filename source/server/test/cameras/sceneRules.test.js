'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { SceneRules, normalize } = require('../../runtime/cameras/scene-rules');
const cameras = require('../../api/cameras');

describe('Scene rules validation and persistence', function () {
    this.timeout(12000);
    let dir;
    const baseScenes = enabled => ({ V1: { enabled }, V2: { enabled }, V3: { enabled }, V4: { enabled },
        V5: { enabled, count: 4 }, V6: { enabled, seconds: 30 }, V7: { enabled } });
    const thermalScenes = enabled => ({ T1: { enabled } });
    const writeCfg = (file, cfg) => fs.writeFileSync(path.join(dir, file), JSON.stringify(cfg, null, 2));

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-scene-rules-'));
        writeCfg('ai-tracker.json', { streamKind: 'visible', cameraId: 'cam-1', source: { rtsp: 'rtsp://secret@cam' }, scenes: {} });
        writeCfg('ai-tracker-thermal.json', { streamKind: 'thermal', cameraId: 'cam-2', source: { rtsp: 'rtsp://secret@thermal' }, scenes: {} });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('requires every scene of the matching source and rejects foreign or extra fields', () => {
        assert.deepEqual(Object.keys(normalize('visible', baseScenes(true))), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7']);
        assert.deepEqual(Object.keys(normalize('thermal', thermalScenes(true))), ['T1']);
        for (const body of [
            () => normalize('visible', { ...baseScenes(true), T1: { enabled: true } }),
            () => normalize('visible', { ...baseScenes(true), V9: { enabled: true } }),
            () => normalize('thermal', { ...thermalScenes(true), V1: { enabled: true } }),
            () => normalize('thermal', {}),
            () => normalize('invalid', baseScenes(true)),
            () => normalize('visible', null),
        ]) { assert.throws(body, /无效|必须完整|无效视频源/); }
    });

    it('validates enabled flags and the V5/V6 thresholds like the worker does', () => {
        for (const scenes of [
            { ...baseScenes(true), V4: { enabled: 'yes' } },
            { ...baseScenes(true), V5: { enabled: true, count: 1 } },
            { ...baseScenes(true), V5: { enabled: true, count: 101 } },
            { ...baseScenes(true), V5: { enabled: true, count: 4.5 } },
            { ...baseScenes(true), V6: { enabled: true, seconds: 0 } },
            { ...baseScenes(true), V6: { enabled: true, seconds: 3601 } },
            { ...baseScenes(true), V4: { enabled: true, extra: 1 } },
        ]) { assert.throws(() => normalize('visible', scenes), /无效|阈值/); }
        assert.equal(normalize('visible', baseScenes(true)).V5.count, 4);
        assert.equal(normalize('visible', baseScenes(true)).V6.seconds, 30);
        assert.equal(normalize('visible', { ...baseScenes(false), V5: { enabled: false, count: 100 }, V6: { enabled: false, seconds: 3600 } }).V5.count, 100);
    });

    it('reads defaults and rejects a rules file that does not match its source', () => {
        const rules = new SceneRules(dir);
        const visible = rules.read('visible');
        assert.equal(visible.version, 'none');
        assert.deepEqual(visible.scenes.V5, { enabled: true, count: 4 });
        assert.deepEqual(visible.scenes.V6, { enabled: true, seconds: 30 });
        writeCfg('ai-tracker.json', { streamKind: 'visible', scenes: { V5: { enabled: false, count: 6 }, V6: { enabled: false, seconds: 45 } }, rulesVersion: 'r-1' });
        const changed = rules.read('visible');
        assert.equal(changed.version, 'r-1');
        assert.deepEqual(changed.scenes.V5, { enabled: false, count: 6 });
        writeCfg('ai-tracker-thermal.json', { streamKind: 'visible', scenes: {} });
        assert.throws(() => rules.read('thermal'), /不匹配/);
        assert.throws(() => rules.file('invalid'), /无效视频源/);
    });

    it('saves atomically with a new version while keeping credentials and unrelated fields', () => {
        const rules = new SceneRules(dir);
        const saved = rules.save('visible', { version: 'none', scenes: baseScenes(true) }, 'admin-1');
        assert.match(saved.version, /^[0-9a-f-]{36}$/);
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'ai-tracker.json'), 'utf8'));
        assert.equal(cfg.cameraId, 'cam-1');
        assert.equal(cfg.source.rtsp, 'rtsp://secret@cam');
        assert.equal(cfg.rulesUpdatedBy, 'admin-1');
        assert.equal(cfg.scenes.V5.count, 4);
        assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0);
        assert.deepEqual(rules.read('visible').scenes, saved.scenes);
    });

    it('rejects a stale write and an invalid payload without touching the file', () => {
        const rules = new SceneRules(dir);
        rules.save('visible', { version: 'none', scenes: baseScenes(true) }, 'admin-1');
        const before = fs.readFileSync(path.join(dir, 'ai-tracker.json'), 'utf8');
        assert.throws(() => rules.save('visible', { version: 'none', scenes: baseScenes(true) }, 'admin-2'), /已被其他操作更新/);
        assert.throws(() => rules.save('visible', { version: 'stale', scenes: baseScenes(true) }, 'admin-2'), /已被其他操作更新/);
        assert.throws(() => rules.save('visible', { version: rules.read('visible').version, scenes: { ...baseScenes(true), V5: { enabled: true, count: 999 } } }, 'admin-2'), /无效|阈值/);
        assert.equal(fs.readFileSync(path.join(dir, 'ai-tracker.json'), 'utf8'), before);
    });

    it('never writes visible scene rules into the thermal tracker file', () => {
        const rules = new SceneRules(dir);
        assert.throws(() => rules.save('thermal', { version: 'none', scenes: baseScenes(true) }, 'admin'), /必须完整/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ai-tracker-thermal.json'), 'utf8')).rulesVersion, undefined);
        const saved = rules.save('thermal', { version: 'none', scenes: thermalScenes(true) }, 'admin');
        assert.deepEqual(Object.keys(saved.scenes), ['T1']);
    });
});

describe('Scene rules HTTP permissions', function () {
    this.timeout(12000);
    let dir, server, role, settings;
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-scene-rules-http-'));
        fs.writeFileSync(path.join(dir, 'ai-tracker.json'), JSON.stringify({ streamKind: 'visible', cameraId: 'c', scenes: {} }));
        fs.writeFileSync(path.join(dir, 'ai-tracker-thermal.json'), JSON.stringify({ streamKind: 'thermal', cameraId: 't', scenes: {} }));
        settings = { secureEnabled: true, workDir: dir };
        role = 'ordinary';
        const runtime = { project: {}, settings, logger: { warn() {}, error() {} },
            cameraScenes: { status: () => ({ visible: { camera: 'test' } }) } };
        cameras.init(runtime, (req, res, next) => { req.isAuthenticated = role !== 'guest'; req.userId = role; req.userGroups = role === 'admin' ? 255 : 1; next(); }, () => role === 'admin' ? 255 : 1);
        // 生产里 camApp 挂在带 bodyParser.json 的 apiApp 下；单独挂载会丢 req.body。
        const host = require('express')();
        host.use(require('express').json({ limit: '1mb' }));
        host.use(cameras.app());
        server = host.listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
    });
    afterEach(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
    const base = () => 'http://127.0.0.1:' + server.address().port;
    const scenes = { V1: { enabled: true }, V2: { enabled: true }, V3: { enabled: true }, V4: { enabled: true }, V5: { enabled: true, count: 4 }, V6: { enabled: true, seconds: 30 }, V7: { enabled: true } };

    it('keeps rule reads and writes behind admin authentication', async () => {
        for (const who of ['guest', 'ordinary']) {
            role = who;
            assert.equal((await fetch(base() + '/api/ai/scenes/rules/visible')).status, who === 'guest' ? 401 : 403);
            assert.equal((await fetch(base() + '/api/ai/scenes/rules/visible', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 'none', scenes }) })).status, who === 'guest' ? 401 : 403);
        }
        role = 'admin';
        const read = await (await fetch(base() + '/api/ai/scenes/rules/visible')).json();
        const saved = await fetch(base() + '/api/ai/scenes/rules/visible', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: read.version, scenes }) });
        assert.equal(saved.status, 200);
        assert.match((await saved.json()).version, /^[0-9a-f-]{36}$/);
        assert.equal((await fetch(base() + '/api/ai/scenes/rules/visible', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 'none', scenes }) })).status, 409);
    });
});
