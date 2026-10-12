/**
 * AI video analytics tests (A9).
 *
 * Three layers:
 *   1. normalisation — engine payload shapes (Frigate / generic) -> one box model
 *   2. policy        — thresholds, label whitelist, TTL expiry, alarm edge/hold
 *   3. a real end-to-end run over loopback WebSocket: engine -> ws-ingest ->
 *      service -> stored box, which is what a field engine actually does.
 */

'use strict';

const assert = require('assert');
const WebSocket = require('ws');

const normalize = require('../../runtime/cameras/ai/normalize');
const service = require('../../runtime/cameras/ai/ai-service');
const ai = require('../../runtime/cameras/ai');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const CAM_ID = 'cam_ab12cd34ef56';
const CAM_NAME = '一号皮带机';

function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 2000);
    return new Promise((resolve, reject) => {
        const tick = () => {
            Promise.resolve()
                .then(() => predicate())
                .then((ok) => {
                    if (ok) { resolve(true); return; }
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition'))); return; }
                    setTimeout(tick, 10);
                })
                .catch((err) => {
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition') + ': ' + err.message)); return; }
                    setTimeout(tick, 10);
                });
        };
        tick();
    });
}

/** settings.ai for unit tests; overrides shallow-merge onto the defaults. */
function aiSettings(overrides) {
    return {
        ai: Object.assign({
            enabled: true,
            minScore: 0.5,
            labels: [],
            ttlMs: 5000,
            maxDetections: 50,
            detectWidth: null,
            detectHeight: null,
            alarmTagId: '',
            alarmClearMs: 15000,
            cameraMap: {},
            mqtt: { enabled: false },
            ws: { enabled: false, port: 0, host: '127.0.0.1' }
        }, overrides || {})
    };
}

/** Camera store stub: exposes the name/id pair the resolver matches on. */
function fakeStorage(cameras) {
    return { getCameras: async () => cameras || [] };
}

/** Fusion stub capturing SCADIA tag writes. */
function fakeRuntime(writes) {
    return {
        cameraFusion: {
            writeEvent: async (tagId, value) => {
                if (tagId === 'missing/tag') {
                    const err = new Error('tag not found'); err.code = 'CAM_TAG_NOT_FOUND'; throw err;
                }
                writes.push({ tagId: tagId, value: value });
                return { tagId: tagId, value: value };
            }
        }
    };
}

// ------------------------------------------------------------------ normalize

describe('AI detection normalisation', () => {

    it('accepts a Frigate MQTT event box in detect-resolution pixels', () => {
        // detect 640x480, box [160,120,320,360] -> x .25 y .25 w .25 h .5
        const r = normalize.normalizePayload({
            type: 'update',
            after: { id: '1699', camera: 'frigate_cam_1', label: 'person', score: 0.91, box: [160, 120, 320, 360], frame_time: 1700000000 }
        }, { defaultWidth: 640, defaultHeight: 480 });

        assert.strictEqual(r.camera, 'frigate_cam_1');
        assert.strictEqual(r.detections.length, 1);
        const d = r.detections[0];
        assert.strictEqual(d.label, 'person');
        assert.strictEqual(d.score, 0.91);
        assert.strictEqual(d.normalized, true);
        assert.deepStrictEqual(d.region, { x: 0.25, y: 0.25, w: 0.25, h: 0.5 });
        assert.strictEqual(d.timestamp, 1700000000000);
    });

    it('uses the payload frame size when the engine sends it', () => {
        const r = normalize.normalizePayload({
            camera: 'c1', label: 'car', score: 0.8,
            box: { x: 0, y: 0, w: 50, h: 100 }, imageWidth: 100, imageHeight: 200
        });
        assert.deepStrictEqual(r.detections[0].region, { x: 0, y: 0, w: 0.5, h: 0.5 });
    });

    it('accepts an already-normalised region and clamps it to the frame', () => {
        const r = normalize.normalizePayload({
            camera: 'c1',
            detections: [{ label: 'person', score: 0.7, region: { x: 0.9, y: 0.1, w: 0.5, h: 0.2 } }]
        });
        const d = r.detections[0];
        assert.strictEqual(d.normalized, true);
        assert.strictEqual(d.region.x, 0.9);
        assert.strictEqual(d.region.y, 0.1);
        assert.ok(Math.abs(d.region.w - 0.1) < 1e-9, 'w clamped to 1 - x');
        assert.strictEqual(d.region.h, 0.2);
    });

    it('normalises a 0..100 confidence to 0..1', () => {
        const r = normalize.normalizePayload({ camera: 'c1', label: 'smoke', score: 87, region: { x: 0, y: 0, w: 0.1, h: 0.1 } });
        assert.strictEqual(r.detections[0].score, 0.87);
    });

    it('drops a pixel box when no frame size is known instead of misplacing it', () => {
        const r = normalize.normalizePayload({ camera: 'c1', label: 'person', score: 0.9, box: [10, 10, 20, 20] });
        assert.strictEqual(r.detections.length, 0);
        assert.strictEqual(r.dropped, 1);
    });

    it('reports an Frigate end event as a clear, not a detection', () => {
        const r = normalize.normalizePayload({ type: 'end', after: { camera: 'frigate_cam_1', label: 'person' } });
        assert.strictEqual(r.eventType, 'end');
        assert.strictEqual(r.detections.length, 0);
    });
});

