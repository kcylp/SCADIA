/**
 * WebSocket device driver tests (B2).
 *
 * Two layers:
 *   1. frame decoding — the gateway dialects the driver has to absorb
 *   2. a real end-to-end run: a WebSocket SERVER pushes frames to the driver
 *      over loopback, and we assert on what reaches the events bus. Using a real
 *      socket is the point: the failure modes here are connection lifecycle,
 *      reconnect and ordering, none of which a stubbed socket would show.
 */

'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const WebSocket = require('ws');

const driver = require('../../runtime/devices/websocket');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const DEVICE_ID = 'dev-ws-1';
const DEVICE_NAME = 'WS Gateway';

function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 3000);
    return new Promise((resolve, reject) => {
        const tick = () => {
            Promise.resolve()
                .then(() => predicate())
                .then((ok) => {
                    if (ok) { resolve(true); return; }
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition'))); return; }
                    setTimeout(tick, 20);
                })
                .catch((err) => {
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition') + ': ' + err.message)); return; }
                    setTimeout(tick, 20);
                });
        };
        tick();
    });
}

/** Ask the OS for a free port, then release it so the test server can bind. */
function freePort() {
    return new Promise((resolve, reject) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

/** Device data shaped the way runtime/devices/loadDevice builds it. */
function deviceData(tags, property) {
    const map = {};
    (tags || []).forEach(t => { map[t.id] = Object.assign({ changed: false }, t); });
    return {
        id: DEVICE_ID,
        name: DEVICE_NAME,
        type: 'WebSocket',
        property: Object.assign({ address: '', timeout: 3000 }, property || {}),
        tags: map
    };
}

function fakeRuntime(events) {
    return { events: events, logger: silentLogger };
}

// ------------------------------------------------------------ frame decoding

describe('WebSocket driver frame decoding', () => {

    function decode(text) {
        const events = new EventEmitter();
        const d = driver.create(deviceData([{ id: 't1', name: 't1', address: 'x', type: 'number' }]), silentLogger, events, fakeRuntime(events));
        return d._decodeFrame(text);
    }

    it('decodes a flat map of addresses', () => {
        const r = decode('{"pit.level":1.2,"pit.run":true}');
        assert.strictEqual(r.items.length, 2);
        assert.deepStrictEqual(r.items[0], { address: 'pit.level', value: 1.2 });
        assert.deepStrictEqual(r.items[1], { address: 'pit.run', value: true });
        assert.ok(r.discovered.indexOf('pit.level') >= 0);
    });

    it('decodes an addressed item (topic/value)', () => {
        const r = decode('{"topic":"pit.level","value":42}');
        assert.deepStrictEqual(r.items, [{ address: 'pit.level', value: 42 }]);
    });

    it('accepts the alternative address/value key spellings', () => {
        assert.deepStrictEqual(decode('{"address":"a","data":1}').items, [{ address: 'a', value: 1 }]);
        assert.deepStrictEqual(decode('{"key":"b","val":2}').items, [{ address: 'b', value: 2 }]);
        assert.deepStrictEqual(decode('{"tag":"c","value":3}').items, [{ address: 'c', value: 3 }]);
        assert.deepStrictEqual(decode('{"path":"d","value":4}').items, [{ address: 'd', value: 4 }]);
    });

    it('decodes a batch of frames', () => {
        const r = decode('[{"topic":"a","value":1},{"topic":"b","value":2}]');
        assert.deepStrictEqual(r.items, [{ address: 'a', value: 1 }, { address: 'b', value: 2 }]);
    });

    it('descends into a nested envelope when nothing at the top level is routable', () => {
        const r = decode('{"ts":1700000000000,"payload":{"topic":"a","value":7}}');
        assert.deepStrictEqual(r.items, [{ address: 'a', value: 7 }]);
    });

    it('carries an object value through as JSON', () => {
        const r = decode('{"topic":"a","value":{"x":1}}');
        assert.deepStrictEqual(r.items[0].value, { x: 1 });
    });

    it('returns nothing for a bare scalar frame (no address to route on)', () => {
        assert.deepStrictEqual(decode('42').items, []);
        assert.deepStrictEqual(decode('"hello"').items, []);
        // and must not throw on a non-JSON frame
        assert.deepStrictEqual(decode('not json at all').items, []);
    });
});

// ------------------------------------------------------------ end-to-end

describe('WebSocket driver (end-to-end over loopback)', function () {
    this.timeout(20000);

    let server = null;
    let port = null;
    let events = null;
    let comm = null;
    let received = [];
    let statuses = [];
    let daq = [];

    function pushTo(socket, payload) {
        socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }

    before(async () => {
        port = await freePort();
        server = new WebSocket.Server({ port: port, host: '127.0.0.1' });
    });

    beforeEach(async () => {
        received = [];
        statuses = [];
        daq = [];
        events = new EventEmitter();
        events.on('device-value:changed', e => received.push(e));
        events.on('device-status:changed', e => statuses.push(e));
    });

    afterEach(async () => {
        if (comm) { await comm.disconnect(); comm = null; }
    });

    after(async () => {
        if (server) { await new Promise(r => server.close(r)); server = null; }
    });

    function buildDriver(tags, property) {
        const data = deviceData(tags, Object.assign({ address: `ws://127.0.0.1:${port}` }, property || {}));
        comm = driver.create(data, silentLogger, events, fakeRuntime(events));
        comm.bindAddDaq((values, name, id) => daq.push({ values: values, name: name, id: id }));
        comm.load(data);
        return comm;
    }

    it('connects, reports connect-ok and pushes the subscribed addresses', async () => {
        const subscribeFrames = [];
        const connection = new Promise(resolve => {
            server.once('connection', (socket) => {
                socket.on('message', m => subscribeFrames.push(JSON.parse(String(m))));
                resolve(socket);
            });
        });

        buildDriver([
            { id: 'level', name: 'Level', address: 'pit.level', type: 'number' },
            { id: 'run', name: 'Run', address: 'pit.run', type: 'boolean' }
        ]);
        await comm.connect();
        const socket = await connection;

        assert.strictEqual(comm.isConnected(), true);
        assert.ok(statuses.some(s => s.status === 'connect-ok'), 'connect-ok must be emitted');

        await waitFor(() => subscribeFrames.length >= 1, 3000, 'subscribe frame');
        assert.strictEqual(subscribeFrames[0].type, 'subscribe');
        assert.deepStrictEqual(subscribeFrames[0].tags.sort(), ['pit.level', 'pit.run']);

        await new Promise(r => setTimeout(r, 50));
        await new Promise(r => { socket.close(); r(); });
    });

    it('maps a pushed frame onto the right tags with the right values', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([
            { id: 'level', name: 'Level', address: 'pit.level', type: 'number' },
            { id: 'run', name: 'Run', address: 'pit.run', type: 'boolean' },
            // a tag on an address nobody sends must stay untouched
            { id: 'spare', name: 'Spare', address: 'pit.spare', type: 'number' }
        ]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        pushTo(socket, { 'pit.level': 12.5, 'pit.run': true });
        await waitFor(() => received.length >= 1, 3000, 'values emitted');

        const values = received[received.length - 1].values;
        assert.strictEqual(values.level.value, 12.5);
        assert.strictEqual(values.run.value, true);
        assert.strictEqual(values.spare, undefined, 'an unsent tag must not be reported');

        assert.strictEqual(comm.getValue('level').value, 12.5);
        assert.strictEqual(comm.getValue('run').value, true);
        assert.strictEqual(comm.getValue('spare'), null);
    });

    it('reads one field out of a json tag via options.subs + memaddress', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([{
            id: 'temp', name: 'Temp', address: 'robot.status', type: 'json',
            memaddress: 'temperature', options: { subs: ['temperature'] }
        }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        pushTo(socket, { topic: 'robot.status', value: { temperature: 36.6, battery: 80 } });
        await waitFor(() => received.some(e => e.values.temp && e.values.temp.value === 36.6), 3000, 'json field value');

        // a frame missing the field must keep the previous value, not blank it
        pushTo(socket, { topic: 'robot.status', value: { battery: 79 } });
        await new Promise(r => setTimeout(r, 200));
        assert.strictEqual(comm.getValue('temp').value, 36.6, 'a missing field must not blank a live tag');
    });

    it('keeps the last value when a frame is malformed', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([{ id: 'level', name: 'Level', address: 'pit.level', type: 'number' }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        pushTo(socket, { 'pit.level': 5 });
        await waitFor(() => received.some(e => e.values.level && e.values.level.value === 5), 3000, 'first value');
        const countAfterFirst = received.length;

        pushTo(socket, '}{ this is not json');
        await new Promise(r => setTimeout(r, 200));

        assert.strictEqual(comm.getValue('level').value, 5, 'a bad frame must not change the value');
        assert.strictEqual(received.length, countAfterFirst, 'a bad frame must not emit');
    });

    it('writes a tag to the endpoint over the same socket', async () => {
        let socket = null;
        const outbound = [];
        server.once('connection', s => {
            socket = s;
            s.on('message', m => {
                const obj = JSON.parse(String(m));
                if (obj.type !== 'subscribe') { outbound.push(obj); }
            });
        });

        buildDriver([{ id: 'setpoint', name: 'Setpoint', address: 'pit.setpoint', type: 'number' }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        const ok = await comm.setValue('setpoint', 42);
        assert.strictEqual(ok, true);
        await waitFor(() => outbound.length >= 1, 3000, 'outbound write');
        assert.deepStrictEqual(outbound[0], { address: 'pit.setpoint', value: 42 });
    });

    it('drops the value it cannot send when disconnected instead of pretending', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([{ id: 'setpoint', name: 'Setpoint', address: 'pit.setpoint', type: 'number' }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        await comm.disconnect();
        assert.strictEqual(comm.isConnected(), false);
        const ok = await comm.setValue('setpoint', 1);
        assert.strictEqual(ok, false, 'a write on a closed socket must report failure');
    });

    it('saves changed values to DAQ through polling', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([{
            id: 'level', name: 'Level', address: 'pit.level', type: 'number',
            daq: { enabled: true, changed: true }
        }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        pushTo(socket, { 'pit.level': 9.9 });
        await waitFor(() => received.length >= 1, 3000, 'value emitted');
        await comm.polling();

        assert.strictEqual(daq.length, 1, 'the changed value must reach the DAQ store');
        assert.strictEqual(daq[0].values.level.value, 9.9);
        assert.strictEqual(daq[0].name, DEVICE_NAME);
    });

    it('discovers addresses by watching the live stream (browse)', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([{ id: 'level', name: 'Level', address: 'pit.level', type: 'number' }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');

        const browsing = comm.browse('');
        await waitFor(() => socket !== null, 1000, 'socket');
        pushTo(socket, { 'pit.level': 1, 'pit.flow': 2, 'pit.temp': 3 });

        const found = await browsing;
        const ids = found.map(f => f.id).sort();
        assert.deepStrictEqual(ids, ['pit.flow', 'pit.level', 'pit.temp']);
    });

    it('reports the connection status as disconnected once shut down', async () => {
        let socket = null;
        server.once('connection', s => { socket = s; });

        buildDriver([{ id: 'level', name: 'Level', address: 'pit.level', type: 'number' }]);
        await comm.connect();
        await waitFor(() => socket !== null, 3000, 'server socket');
        assert.strictEqual(comm.getStatus(), 'connect-ok');

        await comm.disconnect();
        assert.strictEqual(comm.getStatus(), 'connect-off');
        assert.ok(statuses.some(s => s.status === 'connect-off'));
    });

    it('refuses to connect without an address', async () => {
        buildDriver([{ id: 'level', name: 'Level', address: 'pit.level', type: 'number' }], { address: '' });
        await assert.rejects(() => comm.connect(), /missing websocket address/);
    });
});

// ------------------------------------------- through the real device wrapper

/**
 * The driver above is only reachable if device.js dispatches the type. These
 * tests go through the real Device wrapper, so a missing require/DeviceEnum
 * branch would fail here rather than in the field.
 */
describe('WebSocket device registration through device.js', function () {
    this.timeout(20000);

    let server = null;
    let port = null;

    before(async () => {
        port = await freePort();
        server = new WebSocket.Server({ port: port, host: '127.0.0.1' });
    });

    after(async () => {
        if (server) { await new Promise(r => server.close(r)); server = null; }
    });

    it('is advertised as a supported device type', () => {
        const deviceLib = require('../../runtime/devices/device');
        assert.strictEqual(deviceLib.DeviceType.WebSocket, 'WebSocket');
    });

    it('builds a working device that receives pushed values', async () => {
        const deviceLib = require('../../runtime/devices/device');
        const events = new EventEmitter();
        const received = [];
        events.on('device-value:changed', e => received.push(e));

        const runtime = {
            logger: silentLogger,
            events: events,
            plugins: { manager: null },
            project: { getDeviceProperty: async () => null },
            settings: { appDir: process.cwd() }
        };

        const data = {
            id: DEVICE_ID,
            name: DEVICE_NAME,
            type: 'WebSocket',
            enabled: true,
            polling: 500,
            property: { address: `ws://127.0.0.1:${port}`, timeout: 3000 },
            tags: {
                level: { id: 'level', name: 'Level', address: 'pit.level', type: 'number' }
            }
        };

        let socket = null;
        server.once('connection', s => { socket = s; });

        // device.js returns the Device wrapper, not the driver itself
        const device = deviceLib.create(data, runtime);
        assert.ok(device, 'device.js must build a device for the WebSocket type');

        device.load(data);
        await device.start();
        await waitFor(() => socket !== null, 5000, 'driver connected through the wrapper');

        assert.strictEqual(device.getStatus(), 'connect-ok');
        socket.send(JSON.stringify({ 'pit.level': 3.5 }));
        await waitFor(() => received.length >= 1, 5000, 'value through the wrapper');

        assert.strictEqual(device.getValue('level').value, 3.5);
        await device.stop();
    });
});
