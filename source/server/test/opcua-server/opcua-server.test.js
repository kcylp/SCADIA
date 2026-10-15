/**
 * OPC UA server tests (B1).
 *
 * Three layers:
 *   1. type mapping / coercion — the pure rules that decide what a client sees
 *   2. address space      — folders and variables built from a stubbed project
 *   3. a real end-to-end run: node-opcua's own CLIENT connects to our server over
 *      loopback, browses, reads a live value and receives a pushed subscription
 *      update. Using the library's client (not ours) is what makes this a real
 *      interoperability check rather than a self-consistency one.
 */

'use strict';

const assert = require('assert');
const net = require('net');
const EventEmitter = require('events');

// Loaded at module scope on purpose: node-opcua's first require runs a
// self-test that blocks the event loop for ~1s. Paying that while mocha is still
// assembling files keeps it away from other suites' timing-sensitive tests.
const opcua = require('node-opcua');

const datatype = require('../../runtime/opcua-server/datatype');
const opcuaServer = require('../../runtime/opcua-server');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

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

/** Ask the OS for a free port, then release it for the server to bind. */
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

// ------------------------------------------------------------------ typing

describe('OPC UA type mapping', () => {

    it('maps the S7 tag vocabulary', () => {
        assert.strictEqual(datatype.mapTagType('Bool'), 'Boolean');
        assert.strictEqual(datatype.mapTagType('Int'), 'Int16');
        assert.strictEqual(datatype.mapTagType('Word'), 'UInt16');
        assert.strictEqual(datatype.mapTagType('DInt'), 'Int32');
        assert.strictEqual(datatype.mapTagType('DWord'), 'UInt32');
        assert.strictEqual(datatype.mapTagType('Real'), 'Float');
        assert.strictEqual(datatype.mapTagType('Byte'), 'Byte');
    });

    it('maps the Modbus vocabulary, including endian-suffixed names', () => {
        assert.strictEqual(datatype.mapTagType('Int16'), 'Int16');
        assert.strictEqual(datatype.mapTagType('UInt32'), 'UInt32');
        assert.strictEqual(datatype.mapTagType('Float32'), 'Float');
        assert.strictEqual(datatype.mapTagType('Float64'), 'Double');
        assert.strictEqual(datatype.mapTagType('Int32MLE'), 'Int32');
        assert.strictEqual(datatype.mapTagType('UInt16LE'), 'UInt16');
    });

    it('falls back to Double for unknown numeric-sounding types and String otherwise', () => {
        assert.strictEqual(datatype.mapTagType('SomethingNumeric'), 'String');
        assert.strictEqual(datatype.mapTagType('int128weird'), 'Double');
        assert.strictEqual(datatype.mapTagType(null), 'Double');
    });

    it('refuses to truncate a float into a declared integer type', () => {
        assert.strictEqual(datatype.coerce(3.5, 'Int16').ok, false);
        assert.strictEqual(datatype.coerce(3.5, 'Double').ok, true);
        assert.strictEqual(datatype.coerce(3, 'Int16').ok, true);
    });

    it('reports bad quality for values that cannot represent the type', () => {
        assert.strictEqual(datatype.coerce('abc', 'Double').ok, false);
        assert.strictEqual(datatype.coerce(null, 'Boolean').ok, false);
        assert.strictEqual(datatype.coerce('', 'String').ok, false);
    });

    it('coerces booleans and boolean-ish strings', () => {
        assert.strictEqual(datatype.coerce(1, 'Boolean').value, true);
        assert.strictEqual(datatype.coerce(0, 'Boolean').value, false);
        assert.strictEqual(datatype.coerce('true', 'Boolean').value, true);
        assert.strictEqual(datatype.coerce('off', 'Boolean').value, false);
        assert.strictEqual(datatype.coerce('maybe', 'Boolean').ok, false);
    });
});

// ------------------------------------------------------------ address space

/**
 * Build the NodeId the server mints for a path.
 *
 * Identity segments are numeric-tagged: 1 = structural folder, 2 = stable id
 * (device id / tag id), 3 = display name. Because the stable segments use ids and
 * not names, renaming a device or a tag leaves every NodeId — and therefore every
 * client reference — untouched. See runtime/opcua-server/index.js.
 */
const NID = (segs) => 'ns=1;s=' + segs.join('.');
const FOLDER = (v) => '1:' + v;
const ID = (v) => '2:' + v;
const NAME = (v) => '3:' + v;

const ROOT = NID([FOLDER('SCADA')]);
const DEVICES = NID([FOLDER('SCADA'), FOLDER('Devices')]);
/**
 * Identity is built from ids only; display names ('SPS', 'Level', ...) are BrowseName
 * metadata and never appear in a NodeId. That is what makes renames safe.
 */