// --------------------------------------------------------------------- policy

describe('AI analytics service', () => {

    afterEach(async () => {
        await service.stop(null);
        service.init(aiSettings({ enabled: false }), silentLogger, null, null);   // reset module state
    });

    it('stores the live boxes for the matching camera, resolving by name', async () => {
        const writes = [];
        await service.init(aiSettings(), silentLogger, fakeRuntime(writes),
            fakeStorage([{ id: CAM_ID, name: CAM_NAME }]), null);

        const res = await service.ingest({
            camera: CAM_NAME, label: 'person', score: 0.9, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }
        }, 'http');

        assert.strictEqual(res.camera, CAM_ID, 'engine name must resolve to our camera id');
        assert.strictEqual(res.kept, 1);
        const live = service.getDetections(CAM_ID);
        assert.strictEqual(live.detections.length, 1);
        assert.strictEqual(live.detections[0].label, 'person');
        assert.strictEqual(live.detections[0].source, 'http');
    });

    it('honours cameraMap when the engine name differs from ours', async () => {
        await service.init(aiSettings({ cameraMap: { frigate_cam_9: CAM_ID } }), silentLogger, null,
            fakeStorage([{ id: CAM_ID, name: CAM_NAME }]), null);
        const res = await service.ingest({
            camera: 'frigate_cam_9', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.2, h: 0.2 }
        }, 'http');
        assert.strictEqual(res.camera, CAM_ID);
        assert.strictEqual(service.getDetections(CAM_ID).detections.length, 1);
    });

    it('drops detections below minScore and outside the label whitelist', async () => {
        await service.init(aiSettings({ minScore: 0.6, labels: ['person', 'car'] }), silentLogger, null, fakeStorage([]), null);
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        await service.ingest({ camera: 'c1', label: 'person', score: 0.2, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        await service.ingest({ camera: 'c1', label: 'dog', score: 0.95, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        const live = service.getDetections('c1');
        assert.strictEqual(live.detections.length, 1, 'only the person@0.9 passes both filters');
        assert.strictEqual(live.detections[0].label, 'person');
        assert.strictEqual(service.status().stats.dropped, 2, 'the low-score and wrong-label events are counted as dropped');
    });

    it('does not clear a live box just because a later payload was filtered out', async () => {
        await service.init(aiSettings({ labels: ['person'] }), silentLogger, null, fakeStorage([]), null);
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        await service.ingest({ camera: 'c1', label: 'dog', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        assert.strictEqual(service.getDetections('c1').detections.length, 1, 'the person box must survive a dog event');
    });

    it('expires boxes after ttlMs', async () => {
        await service.init(aiSettings({ ttlMs: 60 }), silentLogger, null, fakeStorage([]), null);
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        assert.strictEqual(service.getDetections('c1').detections.length, 1);
        await waitFor(() => service.getDetections('c1').detections.length === 0, 1000, 'ttl expiry');
        assert.strictEqual(service.getDetections('c1').expired, false, 'the record is gone, not merely stale');
    });

    it('clears the camera boxes on an end event', async () => {
        await service.init(aiSettings(), silentLogger, null, fakeStorage([]), null);
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        await service.ingest({ type: 'end', camera: 'c1', after: { label: 'person' } }, 'mqtt');
        assert.strictEqual(service.getDetections('c1').detections.length, 0);
    });

    it('raises the alarm tag once and holds it, then releases it after alarmClearMs', async () => {
        const writes = [];
        await service.init(aiSettings({ alarmTagId: 'S7/ai_alarm', alarmClearMs: 80 }), silentLogger,
            fakeRuntime(writes), fakeStorage([]), null);

        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        assert.deepStrictEqual(writes, [{ tagId: 'S7/ai_alarm', value: 1 }], 'a held alarm must not rewrite the tag');

        await waitFor(() => writes.length === 2, 2000, 'alarm release');
        assert.strictEqual(writes[1].value, 0);
    });

    it('does not crash when the alarm tag does not exist', async () => {
        const writes = [];
        await service.init(aiSettings({ alarmTagId: 'missing/tag' }), silentLogger, fakeRuntime(writes), fakeStorage([]), null);
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        assert.strictEqual(service.getDetections('c1').detections.length, 1, 'boxes are kept even if the tag write fails');
        assert.deepStrictEqual(writes, []);
    });

    it('rejects ingest when analytics is disabled', async () => {
        await service.init(aiSettings({ enabled: false }), silentLogger, null, fakeStorage([]), null);
        await assert.rejects(
            () => service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http'),
            (err) => err.code === 'AI_DISABLED');
    });

    it('rejects a payload with no camera identifier', async () => {
        await service.init(aiSettings(), silentLogger, null, fakeStorage([]), null);
        await assert.rejects(
            () => service.ingest({ label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http'),
            (err) => err.code === 'AI_BAD_PAYLOAD');
    });

    it('reports detector state in status()', async () => {
        await service.init(aiSettings(), silentLogger, null, fakeStorage([]), null);
        await service.ingest({ camera: 'c1', label: 'person', score: 0.9, region: { x: 0, y: 0, w: 0.1, h: 0.1 } }, 'http');
        const s = service.status();
        assert.strictEqual(s.enabled, true);
        assert.strictEqual(s.cameras, 1);
        assert.strictEqual(s.stats.ingests, 1);
        assert.strictEqual(s.stats.detections, 1);
    });
});

// --------------------------------------------------- end-to-end over WebSocket

describe('AI WebSocket ingest (end-to-end over loopback)', function () {
    this.timeout(15000);

    let info = null;
    let socket = null;

    before(async () => {
        info = await ai.init(aiSettings({ ws: { enabled: true, port: 0, host: '127.0.0.1' } }),
            silentLogger, fakeRuntime([]), fakeStorage([{ id: CAM_ID, name: CAM_NAME }]));
        assert.strictEqual(info.enabled, true);
        assert.ok(info.ws > 0, 'ws ingest must bind a real port');
        socket = new WebSocket('ws://127.0.0.1:' + info.ws);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
    });

    after(async () => {
        if (socket) { try { socket.close(); } catch (e) { /* ignore */ } socket = null; }
        await ai.stop();
    });

    function sendAndReceive(payload) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.off('message', onMsg); reject(new Error('no ws reply')); }, 3000);
            const onMsg = (data) => {
                clearTimeout(timer);
                socket.off('message', onMsg);
                resolve(JSON.parse(String(data)));
            };
            socket.on('message', onMsg);
            socket.send(JSON.stringify(payload));
        });
    }

    it('accepts a pushed detection, acknowledges it and stores the box', async () => {
        const ack = await sendAndReceive({
            camera: CAM_NAME, label: 'person', score: 0.93,
            region: { x: 0.2, y: 0.3, w: 0.25, h: 0.4 }, normalized: true
        });
        assert.strictEqual(ack.ok, true);
        assert.strictEqual(ack.camera, CAM_ID);
        assert.strictEqual(ack.kept, 1);

        const live = ai.service.getDetections(CAM_ID);
        assert.strictEqual(live.detections.length, 1);
        assert.strictEqual(live.detections[0].source, 'ws');
        assert.strictEqual(live.detections[0].label, 'person');
    });

    it('answers a malformed frame with an error instead of dropping the socket', async () => {
        const reply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { socket.off('message', onMsg); reject(new Error('no ws reply')); }, 3000);
            const onMsg = (data) => {
                clearTimeout(timer);
                socket.off('message', onMsg);
                resolve(JSON.parse(String(data)));
            };
            socket.on('message', onMsg);
            socket.send('not json at all');
        });
        assert.strictEqual(reply.ok, false);
        assert.strictEqual(reply.error, 'AI_BAD_PAYLOAD');
        assert.strictEqual(socket.readyState, WebSocket.OPEN, 'socket must stay open');
    });
});
