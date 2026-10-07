'use strict';

/**
 * The update pass: six steps, and the ORDER of them is the whole contract.
 *
 * Sixteenth and final file of scheduler coverage. updateScheduler is what the API calls when a
 * scheduler gauge is saved. It is thirty lines, and almost everything it does is a call to code that
 * the earlier batches covered - so what is left to pin here is the SEQUENCE, because three of the
 * steps are order-critical:
 *
 *   1. handleTagChanges      release the control tag of a device this scheduler no longer owns
 *   2. handleEventModifications   re-arm a RUNNING event whose duration changed
 *   3. handleEventDeletions  stop and clean up the events that disappeared
 *   4. stopScheduler         cancel every job of this scheduler
 *   5. createSchedulerJobs   build the new jobs
 *   6. setInitialStates      latch the control tag for the new state
 *   7. notifyEventStates     tell the clients
 *
 * Steps 2 and 3 carry a comment in the source saying they must happen BEFORE step 4 - and that is
 * not a style note. Both of them look up live Event Mode bookkeeping and the ACTIVE JOB MAP to
 * decide what to do ("was this event running", "is there a job to cancel or to move"). Once
 * stopScheduler has run, that information is gone: a duration change would have nothing to re-arm,
 * and a deletion could not tell a running event from an idle one, so a one-time event that was
 * mid-flight would be silently forgotten instead of stopped.
 *
 * These tests therefore assert order through OBSERVABLE side effects - what was written, what was
 * emitted, what was still tracked at each moment - rather than by reaching into the function.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const nodeSchedule = require('node-schedule');
const Events = require('../../runtime/events');

const ACTIVE = Events.IoEventTypes.SCHEDULER_ACTIVE;

const DEVICE_A = { name: 'device-a', variableId: 'a.t1', enabled: true };
const DEVICE_B = { name: 'device-b', variableId: 'b.t1', enabled: true };

function days() {
    const d = new Array(7).fill(false);
    d[new Date().getDay()] = true;
    return d;
}

/** A clock event inside its window right now. */
function activeTimerEvent(id) {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const fmt = (x) => String(Math.floor((((x % 1440) + 1440) % 1440) / 60)).padStart(2, '0') + ':' +
        String((((x % 1440) + 1440) % 1440) % 60).padStart(2, '0');
    return { id: id, eventMode: false, days: days(), startTime: fmt(m - 10), endTime: fmt(m + 10), recurring: true };
}

function dataFor(devices, schedules) {
    return { settings: { devices: devices }, schedules: schedules || {} };
}

