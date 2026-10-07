'use strict';

/**
 * Removing a one-time event: which event is removed, what is cleaned up, and what is reported.
 *
 * Seventh file of scheduler coverage. `removeOneTimeEvent` runs after a non-recurring event has had
 * its last day: it drops the event from the stored scheduler data, cancels its jobs, releases any
 * event-mode bookkeeping and tells the clients.
 *
 * WHY IT IS WORTH TESTS: it runs unattended at the end of a one-time schedule and has FOUR silent
 * refusal paths - no scheduler, no schedule list for that device, an event that cannot be found by
 * id or index, and a storage write that throws. Each used to end in a log line and nothing else, so
 * a caller could not tell "removed" from "could not find it".
 *
 * The refusal that matters most is "not found": the event is STILL in the stored data, so it runs
 * again, and nobody is told.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');
const Events = require('../../runtime/events');

const UPDATED = Events.IoEventTypes.SCHEDULER_UPDATED;

function event(id, extra) {
    return Object.assign({ id: id, eventMode: false, startTime: '08:00', endTime: '09:00' }, extra || {});
}

/** Scheduler data with one device carrying the given events. */
function makeData(events) {
    return {
        settings: { devices: [{ name: 'device-a', variableId: 'a.t1' }] },
        schedules: { 'device-a': events }
    };
}

/**
 * Load the module with a runtime whose storage hands back the SAME object the test inspects, so the
 * assertions can see the edit the function made. The method is getSchedulerData - the real one -
 * because the function reads the stored copy back before editing it.
 */
function loadService(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const saved = [];
    const emitted = [];
    let current = opts.storedData || null;
    const runtime = {
        logger: logger,
        io: { emit: (e, p) => emitted.push({ event: e, payload: p }), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: { setTagValue: sinon.stub().resolves(true), getDeviceIdFromTag: () => 'dev-a' },
        schedulerStorage: {
            getAllSchedulers: sinon.stub().resolves([]),
            getSchedulerData: () => Promise.resolve(current),
            setSchedulerData: (id, d) => {
                if (opts.saveThrows) { return Promise.reject(new Error('disk full')); }
                current = d;
                saved.push({ id: id, data: d });
                return Promise.resolve(true);
            }
        },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger, saved: saved, emitted: emitted };
}

describe('scheduler one-time event removal', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('removes the event, saves the data and tells the clients', async function () {
        const data = makeData([event('ev1'), event('ev2')]);
        const ctx = loadService({ storedData: data });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 0, 'ev1');

        expect(summary.removed).to.equal(true);
        expect(data.schedules['device-a'].map((e) => e.id)).to.deep.equal(['ev2']);
        expect(ctx.saved).to.have.length(1);
        expect(ctx.saved[0].id).to.equal('sch1');
        expect(ctx.emitted.map((e) => e.event)).to.deep.equal([UPDATED]);
        expect(ctx.emitted[0].payload.id).to.equal('sch1');
    });

    it('finds the event by ID even when the index points somewhere else', async function () {
        // The id is the reliable key: indices shift as events are added and deleted, and the caller
        // may be holding an index from before an earlier event was removed.
        const data = makeData([event('ev1'), event('ev2'), event('ev3')]);
        const ctx = loadService({ storedData: data });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 0, 'ev3');

        expect(summary.removed).to.equal(true);
        expect(summary.removedBy).to.equal('id');
        expect(data.schedules['device-a'].map((e) => e.id)).to.deep.equal(['ev1', 'ev2']);
    });

    it('falls back to the index when there is no id to match', async function () {
        const data = makeData([event('ev1'), event('ev2'), event('ev3')]);
        const ctx = loadService({ storedData: data });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 1, null);

        expect(summary.removed).to.equal(true);
        expect(summary.removedBy).to.equal('index');
        expect(data.schedules['device-a'].map((e) => e.id)).to.deep.equal(['ev1', 'ev3']);
    });

    it('an event that cannot be found is reported, because it is STILL SCHEDULED', async function () {
        const data = makeData([event('ev1')]);
        const ctx = loadService({ storedData: data });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 5, 'ev-missing');

        expect(summary.removed).to.equal(false);
        expect(summary.reason).to.equal('not-found');
        expect(data.schedules['device-a']).to.have.length(1);
        expect(ctx.saved, 'nothing to save').to.deep.equal([]);
        expect(ctx.logger.warn.callCount).to.be.greaterThan(0);
    });

    it('a scheduler that does not exist is reported, not swallowed', async function () {
        const ctx = loadService({ storedData: null });
        const summary = await ctx.service.removeOneTimeEvent('sch-missing', 'device-a', 0, 'ev1');
        expect(summary.removed).to.equal(false);
        expect(summary.reason).to.equal('scheduler-not-found');
    });

    it('a scheduler with no entry for the device is reported too', async function () {
        const ctx = loadService({ storedData: { settings: { devices: [] }, schedules: {} } });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-zzz', 0, 'ev1');
        expect(summary.removed).to.equal(false);
        expect(summary.reason).to.equal('no-schedules-for-device');
    });

    it('a throwing storage write is reported, and the in-memory data already lost the event', async function () {
        // Measured and worth knowing: the splice happens BEFORE the save, so a failed save leaves the
        // in-memory copy without the event while the stored copy still has it - the event comes back
        // on the next load. The summary says which stage failed instead of a bare "not removed".
        const data = makeData([event('ev1')]);
        const ctx = loadService({ storedData: data, saveThrows: true });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 0, 'ev1');

        expect(summary.removed).to.equal(false);
        expect(summary.reason).to.equal('storage-failed');
        expect(data.schedules['device-a'], 'the in-memory copy lost the event anyway').to.deep.equal([]);
        const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(logged).to.contain('disk full');
    });

    it('reports the job keys it acts on, keyed by id', async function () {
        const data = makeData([event('ev1')]);
        const ctx = loadService({ storedData: data });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 0, 'ev1');

        expect(summary.jobKeys).to.deep.equal(['sch1_device-a_ev1_start', 'sch1_device-a_ev1_end']);
    });

    it('the job-id rule uses the id when there is one and the index otherwise', function () {
        const service = require('../../runtime/scheduler/scheduler-service');
        expect(service.jobIdBaseFor('sch1', 'device-a', 'ev9', 3)).to.equal('sch1_device-a_ev9');
        expect(service.jobIdBaseFor('sch1', 'device-a', null, 3)).to.equal('sch1_device-a_3');
    });

    it('removing the last event leaves an empty list, not an undefined entry', async function () {
        const data = makeData([event('ev1')]);
        const ctx = loadService({ storedData: data });
        await ctx.service.removeOneTimeEvent('sch1', 'device-a', 0, 'ev1');
        expect(Array.isArray(data.schedules['device-a'])).to.equal(true);
        expect(data.schedules['device-a']).to.deep.equal([]);
    });

    it('an event-mode event with active bookkeeping is removed as well', async function () {
        // The event-mode case takes the same path; there is no interval or timeout registered here,
        // so this pins that its absence is handled.
        const data = makeData([event('ev1', { eventMode: true, duration: 60, endTime: undefined })]);
        const ctx = loadService({ storedData: data });
        const summary = await ctx.service.removeOneTimeEvent('sch1', 'device-a', 0, 'ev1');
        expect(summary.removed).to.equal(true);
        expect(data.schedules['device-a']).to.deep.equal([]);
    });
});
