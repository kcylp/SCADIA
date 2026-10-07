'use strict';

/**
 * Binding generation / revision (2026-09-29, contract 09 section 4.3 / ledger L-05).
 *
 * A device is rebound IN PLACE: updateDevice() stops it and loadDevice() runs again on
 * the same object, rebuilding the driver tag maps. Clearing the polling interval does
 * not cancel a read already in flight, so a response from the OLD binding can still
 * arrive and be archived as if it were current.
 *
 * Every rebind bumps a per-device revision, and the DAQ sink is bound to the revision
 * that wired it, so superseded output is dropped instead of silently mixed in.
 */

const Module = require('module');
const { expect } = require('chai');
const guard = require('../../runtime/devices/binding-guard');

/** deviceId -> the sink the driver was last told to call (test instrumentation) */
const daqSinks = {};
function daqSinkFor(id) { return daqSinks[id]; }

function makeFakeDevice(id, tagIds) {
    const tags = {};
    tagIds.forEach(t => { tags[t] = { id: t, name: t, type: 'number' }; });
    let savedDaq = null;
    return {
        id,
        name: id,
        getTags: () => tags,
        start: () => {},
        stop: () => Promise.resolve(),
        load: () => {},
        getTagProperty: (tagId) => tags[tagId] || null,
        bindGetProperty: () => {},
        bindUpdateConnectionStatus: () => {},
        bindSaveDaqValue: (fnc) => { savedDaq = fnc; daqSinks[id] = fnc; },
        bindGetDaqValueToRestore: () => {},
        /** test hook: what the driver was told to call when it has values */
        __emit: (values) => (savedDaq ? savedDaq(values, id, id) : undefined)
    };
}

