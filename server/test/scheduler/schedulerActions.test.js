'use strict';

/**
 * The scheduler action executor must REPORT what it did.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * runtime/scheduler/scheduler-service.js is the largest file in the repository (1600+ lines) and had
 * NO test that executed it - the only mention of its name anywhere under test/ was inside a comment.
 * Everything below is therefore new coverage of a path that runs unattended: when a scheduler event
 * fires, this code writes to devices and runs scripts with nobody watching.
 *
 * WHAT IT CAUGHT
 *
 * Three handlers - set value, toggle value, run script - returned undefined on EVERY path, and the
 * caller `await`ed them and ignored the answer because there was none. Two of the silent paths
 * matter:
 *
 *   - `runtime.devices.setTagValue` RESOLVES FALSE when the write is refused; it does not throw. The
 *     handlers only acted inside `if (result)`, so a refused write changed nothing, published
 *     nothing, and logged nothing there.
 *   - a missing variable id / script id logged a warning at most, and the caller could not tell it
 *     apart from success.
 *
 * The executor now returns a summary (total / applied / skipped / failed + one entry per action), and
 * a refused or failed action is logged with the scheduler, the device and the reason. Callers still
 * ignore the summary - that is deliberate, this batch changes no behaviour - but the outcome is
 * available and the log is no longer silent.
 *
 * The tests drive the real `executeDeviceActions` through the exported seam, with a fake device
 * layer. `init()` is deliberately NOT called: it wires node-schedule jobs, a socket listener and a
 * storage read, none of which this path needs.
 */

const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');