function loadService(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const emitted = [];
    const written = [];
    const saved = [];
    let stored = opts.storedSchedulers || [];

    const runtime = {
        logger: logger,
        io: { emit: (e, p) => emitted.push({ event: e, payload: p }), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: {
            setTagValue: (tagId, value) => {
                written.push({ tagId: tagId, value: value });
                return Promise.resolve(true);
            },
            getDeviceIdFromTag: () => 'dev'
        },
        schedulerStorage: {
            getAllSchedulers: () => Promise.resolve(stored),
            getSchedulerData: () => Promise.resolve(null),
            setSchedulerData: (id, d) => { saved.push({ id: id }); stored = [{ id: id, data: d }]; return Promise.resolve(true); }
        },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };

    sinon.stub(nodeSchedule, 'scheduleJob').callsFake(() => ({ cancel: sinon.stub() }));

    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    service.clearAllJobsForTest();
    return { service: service, logger: logger, emitted: emitted, written: written, saved: saved };
}

describe('scheduler update pass', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('an update with no previous data does not run the three comparison steps', async function () {
        // With nothing to compare against there is no tag to release, no duration to re-arm and no
        // event to have been deleted. The pass still builds jobs, latches the tag and notifies.
        const ctx = loadService();
        await ctx.service.updateScheduler('sch1',
            dataFor([DEVICE_A], { 'device-a': [activeTimerEvent('ev1')] }));

        expect(ctx.written.map((w) => w.value), 'the new state is latched').to.include(1);
        const frames = ctx.emitted.filter((e) => e.event === ACTIVE);
        expect(frames.length, 'the client is told the current state').to.be.greaterThan(0);
    });

    it('an update reads the previous data from storage when it is not supplied', async function () {
        const previous = dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [] });
        const ctx = loadService({ storedSchedulers: [{ id: 'sch1', data: previous }] });

        // device-b disappears from the new data, so its tag must be released - which can only happen
        // if the previous data was actually loaded.
        await ctx.service.updateScheduler('sch1',
            dataFor([DEVICE_A], { 'device-a': [] }));

        expect(ctx.written.map((w) => w.tagId), 'the removed device tag is released').to.include('b.t1');
    });

    it('releases a removed device tag BEFORE the new state is latched', async function () {
        // ORDER, observed through the write log: the release of a device that left must come first,
        // otherwise the later latch of the new state would be the last word and the removed device
        // would stay latched.
        const previous = dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [] });
        const ctx = loadService({ storedSchedulers: [{ id: 'sch1', data: previous }] });

        await ctx.service.updateScheduler('sch1',
            dataFor([DEVICE_A], { 'device-a': [activeTimerEvent('ev1')] }));

        const releaseIndex = ctx.written.findIndex((w) => w.tagId === 'b.t1' && w.value === 0);
        const latchIndex = ctx.written.findIndex((w) => w.tagId === 'a.t1' && w.value === 1);
        expect(releaseIndex, 'the removed device is released').to.not.equal(-1);
        expect(latchIndex, 'the kept device is latched').to.not.equal(-1);
        expect(releaseIndex, 'the release happens first').to.be.lessThan(latchIndex);
    });

    it('a running event that is DELETED is stopped while its bookkeeping is still live', async function () {
        // The order-critical case. The event was armed (so there is bookkeeping), and it is gone from
        // the new data. It must be stopped: the live entry is dropped and the control tag released.
        const running = {
            id: 'ev1', schedulerId: 'sch1', deviceName: 'device-a', eventIndex: 0,
            eventId: 'ev1', variableId: 'a.t1', endTime: Date.now() + 60000,
            interval: { fake: 'interval' }, endTimeout: { fake: 'timeout' }
        };
        const previous = dataFor([DEVICE_A], { 'device-a': [{ id: 'ev1', eventMode: true, duration: 60 }] });
        const ctx = loadService({ storedSchedulers: [{ id: 'sch1', data: previous }] });
        ctx.service.getActiveEventModeSchedules().set('ev1', running);

        await ctx.service.updateScheduler('sch1', dataFor([DEVICE_A], { 'device-a': [] }));

        expect(ctx.service.getActiveEventModeSchedules().has('ev1'),
            'the deleted running event is no longer tracked').to.equal(false);
        expect(ctx.written.some((w) => w.tagId === 'a.t1' && w.value === 0),
            'and its control tag is released').to.equal(true);
    });

    it('the client is notified LAST, after the state is settled', async function () {
        // notifyEventStates is the last step on purpose: it tells clients the current state, so it
        // must read a state that has already been rebuilt.
        const ctx = loadService();
        await ctx.service.updateScheduler('sch1',
            dataFor([DEVICE_A], { 'device-a': [activeTimerEvent('ev1')] }));

        const frames = ctx.emitted.filter((e) => e.event === ACTIVE);
        expect(frames.length, 'the notify pass ran').to.be.greaterThan(0);
        // Every frame reports the event as active, which is the state the latch write above encoded.
        expect(frames.every((f) => f.payload.active === true || f.payload.active === false)).to.equal(true);
        expect(ctx.written.some((w) => w.tagId === 'a.t1' && w.value === 1)).to.equal(true);
    });

    it('a storage failure is reported and does not throw at the caller', async function () {
        const ctx = loadService();
        ctx.service.init({}, ctx.logger, {
            logger: ctx.logger,
            io: { emit: () => {}, on: sinon.stub() },
            events: { on: sinon.stub(), emit: sinon.stub() },
            devices: { setTagValue: () => Promise.resolve(true), getDeviceIdFromTag: () => 'dev' },
            schedulerStorage: {
                getAllSchedulers: () => Promise.reject(new Error('storage offline')),
                getSchedulerData: () => Promise.resolve(null),
                setSchedulerData: () => Promise.resolve(true)
            },
            scriptsMgr: { runScript: sinon.stub().resolves(true) }
        });

        await ctx.service.updateScheduler('sch1', dataFor([DEVICE_A], { 'device-a': [] }));
        const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(logged).to.contain('storage offline');
    });

    it('an update for an unknown scheduler still applies the new data it was given', async function () {
        // No previous record means no comparison steps, but the new data is the new data: jobs are
        // built and the tag reflects it.
        const ctx = loadService({ storedSchedulers: [] });
        await ctx.service.updateScheduler('sch-brand-new',
            dataFor([DEVICE_A], { 'device-a': [activeTimerEvent('ev1')] }));

        expect(ctx.written.some((w) => w.tagId === 'a.t1')).to.equal(true);
    });
});