describe('device binding revision', () => {
    let devices;
    let dashboard;
    let daqWrites;
    let originalLoad;

    beforeEach(() => {
        dashboard = {};
        daqWrites = [];
        Object.keys(daqSinks).forEach(k => delete daqSinks[k]);
        originalLoad = Module._load;
        Module._load = function (request, parent) {
            if (request === './device' && parent && parent.filename &&
                parent.filename.endsWith('devices' + require('path').sep + 'index.js')) {
                return {
                    create: (data) => makeFakeDevice(data.id, Object.keys(data.tags || {})),
                    isInternal: () => false,
                    getSupportedProperty: () => undefined
                };
            }
            return originalLoad.apply(this, arguments);
        };
        delete require.cache[require.resolve('../../runtime/devices/index')];
        devices = require('../../runtime/devices/index');
    });

    afterEach(() => {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../runtime/devices/index')];
    });

    function makeRuntime() {
        return {
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            settings: { daqEnabled: true },
            project: {
                getDevices: () => dashboard,
                getServer: () => null,
                getDeviceProperty: () => undefined
            },
            daqStorage: {
                reset: () => {},
                addDaqNode: () => (values) => { daqWrites.push(values); },
                getCurrentStorageFnc: () => () => {}
            }
        };
    }

    function loadWith(layout) {
        dashboard = {};
        Object.keys(layout).forEach(id => {
            dashboard[id] = {
                id, name: id, enabled: true,
                tags: layout[id].reduce((acc, t) => { acc[t] = { id: t }; return acc; }, {})
            };
        });
        devices.init(makeRuntime());
        devices.load();
    }

    function reloadDevice(id, tagIds) {
        const tags = {};
        tagIds.forEach(t => { tags[t] = { id: t }; });
        devices.loadDevice({ id: id, name: id, enabled: true, tags: tags });
    }

    it('starts a device at revision 1 and has no stale drops yet', () => {
        loadWith({ 'device-a': ['t1'] });

        expect(devices.getBindingRevision('device-a')).to.equal(1);
        expect(devices.getStaleValuesDropped()).to.equal(0);
    });

    it('reports revision 0 for a device that was never loaded', () => {
        loadWith({ 'device-a': ['t1'] });
        expect(devices.getBindingRevision('never-seen')).to.equal(0);
    });

    it('bumps the revision when the same device is rebound', () => {
        loadWith({ 'device-a': ['t1'] });
        expect(devices.getBindingRevision('device-a')).to.equal(1);

        reloadDevice('device-a', ['t1']);
        expect(devices.getBindingRevision('device-a')).to.equal(2);

        reloadDevice('device-a', ['t1']);
        expect(devices.getBindingRevision('device-a')).to.equal(3);
    });

    it('accepts values from the CURRENT binding', () => {
        loadWith({ 'device-a': ['t1'] });
        const dev = devices.getActiveDevice('device-a');

        dev.__emit({ t1: { id: 't1', value: 42 } });

        expect(daqWrites).to.have.length(1);
        expect(devices.getStaleValuesDropped()).to.equal(0);
    });

    it('the sink that was bound BEFORE a rebind is superseded and can no longer archive', () => {
        // This is what the sink guard actually guarantees: a reference to the OLD sink
        // stops working once the device is rebound. It does NOT yet cover a live driver
        // that keeps producing values after a rebind, because the revision does not
        // travel with the value (see the module docblock).
        loadWith({ 'device-a': ['t1'] });
        const staleSink = daqSinkFor('device-a');

        reloadDevice('device-a', ['t1']);

        staleSink({ t1: { id: 't1', value: 99 } }, 'device-a', 'device-a');

        expect(daqWrites).to.have.length(0, 'the superseded sink must not archive');
        expect(devices.getStaleValuesDropped()).to.equal(1);
    });

    it('values still reach DAQ through the CURRENT binding after a rebind', () => {
        loadWith({ 'device-a': ['t1'] });
        reloadDevice('device-a', ['t1']);

        devices.getActiveDevice('device-a').__emit({ t1: { id: 't1', value: 7 } });

        expect(daqWrites).to.have.length(1);
        expect(devices.getStaleValuesDropped()).to.equal(0);
    });

    it('keeps revisions independent per device', () => {
        loadWith({ 'device-a': ['t1'], 'device-b': ['t2'] });
        reloadDevice('device-a', ['t1']);

        expect(devices.getBindingRevision('device-a')).to.equal(2);
        expect(devices.getBindingRevision('device-b')).to.equal(1);
    });

    it('stamps the generation onto the definition handed to the driver', () => {
        // Device.load() adopts this before rebuilding the driver tag maps, which is what
        // lets a driver tell whether its in-flight read still belongs to this binding.
        loadWith({ 'device-a': ['t1'] });
        expect(devices.getBindingRevision('device-a')).to.equal(1);

        const seen = [];
        const original = devices.getActiveDevice('device-a').load;
        devices.getActiveDevice('device-a').load = function (def) { seen.push(def.bindingRevision); return original.apply(this, arguments); };

        reloadDevice('device-a', ['t1']);

        expect(seen).to.deep.equal([2]);
    });

    it('does not drop output from an unrelated device', () => {
        loadWith({ 'device-a': ['t1'], 'device-b': ['t2'] });
        const b = devices.getActiveDevice('device-b');

        reloadDevice('device-a', ['t1']);

        b.__emit({ t2: { id: 't2', value: 5 } });

        expect(daqWrites).to.have.length(1);
        expect(devices.getStaleValuesDropped()).to.equal(0);
    });
});