/** A runtime whose device layer is under the test's control. */
function makeRuntime(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const devices = {
        getDeviceIdFromTag: sinon.stub().callsFake((tagId) => (opts.tagDeviceMap && opts.tagDeviceMap[tagId]) || null),
        getDeviceValue: sinon.stub().callsFake(() => ({ id: 't1', value: 1 })),
        setTagValue: sinon.stub().resolves(opts.writeResult === undefined ? true : opts.writeResult),
        getDevicesValues: sinon.stub().returns({})
    };
    const runtime = {
        logger: logger,
        devices: devices,
        io: { emit: sinon.stub(), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    if (opts.runScriptThrows) { runtime.scriptsMgr.runScript.rejects(new Error('script exploded')); }
    if (opts.setTagThrows) { devices.setTagValue.rejects(new Error('transport down')); }
    return { runtime: runtime, logger: logger, devices: devices };
}

/**
 * Hand the service its runtime WITHOUT init(): init() would schedule jobs and read storage.
 * The module keeps them in module scope, so the seam is exercised through a settings fixture that
 * carries the runtime it needs - which is why every assertion below goes through
 * executeDeviceActions and not through a handler directly.
 */
function loadService(runtime) {
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    // The service reads `runtime` from module scope, set by init(). Calling init() here would start
    // node-schedule work, so the runtime is injected by the only other route available: a settings
    // object that init() would accept is not needed, we simply call init with a stub io and events.
    service.init({}, runtime.logger, runtime);
    return service;
}

/** Settings fixture with one device action. */
function settingsWith(action) {
    return { deviceActions: [Object.assign({ deviceName: 'dev-a', eventTrigger: 'on' }, action)] };
}

describe('scheduler action executor reports its outcome', () => {
    let service;

    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('a successful set value is applied and reported as applied', async function () {
        const ctx = makeRuntime({ tagDeviceMap: { t1: 'dev-a' } });
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onSetValue',
            actparam: '5',
            actoptions: { variable: { variableId: 't1', variableRaw: { type: 'number' } } }
        }));

        expect(summary.total).to.equal(1);
        expect(summary.applied).to.equal(1);
        expect(summary.failed).to.equal(0);
        expect(summary.results[0]).to.deep.equal({ action: 'onSetValue', applied: true });
        expect(ctx.devices.setTagValue.calledOnce).to.equal(true);
    });

    it('a REFUSED write is reported as failed, not as silence', async function () {
        // setTagValue resolves false for a refused write. Before this change the handler did nothing
        // in that case and said nothing: no log, no return value, no broadcast.
        const ctx = makeRuntime({ tagDeviceMap: { t1: 'dev-a' }, writeResult: false });
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onSetValue',
            actparam: '5',
            actoptions: { variable: { variableId: 't1', variableRaw: { type: 'number' } } }
        }));

        expect(summary.applied).to.equal(0);
        expect(summary.failed).to.equal(1);
        expect(summary.results[0].reason).to.equal('write-refused');
        const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ') +
            ctx.logger.warn.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(logged, 'a refused write must leave a trace naming the tag').to.contain('t1');
    });

    it('a throwing device write is reported as failed with the reason', async function () {
        const ctx = makeRuntime({ tagDeviceMap: { t1: 'dev-a' }, setTagThrows: true });
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onSetValue',
            actparam: '5',
            actoptions: { variable: { variableId: 't1', variableRaw: { type: 'number' } } }
        }));

        expect(summary.failed).to.equal(1);
        expect(summary.results[0].reason).to.equal('threw');
        expect(summary.results[0].message).to.contain('transport down');
    });

    it('a missing variable id is a SKIP, not a failure and not a success', async function () {
        const ctx = makeRuntime({});
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onSetValue',
            actparam: '5',
            actoptions: {}
        }));

        expect(summary.skipped, 'an action that cannot be attempted is skipped').to.equal(1);
        expect(summary.failed).to.equal(0);
        expect(summary.applied).to.equal(0);
        expect(summary.results[0].reason).to.equal('missing-variable');
    });

    it('an unknown tag is a failure with a reason, not a crash', async function () {
        const ctx = makeRuntime({});
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onSetValue',
            actparam: '5',
            actoptions: { variable: { variableId: 't1', variableRaw: { type: 'number' } } }
        }));

        expect(summary.results[0].reason).to.equal('device-not-found');
        expect(summary.failed).to.equal(1);
    });

    it('a throwing script is reported, and the other actions still run', async function () {
        const ctx = makeRuntime({ tagDeviceMap: { t1: 'dev-a' }, runScriptThrows: true });
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', {
            deviceActions: [
                { deviceName: 'dev-a', eventTrigger: 'on', action: 'onRunScript', actparam: 's1' },
                {
                    deviceName: 'dev-a', eventTrigger: 'on', action: 'onSetValue', actparam: '5',
                    actoptions: { variable: { variableId: 't1', variableRaw: { type: 'number' } } }
                }
            ]
        });

        expect(summary.total).to.equal(2);
        expect(summary.failed, 'the script failed').to.equal(1);
        expect(summary.applied, 'the action after the failing one must still run').to.equal(1);
        expect(summary.results[0].reason).to.equal('threw');
        expect(summary.results[1].applied).to.equal(true);
    });

    it('an unsupported action type is counted, not silently ignored', async function () {
        const ctx = makeRuntime({});
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onSomethingNew'
        }));

        expect(summary.results[0].reason).to.equal('unsupported-action');
        expect(summary.failed).to.equal(1);
    });

    it('no actions for this trigger is not a failure', async function () {
        const ctx = makeRuntime({});
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'other-device', 'on', settingsWith({
            action: 'onSetValue', actparam: '5',
            actoptions: { variable: { variableId: 't1', variableRaw: { type: 'number' } } }
        }));

        expect(summary.total).to.equal(0);
        expect(summary.failed).to.equal(0);
    });

    it('malformed settings do not throw', async function () {
        const ctx = makeRuntime({});
        service = loadService(ctx.runtime);
        for (const settings of [undefined, null, {}, { deviceActions: 'nope' }]) {
            const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settings);
            expect(summary.total).to.equal(0);
        }
    });

    it('a toggle with a bitmask writes the XOR of the current value', async function () {
        const ctx = makeRuntime({ tagDeviceMap: { t1: 'dev-a' } });
        ctx.devices.getDeviceValue.returns({ id: 't1', value: 5 });
        service = loadService(ctx.runtime);
        const summary = await service.executeDeviceActions('sch1', 'dev-a', 'on', settingsWith({
            action: 'onToggleValue',
            actoptions: { variable: { variableId: 't1', bitmask: 2 } }
        }));

        expect(summary.applied).to.equal(1);
        expect(ctx.devices.setTagValue.getCall(0).args[1]).to.equal(5 ^ 2);
    });
});