const SPS = NID([FOLDER('SCADA'), FOLDER('Devices'), ID('d1')]);
const TAG = (tagId) => NID([FOLDER('SCADA'), FOLDER('Devices'), ID('d1'), ID(tagId)]);
const CAM = (folder, varName) => NID([FOLDER('SCADA'), FOLDER(folder), ID('cam_1'), FOLDER(varName)]);
// (CAM is defined with the other builders below.)

/** A stubbed runtime shaped like the real one (project + devices + cameras). */
function fakeRuntime(options) {
    const o = options || {};
    const events = new EventEmitter();
    const writes = [];
    const tagValues = Object.assign({ 'tag_level': 42.5, 'tag_run': true, 'tag_name': '主井' }, o.tagValues || {});
    return {
        events: events,
        writes: writes,
        project: {
            getDevices: () => ({
                d1: {
                    id: 'd1', name: 'SPS', type: 'SiemensS7',
                    tags: {
                        'tag_level': { id: 'tag_level', name: 'Level', type: 'Real' },
                        'tag_run': { id: 'tag_run', name: 'Run', type: 'Bool' },
                        'tag_name': { id: 'tag_name', name: 'PitName', type: 'String' },
                        // present in the project but never given a value
                        'tag_empty': { id: 'tag_empty', name: 'Spare', type: 'Real' }
                    }
                }
            })
        },
        devices: {
            getTagValue: (tagId, fully) => {
                if (!(tagId in tagValues)) { return null; }
                const v = tagValues[tagId];
                return fully ? { id: tagId, value: v, ts: Date.now() } : v;
            },
            setTagValue: async (tagId, value) => {
                if (!(tagId in tagValues)) { return null; }
                writes.push({ tagId: tagId, value: value });
                tagValues[tagId] = value;
                return true;
            }
        },
        cameraStorage: {
            getCameras: async () => ([
                { id: 'cam_1', name: '一号皮带机', aiEnabled: true }
            ])
        },
        cameraFusion: { getStatus: () => ({ cam_1: { online: true } }) },
        cameraAi: { service: { getDetections: () => ({ detections: [{}] }) } }
    };
}

describe('OPC UA server (disabled)', () => {
    it('does not publish anything when disabled', async () => {
        const info = await opcuaServer.init({ opcuaServer: { enabled: false } }, silentLogger, fakeRuntime());
        assert.strictEqual(info.enabled, false);
        assert.strictEqual(opcuaServer.status().running, false);
    });
});

