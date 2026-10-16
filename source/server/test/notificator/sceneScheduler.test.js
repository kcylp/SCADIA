'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const sinon = require('sinon');
const { SceneStore } = require('../../runtime/cameras/scene-store');
const { create } = require('../../runtime/notificator');

describe('Scene notifications through the real manager scheduler', function () {
    this.timeout(10000);
    let dir, store, manager, timers, nextTimer, now, sent, subscriptions, send, active, warns;
    const eventId = 'd'.repeat(32);
    async function openStore() {
        store = new SceneStore(dir, path.join(dir, 'images'));
        await store.ready;
    }
    function createManager() {
        const runtime = {
            events: new EventEmitter(), settings: {},
            logger: { info() {}, warn: (...a) => warns.push(a.join(' ')), error() {} },
            project: { getNotifications: async () => subscriptions },
            get cameraScenes() { return store; }
        };
        manager = runtime.notificatorMgr = create(runtime);
        manager.sendMail = async message => send(message);
    }
    const tick = () => [...timers.values()].find(t => t.ms === 15000).fn();
    function queue() {
        fs.writeFileSync(path.join(dir, 'scene-events', eventId + '.json'), JSON.stringify({
            eventId, sceneId: 'V3', source: 'visible', kind: 'smoking', at: now,
            camera: 'fixture', trackId: '1', shot: 'scene-' + eventId + '.jpg',
            label: '吸烟候选', calibrationVersion: 'fixture'
        }));
    }
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-scheduler-'));
        fs.mkdirSync(path.join(dir, 'scene-events')); fs.mkdirSync(path.join(dir, 'images'));
        await openStore();
        now = Date.now(); sent = []; active = 0; timers = new Map(); nextTimer = 0; warns = [];
        subscriptions = [{ id: 'fixture-sub', type: 'scenes', name: 'fixture', enabled: true,
            receiver: 'test@example.invalid', sceneIds: ['V3'], scenePhases: ['candidate', 'review'] }];
        send = async message => { sent.push(message); };
        sinon.stub(Date, 'now').callsFake(() => now);
        sinon.stub(global, 'setInterval').callsFake((fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); active++; return id; });
        sinon.stub(global, 'clearInterval').callsFake(id => { if (timers.delete(id)) active--; });
        createManager();
    });
    afterEach(async () => {
        await manager.stop(); sinon.restore();
        await store.close(); fs.rmSync(dir, { recursive: true, force: true });
    });
    it('resolves start and keeps one pair of timers after repeated start/stop', async () => {
        let resolved = false;
        manager.start().then(() => { resolved = true; });
        await Promise.resolve();
        assert.equal(resolved, true, 'start must acknowledge timer installation');
        manager.start();
        assert.equal(active, 2, 'repeated start must replace both timers');
        await manager.stop(); assert.equal(active, 0);
        await manager.start(); assert.equal(active, 2);
    });
    it('delivers each phase once, suppresses overlapping ticks and persists across restart', async () => {
        manager.start(); await tick();
        now += 1000; queue();
        let release, entered;
        const sending = new Promise(resolve => { entered = resolve; });
        send = message => new Promise(resolve => { sent.push(message); release = resolve; entered(); });
        now += 1000;
        const first = tick(); await sending;
        await tick(); assert.equal(sent.length, 1, 'overlap must not send twice');
        release(); await first;
        const claim = await store.claimReview();
        await store.finishReview(eventId, { lease: claim.lease, result: {
            reviewStatus: 'completed', verdict: '证据不足', limitations: 'fixture lacks detail'
        } });
        send = async message => { sent.push(message); };
        now += 15000; await tick();
        assert.equal(sent.length, 2); assert.match(sent[1].text, /证据不足/);
        assert.match(sent[1].text, /fixture lacks detail/);
        await manager.stop(); assert.equal(active, 0);
        await store.close(); await openStore(); createManager(); manager.start();
        now += 15000; await tick(); assert.equal(sent.length, 2);
        const rows = await store.deliveries();
        assert.equal(rows.length, 2); assert(rows.every(r => r.status === 'sent' && r.attempts === 1));
    });
    it('tolerates a project with no notification subscriptions without warning', async () => {
        // 真实工程无订阅时 getNotifications() 解析为 undefined：
        // 调度入口必须按“无订阅”处理，而不是每个周期抛 TypeError 并被吞成告警。
        subscriptions = undefined;
        manager.start(); await tick();
        assert.deepEqual(warns, []);
        assert.equal(sent.length, 0);
        const rows = await store.deliveries();
        assert.equal(rows.length, 0);
    });
    it('resumes a failed delivery after restart and preserves independent subscription scope', async () => {
        manager.start(); await tick();
        now += 1000; queue();
        send = async () => { throw Error('fixture transport failure'); };
        now += 1000; await tick();
        let rows = await store.deliveries();
        assert.equal(rows[0].status, 'failed'); assert.equal(rows[0].attempts, 1);
        await manager.stop(); await store.close(); await openStore(); createManager(); manager.start();
        subscriptions.push({ ...subscriptions[0], id: 'other-sub', sceneIds: ['T1'] });
        send = async message => { sent.push(message); };
        now += 120000; await tick();
        rows = await store.deliveries();
        assert.equal(sent.length, 1); assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'sent'); assert.equal(rows[0].attempts, 2);
        now += 15000; await tick(); assert.equal(sent.length, 1);
    });
});