describe('binding-guard (in-flight rebind detection)', () => {
    const runtimeWith = (rev) => ({ devices: { getBindingRevision: () => rev } });

    it('prefers the CLONED generation the driver was loaded with', () => {
        // The driver holds a clone of the definition, so data.bindingRevision is the
        // generation that clone belongs to and never changes under the driver.
        expect(guard.bindingRevisionOf({ id: 'd', bindingRevision: 7 }, runtimeWith(9))).to.equal(7);
    });

    it('falls back to the device object then the manager', () => {
        expect(guard.bindingRevisionOf({ id: 'd', getBindingRevision: () => 5 }, runtimeWith(1))).to.equal(5);
        expect(guard.bindingRevisionOf({ id: 'd' }, runtimeWith(4))).to.equal(4);
    });

    it('reports 0 when no revision tracking is available', () => {
        expect(guard.bindingRevisionOf({ id: 'd' }, {})).to.equal(0);
        expect(guard.bindingRevisionOf(null, null)).to.equal(0);
    });

    it('detects a rebind that happened while the read was in flight', () => {
        // cloned generation 3, live generation moved to 4 during the await
        expect(guard.bindingChangedSince({ id: 'd' }, 3, runtimeWith(4))).to.equal(true);
    });

    it('reports no change while the binding is untouched', () => {
        expect(guard.bindingChangedSince({ id: 'd' }, 5, runtimeWith(5))).to.equal(false);
    });

    it('does not claim a change when only the clone is consulted', () => {
        // Guards against the trap of comparing the live value with itself.
        const cloned = { id: 'd', bindingRevision: 3 };
        const started = guard.bindingRevisionOf(cloned, runtimeWith(4));
        expect(started).to.equal(3);
        expect(guard.bindingChangedSince(cloned, started, runtimeWith(4))).to.equal(true);
    });

    it('NEVER blocks a write when tracking is unavailable (revision 0)', () => {
        // Legacy paths and drivers that do not participate must keep working unchanged.
        expect(guard.bindingChangedSince({ id: 'd' }, 0, runtimeWith(9))).to.equal(false);
    });

    it('survives a device object that throws when asked', () => {
        const angry = { id: 'd', getBindingRevision: () => { throw new Error('boom'); } };
        expect(guard.bindingRevisionOf(angry, runtimeWith(2))).to.equal(2);
    });
});

describe('driver emit guard (device-utils.shouldEmitForBinding)', () => {
    const deviceUtils = require('../../runtime/devices/device-utils');
    const runtimeWith = (rev) => ({ devices: { getBindingRevision: () => rev } });

    it('lets a driver emit while its binding is current', () => {
        const cache = { revision: null };
        expect(deviceUtils.shouldEmitForBinding({ id: 'd', bindingRevision: 1 }, runtimeWith(1), cache)).to.equal(true);
        expect(deviceUtils.shouldEmitForBinding({ id: 'd', bindingRevision: 1 }, runtimeWith(1), cache)).to.equal(true);
    });

    it('mutes a driver whose binding was replaced', () => {
        const cache = { revision: null };
        const data = { id: 'd', bindingRevision: 1 };
        expect(deviceUtils.shouldEmitForBinding(data, runtimeWith(1), cache)).to.equal(true);
        // device rebound in place: the driver's cloned definition still says 1
        expect(deviceUtils.shouldEmitForBinding(data, runtimeWith(2), cache)).to.equal(false);
    });

    it('re-arms after a reload so the new binding is not muted forever', () => {
        const cache = { revision: null };
        const oldBinding = { id: 'd', bindingRevision: 1 };
        deviceUtils.shouldEmitForBinding(oldBinding, runtimeWith(1), cache);
        expect(deviceUtils.shouldEmitForBinding(oldBinding, runtimeWith(2), cache)).to.equal(false);

        // load() re-arms the cache and the driver receives the new definition
        deviceUtils.resetBindingCache(cache);
        const newBinding = { id: 'd', bindingRevision: 2 };
        expect(deviceUtils.shouldEmitForBinding(newBinding, runtimeWith(2), cache)).to.equal(true);
    });

    it('never mutes a driver when revision tracking is unavailable', () => {
        const cache = { revision: null };
        expect(deviceUtils.shouldEmitForBinding({ id: 'd' }, {}, cache)).to.equal(true);
        expect(deviceUtils.shouldEmitForBinding({ id: 'd' }, {}, cache)).to.equal(true);
    });

    it('exposes resetBindingCache for driver load()', () => {
        const cache = { revision: 7 };
        deviceUtils.resetBindingCache(cache);
        expect(cache.revision).to.equal(null);
    });
});
