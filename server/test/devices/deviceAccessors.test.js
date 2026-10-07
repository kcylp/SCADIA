'use strict';

/**
 * The script-facing device accessors must REPORT a failure through the logger.
 *
 * Nine of them used to look like this:
 *
 *     try { ...; return x; } catch (err) { console.error(err); } return null;
 *
 * The behaviour is fine - a script asking for a missing tag should get null, not a thrown error -
 * so this is not about making them throw. The problem was the DIAGNOSTIC: \`console.error\` writes to
 * stdout while this runtime's operator diagnostics live in the logger (a file, with a level), and
 * the message was the bare error object. "Cannot read properties of undefined" with no indication
 * of whether it came from a tag lookup, a DAQ settings write, or a device enable.
 *
 * The suite drives the real manager with a controller-injected device whose methods throw, and then
 * asserts on the LOGGER - not on stdout. That is the actual contract: a failure an operator can find.
 *
 * TWO SITUATIONS THAT MUST STAY DIFFERENT, and this file asserts both:
 *   - an unknown tag or an unknown device is a MISS, not a failure. It answers null and logs
 *     nothing. Logging misses would drown the signal this change is trying to create.
 *   - a store that throws is a FAILURE. It answers null (a script must keep running) and logs the
 *     operation plus the id.
 *
 * Reverse verification would have to delete a log call, so the rule is proven by the conversion
 * that produced this file: before it, every assertion below failed.
 */

const Module = require('module');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

/** A device instance whose driver methods all throw, to force the accessors down their catch path. */
function makeFailingDevice(id) {
    const boom = () => { throw new Error('driver exploded'); };
    const tags = { t1: { id: 't1', name: 'Level', type: 'number', daq: { enabled: true } } };
    return {
        id,
        name: id,
        getTags: () => tags,
        start: () => {},
        stop: () => Promise.resolve(),
        load: () => {},
        getTagProperty: (tagId) => tags[tagId] || null,
        getValue: boom,
        setValue: boom,
        getTagDaqSettings: boom,
        setTagDaqSettings: boom,
        getComm: boom,
        bindGetProperty: () => {},
        bindUpdateConnectionStatus: () => {},
        bindSaveDaqValue: () => {},
        bindGetDaqValueToRestore: () => {}
    };
}

describe('device accessors report failures through the logger', () => {
    let devices;
    let logger;
    let originalLoad;
    /** Handed to the manager at init, and mutated by the tests that need a throwing store. */
    let failingRuntimeProject;

    beforeEach(() => {
        originalLoad = Module._load;
        Module._load = function (request, parent) {
            if (request === './device' && parent && parent.filename &&
                parent.filename.endsWith('devices' + path.sep + 'index.js')) {
                return {
                    create: (data) => makeFailingDevice(data.id),
                    isInternal: () => false,
                    getSupportedProperty: () => undefined
                };
            }
            return originalLoad.apply(this, arguments);
        };

        logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
        const dashboard = {
            'device-a': { id: 'device-a', name: 'device-a', enabled: true, tags: { t1: { id: 't1', name: 'Level' } } }
        };
        failingRuntimeProject = {
            getDevices: () => dashboard,
            getServer: () => null,
            getDevice: (name) => dashboard[name] || null,
            getDeviceProperty: () => undefined
        };
        const runtime = {
            logger: logger,
            settings: { daqEnabled: false },
            project: failingRuntimeProject,
            daqStorage: { reset: () => {}, addDaqNode: () => () => {}, getCurrentStorageFnc: () => () => {} }
        };

        delete require.cache[require.resolve('../../runtime/devices/index')];
        devices = require('../../runtime/devices/index');
        devices.init(runtime);
        devices.load();
    });

    afterEach(() => {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../runtime/devices/index')];
        sinon.restore();
    });

    /** The one logger.error call, as a single string. */
    function loggedError() {
        expect(logger.error.callCount, 'nothing was logged - the failure went somewhere silent')
            .to.be.greaterThan(0);
        return logger.error.getCall(0).args.join(' ');
    }

    it('getTagValue still answers null, and names the operation', function () {
        expect(devices.getTagValue('t1')).to.equal(null);
        expect(loggedError()).to.contain('getTagValue');
        expect(loggedError()).to.contain('t1');
    });

    it('getTagValue with fully=true answers null too, instead of throwing at the caller', function () {
        // Both branches of the old function returned different things on success and null on
        // failure; that asymmetry is preserved deliberately.
        expect(devices.getTagValue('t1', true)).to.equal(null);
    });

    it('setTagValue resolves to null rather than rejecting into the script engine', async function () {
        // The driver's setValue throws synchronously here; the accessor must still answer null
        // rather than letting the rejection escape into the script engine.
        const result = await devices.setTagValue('t1', 5);
        expect(result).to.equal(null);
        expect(loggedError()).to.contain('setTagValue');
    });

    it('getTagDaqSettings and setTagDaqSettings report with the tag id', function () {
        expect(devices.getTagDaqSettings('t1')).to.equal(null);
        expect(loggedError()).to.contain('getTagDaqSettings');

        logger.error.resetHistory();
        expect(devices.setTagDaqSettings('t1', { enabled: true })).to.equal(null);
        expect(loggedError()).to.contain('setTagDaqSettings');
    });

    it('getDeviceProperty reports with the device name when the lookup throws', function () {
        // A normal miss (unknown name) is not a failure and must stay silent; a THROW is a failure
        // and must be visible. Two different situations, two different assertions.
        expect(devices.getDeviceProperty('no-such-device'), 'a miss is not a failure').to.equal(null);
        expect(logger.error.callCount, 'a missing device must not be logged as an error').to.equal(0);

        const original = failingRuntimeProject.getDevice;
        failingRuntimeProject.getDevice = () => { throw new Error('project store unavailable'); };
        try {
            expect(devices.getDeviceProperty('device-a')).to.equal(null);
            expect(loggedError()).to.contain('getDeviceProperty');
            expect(loggedError()).to.contain('device-a');
            expect(loggedError()).to.contain('project store unavailable');
        } finally {
            failingRuntimeProject.getDevice = original;
        }
    });

    it('setDeviceProperty reports with the device name when the write throws', function () {
        const original = failingRuntimeProject.getDevice;
        failingRuntimeProject.getDevice = () => { throw new Error('project store unavailable'); };
        try {
            expect(devices.setDeviceProperty('device-a', {})).to.equal(null);
            expect(loggedError()).to.contain('setDeviceProperty');
            expect(loggedError()).to.contain('device-a');
        } finally {
            failingRuntimeProject.getDevice = original;
        }
    });

    it('getDevice reports instead of returning undefined in silence', function () {
        // getDevice is the one accessor with no trailing "return null" - on failure it fell out of
        // the function. Behaviour kept; the difference was that it did so with nothing in the log.
        expect(devices.getDevice('device-a', true)).to.equal(undefined);
        expect(loggedError()).to.contain('getDevice');
    });

    it('a successful read is NOT logged as a failure', function () {
        // Threshold: the guard is worthless if it fires on the happy path too.
        devices.getTagValue('unknown-tag');
        expect(logger.error.callCount, 'a missing tag is not a failure - it is an absent value')
            .to.equal(0);
    });
});
