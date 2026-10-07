'use strict';

/**
 * The master-control latch must actually be released when a device leaves a scheduler.
 *
 * Fourth file of scheduler coverage. `handleTagChanges` runs on every scheduler update and does
 * one job: when a device is REMOVED from a scheduler, or pointed at a DIFFERENT tag, reset the old
 * tag to 0. That tag is the scheduler's master-control input, so leaving it at 1 keeps the device
 * latched to a scheduler that no longer controls it - and the runtime's own enforcement reads the
 * same tag and keeps enforcing.
 *
 * The behaviour that made this worth a test: the function `await`ed `writeTagFromEvent` and threw
 * the answer away. That was harmless while the callee returned nothing at all; now that it reports
 * whether the write took effect, a reset that did NOT happen is recorded instead of vanishing.
 *
 * Behaviour is otherwise unchanged: the same two cases reset, the same case does nothing.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');

/** A runtime with a controllable device write and a recording logger. */
function loadService(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const writes = [];
    const runtime = {
        logger: logger,
        io: { emit: sinon.stub(), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: {
            setTagValue: (tagId, value) => {
                writes.push({ tagId: tagId, value: value });
                if (opts.writeThrows) { return Promise.reject(new Error('transport down')); }
                return Promise.resolve(opts.writeResult === undefined ? true : opts.writeResult);
            },
            getDeviceIdFromTag: () => 'dev-a'
        },
        schedulerStorage: { getAllSchedulers: sinon.stub().resolves([]) },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger, writes: writes };
}

/** Scheduler data fixture: settings.devices is the only part this function reads by name. */
function data(devices, schedules) {
    return { settings: { devices: devices }, schedules: schedules || {} };
}

describe('scheduler master-control latch release (handleTagChanges)', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('resets the old tag when a device is removed from the scheduler', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleTagChanges('sch1',
            data([{ name: 'device-a', variableId: 'a.t1' }]),
            data([]));

        expect(ctx.writes).to.deep.equal([{ tagId: 'a.t1', value: 0 }]);
        expect(summary.checked).to.equal(1);
        expect(summary.reset).to.equal(1);
        expect(summary.resets[0].reason).to.equal('Device deleted from scheduler');
        expect(summary.resets[0].applied).to.equal(true);
    });

    it('resets the OLD tag when a device is pointed at a different tag', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleTagChanges('sch1',
            data([{ name: 'device-a', variableId: 'a.t1' }]),
            data([{ name: 'device-a', variableId: 'a.t2' }]));

        expect(ctx.writes, 'only the old tag is reset; the new one is the caller\'s business')
            .to.deep.equal([{ tagId: 'a.t1', value: 0 }]);
        expect(summary.resets[0].reason).to.equal('Tag change - resetting old tag');
    });

    it('does nothing when the device and its tag are unchanged', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleTagChanges('sch1',
            data([{ name: 'device-a', variableId: 'a.t1' }]),
            data([{ name: 'device-a', variableId: 'a.t1' }]));

        expect(ctx.writes).to.deep.equal([]);
        expect(summary.checked).to.equal(0);
        expect(summary.reset).to.equal(0);
    });

    it('resets each affected device, not just the first', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleTagChanges('sch1',
            data([
                { name: 'device-a', variableId: 'a.t1' },
                { name: 'device-b', variableId: 'b.t1' },
                { name: 'device-c', variableId: 'c.t1' }
            ]),
            data([{ name: 'device-b', variableId: 'b.t1' }]));

        // device-b is unchanged and is NOT reset; a is gone and c is gone.
        expect(ctx.writes.map((w) => w.tagId).sort()).to.deep.equal(['a.t1', 'c.t1']);
        expect(summary.checked).to.equal(2);
        expect(summary.reset).to.equal(2);
    });

    it('a changed tag on one device resets that device too, alongside the removed ones', async function () {
        // Every affected device is reset, whichever of the two reasons applies to it.
        const ctx = loadService();
        const summary = await ctx.service.handleTagChanges('sch1',
            data([
                { name: 'device-a', variableId: 'a.t1' },
                { name: 'device-b', variableId: 'b.t1' },
                { name: 'device-c', variableId: 'c.t1' }
            ]),
            data([{ name: 'device-b', variableId: 'b.t2' }]));

        expect(ctx.writes.map((w) => w.tagId).sort()).to.deep.equal(['a.t1', 'b.t1', 'c.t1']);
        const byTag = {};
        summary.resets.forEach((r) => { byTag[r.variableId] = r.reason; });
        expect(byTag['b.t1']).to.equal('Tag change - resetting old tag');
        expect(byTag['a.t1']).to.equal('Device deleted from scheduler');
    });

    it('a REFUSED reset is counted and named, not swallowed', async function () {
        // The write resolves false rather than throwing. Before this change the caller could not
        // tell, and the device stayed latched to a scheduler that no longer controls it.
        const ctx = loadService({ writeResult: false });
        const summary = await ctx.service.handleTagChanges('sch1',
            data([{ name: 'device-a', variableId: 'a.t1' }]),
            data([]));

        expect(summary.failed).to.equal(1);
        expect(summary.reset).to.equal(0);
        expect(summary.resets[0].applied).to.equal(false);
        const warned = ctx.logger.warn.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(warned, 'a latch that was not released must be findable in the log').to.contain('a.t1');
        expect(warned).to.contain('sch1');
    });

    it('a throwing reset is counted and named too', async function () {
        const ctx = loadService({ writeThrows: true });
        const summary = await ctx.service.handleTagChanges('sch1',
            data([{ name: 'device-a', variableId: 'a.t1' }]),
            data([]));

        expect(summary.failed).to.equal(1);
        const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(logged).to.contain('transport down');
    });

    it('missing or malformed old data is not an error and resets nothing', async function () {
        const ctx = loadService();
        for (const oldData of [undefined, null, {}, { settings: {} }, { settings: { devices: null } }]) {
            const summary = await ctx.service.handleTagChanges('sch1', oldData, data([]));
            expect(summary.checked).to.equal(0);
        }
        expect(ctx.writes).to.deep.equal([]);
    });

    it('new data with no devices at all means every old device is removed', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleTagChanges('sch1',
            data([{ name: 'device-a', variableId: 'a.t1' }]),
            { settings: {} });

        expect(summary.reset).to.equal(1);
        expect(ctx.writes).to.deep.equal([{ tagId: 'a.t1', value: 0 }]);
    });
});
