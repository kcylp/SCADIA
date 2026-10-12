'use strict';

/**
 * Tag resolution index (2026-09-29, contract 09 §4.2 / ledger L-05).
 *
 * Before this change `getDeviceIdFromTag` walked every active device and asked its
 * driver for the tag, returning the FIRST device that owned it:
 *   - O(devices) on every call, and
 *   - a duplicated tagId resolved silently and arbitrarily.
 *
 * The index keeps the same return semantics (a deviceId or null) so none of the five
 * consumers had to change, but it resolves in O(1) and it EXPOSES a duplicated tagId
 * instead of hiding it.
 */

const Module = require('module');
const { expect } = require('chai');

function makeFakeDevice(id, tagIds) {
    const tags = {};
    tagIds.forEach(t => { tags[t] = { id: t, name: t, type: 'number' }; });
    return {
        id,
        name: id,
        getTags: () => tags,
        start: () => {},
        stop: () => Promise.resolve(),
        load: () => {},
        getTagProperty: (tagId) => tags[tagId] || null,
        // bind* hooks that loadDevice() wires up; inert on purpose.
        bindGetProperty: () => {},
        bindUpdateConnectionStatus: () => {},
        bindSaveDaqValue: () => {},
        bindGetDaqValueToRestore: () => {}
    };
}

describe('devices tag index', () => {
    let devices;
    let dashboard;                 // deviceId -> tagIds, mutated by each test
    let originalLoad;

    beforeEach(() => {
        dashboard = {};
        // Intercept the Device module so loadDevice() produces controlled devices
        // without opening a single connection.
        originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
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
            settings: { daqEnabled: false },
            project: {
                getDevices: () => dashboard,
                getServer: () => null,
                getDeviceProperty: () => undefined
            },
            daqStorage: { reset: () => {}, addDaqNode: () => () => {}, getCurrentStorageFnc: () => () => {} }
        };
    }

    /** Load the manager with the given device -> tags layout. */
    function loadWith(layout) {
        dashboard = {};
        Object.keys(layout).forEach(id => {
            dashboard[id] = { id, name: id, enabled: true, tags: layout[id].reduce((acc, t) => { acc[t] = { id: t }; return acc; }, {}) };
        });
        devices.init(makeRuntime());
        devices.load();
    }

    it('resolves a tag to its owning device', () => {
        loadWith({ 'device-a': ['t1', 't2'], 'device-b': ['t3'] });

        expect(devices.getDeviceIdFromTag('t1')).to.equal('device-a');
        expect(devices.getDeviceIdFromTag('t3')).to.equal('device-b');
    });

    it('returns null for an unknown tag', () => {
        loadWith({ 'device-a': ['t1'] });

        expect(devices.getDeviceIdFromTag('nope')).to.equal(null);
        expect(devices.getDeviceIdFromTag('')).to.equal(null);
        expect(devices.getDeviceIdFromTag(null)).to.equal(null);
    });

    it('exposes the owner, the tagId and the ambiguity of a resolution', () => {
        loadWith({ 'device-a': ['t1'] });

        expect(devices.resolveTag('t1')).to.deep.equal({
            deviceId: 'device-a', tagId: 't1', ambiguous: false, candidates: ['device-a']
        });
        expect(devices.resolveTag('missing')).to.equal(null);
    });

    it('reports a tagId duplicated across devices instead of hiding it', () => {
        const warnings = [];
        dashboard = {
            'device-a': { id: 'device-a', name: 'A', enabled: true, tags: { dup: { id: 'dup' } } },
            'device-b': { id: 'device-b', name: 'B', enabled: true, tags: { dup: { id: 'dup' } } }
        };
        const rt = makeRuntime();
        rt.logger.warn = (msg) => warnings.push(msg);
        devices.init(rt);
        devices.load();

        // Keeps the historical first-owner answer so no consumer changes meaning...
        expect(devices.getDeviceIdFromTag('dup')).to.equal('device-a');

        // ...but the collision is now visible rather than silent.
        const resolved = devices.resolveTag('dup');
        expect(resolved.ambiguous).to.equal(true);
        expect(resolved.candidates).to.deep.equal(['device-a', 'device-b']);
        expect(devices.getTagConflicts()).to.deep.equal({ dup: ['device-a', 'device-b'] });
        expect(warnings.join(' ')).to.include('dup');
    });

    it('reports no conflicts for an unambiguous project', () => {
        loadWith({ 'device-a': ['t1'], 'device-b': ['t2'] });

        expect(devices.getTagConflicts()).to.deep.equal({});
        expect(devices.resolveTag('t1').ambiguous).to.equal(false);
    });

    it('re-resolves after the device set changes (no stale index)', () => {
        loadWith({ 'device-a': ['t1'] });
        expect(devices.getDeviceIdFromTag('t1')).to.equal('device-a');

        // move t1 to device-b and drop device-a
        loadWith({ 'device-b': ['t1'] });

        expect(devices.getDeviceIdFromTag('t1')).to.equal('device-b');
        expect(devices.getDeviceIdFromTag('gone')).to.equal(null);
    });

    it('does not resolve a tag belonging to a disabled device', () => {
        dashboard = {
            'device-on': { id: 'device-on', name: 'on', enabled: true, tags: { live: { id: 'live' } } },
            'device-off': { id: 'device-off', name: 'off', enabled: false, tags: { parked: { id: 'parked' } } }
        };
        devices.init(makeRuntime());
        devices.load();

        expect(devices.getDeviceIdFromTag('live')).to.equal('device-on');
        // A disabled device is not active, so its tags are not running values.
        expect(devices.getDeviceIdFromTag('parked')).to.equal(null);
    });
});