describe('OPC UA server', function () {
    this.timeout(30000);

    // One server serves both the address-space assertions and the client
    // end-to-end run. node-opcua blocks the event loop for ~0.5s per start/stop
    // anyway, so a second lifecycle would be pure extra interference with any
    // timing-sensitive test running in the same process.
    let rt = null;
    let port = null;
    let client = null;
    let session = null;

    before(async () => {
        rt = fakeRuntime();
        port = await freePort();
        const info = await opcuaServer.init({
            opcuaServer: {
                enabled: true, port: port, rootName: 'SCADA', allowAnonymous: true,
                writeEnabled: false, exposeCameras: true, cameraPollMs: 60000
            }
        }, silentLogger, rt);
        assert.strictEqual(info.enabled, true, 'server must start');
        // cameras are added by the first refresh pass
        await waitFor(() => opcuaServer.status().cameras >= 1, 3000, 'camera variables');

        client = opcua.OPCUAClient.create({
            endpointMustExist: false,
            securityMode: opcua.MessageSecurityMode.None,
            securityPolicy: opcua.SecurityPolicy.None
        });
        await client.connect(`opc.tcp://127.0.0.1:${port}/UA/SCADA`);
        session = await client.createSession();
    });

    after(async () => {
        try { if (session) { await session.close(); } } catch (err) { /* ignore */ }
        try { if (client) { await client.disconnect(); } } catch (err) { /* ignore */ }
        await opcuaServer.stop();
    });

    it('publishes device tags, camera state and AI alarms as variables', async () => {
        const st = opcuaServer.status();
        assert.strictEqual(st.tags, 4, 'all four tags published (including the valueless one)');
        assert.strictEqual(st.cameras, 1);
        assert.strictEqual(st.writeEnabled, false);
        assert.strictEqual(st.running, true);
    });

    it('advertises an opc.tcp endpoint', async () => {
        const endpoints = await client.getEndpoints();
        assert.ok(endpoints && endpoints.length >= 1);
        assert.ok(endpoints.some(e => e.endpointUrl.indexOf('opc.tcp://') === 0));
    });

    it('browses the published tree (Devices/Cameras/Ai folders exist)', async () => {
        const children = await session.browse(ROOT);
        const names = children.references.map(r => r.browseName.name);
        assert.ok(names.indexOf('Devices') >= 0, 'Devices folder missing: ' + names.join(','));
        assert.ok(names.indexOf('Cameras') >= 0, 'Cameras folder missing');
        assert.ok(names.indexOf('Ai') >= 0, 'Ai folder missing');

        const devChildren = await session.browse(DEVICES);
        assert.ok(devChildren.references.some(r => r.browseName.name === 'SPS'));

        const tagChildren = await session.browse(SPS);
        const tagNames = tagChildren.references.map(r => r.browseName.name);
        assert.ok(tagNames.indexOf('Level') >= 0, 'tag variable missing: ' + tagNames.join(','));
    });

    it('reads live tag values with the declared types', async () => {
        const level = await session.readVariableValue(TAG('tag_level'));
        assert.strictEqual(level.statusCode.name, 'Good');
        assert.strictEqual(level.value.value, 42.5);
        assert.strictEqual(level.value.dataType, opcua.DataType.Float, 'S7 Real maps to OPC UA Float');

        const run = await session.readVariableValue(TAG('tag_run'));
        assert.strictEqual(run.value.value, true);
        assert.strictEqual(run.value.dataType, opcua.DataType.Boolean);

        const name = await session.readVariableValue(TAG('tag_name'));
        assert.strictEqual(name.value.value, '主井');
        assert.strictEqual(name.value.dataType, opcua.DataType.String);
    });

    it('reports Bad quality (not a fabricated 0) for a tag that never had a value', async () => {
        const res = await session.readVariableValue(TAG('tag_empty'));
        assert.notStrictEqual(res.statusCode.name, 'Good');
        assert.ok(/Bad/.test(res.statusCode.name), 'expected a Bad status, got ' + res.statusCode.name);
    });

    it('refuses a client write while writeEnabled is false', async () => {
        // The variable advertises read-only, so the write must be rejected; what
        // matters is that nothing reaches the device layer.
        try {
            await session.writeSingleNode(TAG('tag_level'),
                { dataType: opcua.DataType.Float, value: 99 });
        } catch (err) {
            // rejected outright: also acceptable
        }
        assert.strictEqual(rt.writes.length, 0, 'no write may reach the device layer');
    });

    it('pushes a subscription update when a tag changes', async () => {
        const subscription = await session.createSubscription2({
            requestedPublishingInterval: 200,
            maxNotificationsPerPublish: 10,
            // OPC UA only publishes when the subscription is created with
            // publishing enabled; without it the client quietly receives nothing.
            publishingEnabled: true
        });
        const received = [];
        const monitoredItem = await subscription.monitor(
            { nodeId: TAG('tag_level'), attributeId: opcua.AttributeIds.Value },
            { samplingInterval: 50, queueSize: 10, discardOldest: true },
            opcua.TimestampsToReturn.Both
        );
        monitoredItem.on('changed', (dataValue) => {
            received.push(dataValue.value.value);
        });

        // Wait for the initial notification before pushing: a notification that
        // races the CreateMonitoredItems request gets parked by the client, so a
        // value pushed too early would look like a lost update.
        await waitFor(() => received.length >= 1, 5000, 'initial notification');
        assert.strictEqual(received[received.length - 1], 42.5, 'initial value over the subscription');

        // The device layer pushes a new value the same way a real poll would.
        rt.events.emit('tag-value:changed', { id: 'tag_level', value: 77.25, timestamp: Date.now() });

        await waitFor(() => received.indexOf(77.25) >= 0, 8000, 'pushed value over the subscription');
        assert.ok(received.indexOf(77.25) >= 0, 'client should have received 77.25, got ' + JSON.stringify(received));

        await subscription.terminate();
    });

    it('publishes a tag under a NodeId that carries the device and tag IDS', async () => {
        // Identity is built from stable ids, never from names, which is what makes the
        // rename case below safe. The var is readable at that exact NodeId.
        const levelId = TAG('tag_level');
        assert.ok(levelId.indexOf('2:d1') >= 0, 'device id must be part of the NodeId');
        assert.ok(levelId.indexOf('2:tag_level') >= 0, 'tag id must be part of the NodeId');

        // (The exact value is asserted by the read test above; the subscription test
        // mutates it, so asserting a literal here would depend on execution order.)
        const res = await session.readVariableValue(levelId);
        assert.strictEqual(res.statusCode.name, 'Good');
    });

    it('exposes camera state and AI alarm over the same address space', async () => {
        const online = await session.readVariableValue(CAM('Cameras', 'Online'));
        assert.strictEqual(online.value.value, true);

        const alarm = await session.readVariableValue(CAM('Ai', 'Alarm'));
        assert.strictEqual(alarm.value.value, true, 'one live detection box means alarm');

        const count = await session.readVariableValue(CAM('Ai', 'Detections'));
        assert.strictEqual(count.value.value, 1);
    });
});
