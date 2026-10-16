'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const express = require('express'), sinon = require('sinon');
const { EventEmitter } = require('events');
const { SceneStore } = require('../../runtime/cameras/scene-store');
const storage = require('../../runtime/alarms/alarmstorage');
const alarms = require('../../runtime/alarms');
const alarmApi = require('../../api/alarms'), cameras = require('../../api/cameras');
const id = 'a'.repeat(32), otherId = 'b'.repeat(32);

describe('Scene alarms through durable ledger and HTTP', function () {
    this.timeout(15000);
    let dir, store, runtime, manager, server, role, at;
    const queue = event => fs.writeFileSync(path.join(dir, 'scene-events', event.eventId + '.json'), JSON.stringify(event));
    const event = (eventId = id, sceneId = 'V2', kind = 'fall') => ({ eventId, sceneId, kind, at,
        camera: 'test-camera', trackId: 'track', shot: 'scene-' + eventId + '.jpg', label: '候选', calibrationVersion: 'test',
        evidenceFrames: [{ file: 'scene-' + eventId + '-0.jpg', at: at - 1000 }, { file: 'scene-' + eventId + '-1.jpg', at }] });
    const call = (url, body, headers = {}) => fetch('http://127.0.0.1:' + server.address().port + url,
        { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-scene-alarms-'));
        for (const name of ['images', 'scene-events', 'scene-evidence']) fs.mkdirSync(path.join(dir, name));
        store = new SceneStore(dir, path.join(dir, 'images')); await store.ready; at = Date.now() - 2000;
        queue(event()); queue(event(otherId, 'V1', 'doorentry'));
        fs.writeFileSync(path.join(dir, 'scene-evidence', 'scene-' + id + '.jpg'), 'main');
        fs.writeFileSync(path.join(dir, 'scene-evidence', 'scene-' + id + '-0.jpg'), 'before');
        // An unregistered frame must not be served, even when its filename matches the event.
        fs.writeFileSync(path.join(dir, 'scene-evidence', 'scene-' + id + '-2.jpg'), 'unregistered');
        sinon.stub(storage, 'getAlarms').resolves({}); sinon.stub(storage, 'getAlarmsHistory').resolves([]);
        runtime = { project: {}, settings: { secureEnabled: true, workDir: dir, imagesFileDir: path.join(dir, 'images') },
            logger: { info() {}, warn() {}, error() {} }, events: new EventEmitter(), cameraScenes: store };
        manager = runtime.alarmsMgr = alarms.create(runtime); role = 'admin';
        const secure = (req, res, next) => { req.userId = role; req.isAuthenticated = role !== 'guest'; req.userGroups = role === 'admin' ? 255 : 1; next(); };
        const groups = () => role === 'admin' ? 255 : 1;
        alarmApi.init(runtime, secure, groups); cameras.init(runtime, secure, groups);
        const app = express(); app.use(express.json(), alarmApi.app(), cameras.app());
        server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    });
    afterEach(async () => {
        await new Promise(resolve => server.close(resolve)); sinon.restore(); await store.close(); fs.rmSync(dir, { recursive: true, force: true });
    });
    it('exposes all scenes once after duplicate delivery and restart, with candidate semantics', async () => {
        queue(event()); await store.ingest(); await store.close(); store = runtime.cameraScenes = new SceneStore(dir, path.join(dir, 'images'));
        const rows = await (await call('/api/alarms')).json();
        assert.equal(rows.length, 2); assert.equal(rows.find(a => a.eventId === id).text.includes('候选待复核'), true);
        assert.equal(rows.find(a => a.eventId === otherId).type, 'info');
        assert.equal((await manager.getAlarmsStatus(255)).high, 1); assert.equal((await manager.getAlarmsStatus(255)).info, 1);
        assert.equal(manager.getAlarmsValues(null, 255).length, 0, 'legacy synchronous API remains synchronous');
    });
    it('filters time, severity, text and tags without mixing scene evidence with tag alarms', async () => {
        assert.equal((await manager.getAllAlarmsValues({ priority: ['high'] }, 255)).length, 1);
        assert.equal((await manager.getAllAlarmsValues({ group: 'V1' }, 255))[0].sceneId, 'V1');
        assert.equal((await manager.getAllAlarmsValues({ text: '跌倒' }, 255))[0].eventId, id);
        assert.equal((await manager.getAllAlarmsValues({ tagIds: ['tag'] }, 255)).length, 0);
        assert.equal((await manager.getAlarmsHistory({ start: at + 1 }, 255)).length, 0);
        assert.equal((await manager.getAlarmsHistory({ start: at, end: at }, 255)).length, 2);
        await assert.rejects(manager.getAlarmsHistory({ start: 'bad' }, 255), /time range/);
    });
    it('acknowledges only the selected identity, reads it back and retains it in history across restart', async () => {
        const body = { params: 'scene:' + id, expectedOntime: at - 1 };
        assert.equal((await call('/api/alarmack', body)).status, 409);
        body.expectedOntime = at; assert.equal((await call('/api/alarmack', body)).status, 200);
        const saved = await store.getEvent(id); assert(saved.ackAt); assert.equal(saved.ackBy, 'admin');
        assert.equal((await store.getEvent(otherId)).ackAt, null);
        assert.equal((await (await call('/api/alarms')).json()).length, 1);
        assert.equal((await manager.getAlarmsStatus(255)).high, 0);
        const history = await (await call('/api/alarmsHistory')).json(); assert.equal(history.find(a => a.eventId === id).acktime, saved.ackAt);
        await call('/api/alarmack', body); assert.equal((await store.getEvent(id)).ackAt, saved.ackAt);
        await store.close(); store = runtime.cameraScenes = new SceneStore(dir, path.join(dir, 'images'));
        assert.equal((await store.getEvent(id)).ackAt, saved.ackAt);
    });
    it('denies ordinary reads/counts and ACK, and anonymous open-mode writes through both routes', async () => {
        role = 'ordinary'; assert.deepEqual(await (await call('/api/alarms')).json(), []);
        assert.deepEqual(await (await call('/api/alarmsHistory')).json(), []); assert.equal((await manager.getAlarmsStatus(1)).high, 0);
        const body = { params: 'scene:' + id, expectedOntime: at };
        assert.equal((await call('/api/alarmack', body)).status, 403);
        for (const suffix of ['evidence', 'evidence-manifest']) assert.equal((await call('/api/ai/scene-events/' + id + '/' + suffix)).status, 403);
        runtime.settings.secureEnabled = false; role = 'guest';
        assert.equal((await (await call('/api/alarms')).json()).length, 2);
        assert.equal((await call('/api/alarmack', body)).status, 401);
        assert.equal((await call('/api/ai/scene-events/' + id + '/ack', {})).status, 401);
        assert.equal((await store.getEvent(id)).ackAt, null);
    });
    it('returns only registered event frames, reports missing images and never serves orphan files', async () => {
        const base = '/api/ai/scene-events/' + id;
        const response = await call(base + '/evidence-manifest'); assert.equal(response.status, 200);
        const manifest = await response.json(); assert.equal(manifest.eventId, id); assert.equal(manifest.frames.length, 3);
        assert.deepEqual(manifest.frames.map(f => f.available), [true, true, false]);
        assert.equal(await (await call(manifest.frames[0].url)).text(), 'main');
        assert.equal(await (await call(manifest.frames[1].url)).text(), 'before');
        assert.equal((await call(manifest.frames[2].url)).status, 404);
        assert.equal((await call(base + '/evidence?frame=3')).status, 404);
        assert.equal((await call(base + '/evidence?frame=../')).status, 400);
        const orphan = 'c'.repeat(32); fs.writeFileSync(path.join(dir, 'scene-evidence', 'scene-' + orphan + '.jpg'), 'orphan');
        assert.equal((await call('/api/ai/scene-events/' + orphan + '/evidence')).status, 404);
        assert.throws(() => store.validate({ ...event(), shot: 'scene-' + otherId + '.jpg' }), /Invalid scene/);
    });
});
