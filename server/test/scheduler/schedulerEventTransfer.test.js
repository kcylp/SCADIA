'use strict';

/**
 * Moving a RUNNING Event Mode event from one device to another.
 *
 * Fifteenth file of scheduler coverage, and the last uncovered region of this module before the
 * update path itself. When a scheduler update moves an event-mode event to a different device, the
 * deletion pass sees it disappear from the old device. The naive reaction would be to treat it as a
 * deletion: cancel its jobs and stop it. That would silently kill an event that is RUNNING, and the
 * operator would see it vanish from the screen with the device still latched.
 *
 * So handleEventDeletions looks for the same event id under another device first. When it finds it:
 *   - it tells the client the OLD device's copy is no longer active (a "Transferred from" frame),
 *   - it moves the live bookkeeping to the new device (deviceName, eventIndex, variableId),
 *   - it does NOT cancel the jobs.
 *
 * The bookkeeping is REKEYED rather than recreated, which is the part worth pinning: the countdown
 * interval and the end timeout are the originals, so the event keeps counting down from where it was
 * rather than restarting.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');
const Events = require('../../runtime/events');

const ACTIVE = Events.IoEventTypes.SCHEDULER_ACTIVE;

const DEVICE_A = { name: 'device-a', variableId: 'a.t1' };
const DEVICE_B = { name: 'device-b', variableId: 'b.t1' };

function dataFor(devices, schedulesByDevice) {
    return { settings: { devices: devices }, schedules: schedulesByDevice || {} };
}

/** An event-mode event that is currently running, as the arm path leaves it. */
function runningEvent(id, device, index) {
    return {
        id: id,
        schedulerId: 'sch1',
        deviceName: device.name,
        eventIndex: index,
        eventId: id,
        variableId: device.variableId,
        endTime: Date.now() + 60000,
        interval: { fake: 'interval' },
        endTimeout: { fake: 'timeout' }
    };
}

function eventModeEvent(id) {
    return { id: id, eventMode: true, duration: 60, startTime: '08:00' };
}

function loadService(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const emitted = [];
    const cancelled = [];
    const runtime = {
        logger: logger,
        io: { emit: (e, p) => emitted.push({ event: e, payload: p }), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: {
            setTagValue: sinon.stub().resolves(true),
            getDeviceIdFromTag: () => 'dev'
        },
        schedulerStorage: {
            getAllSchedulers: sinon.stub().resolves([]),
            getSchedulerData: () => Promise.resolve(null),
            setSchedulerData: () => Promise.resolve(true)
        },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);

    // Jobs are registered through the module's own bookkeeping, with a cancelling double so the
    // "was it cancelled" question is answerable.
    service.clearAllJobsForTest();
    (opts.jobIds || []).forEach((jobId) => {
        service.registerJobForTest(jobId, { cancel() { cancelled.push(jobId); } });
    });

    return { service: service, logger: logger, emitted: emitted, cancelled: cancelled };
}

describe('scheduler event transfer between devices', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('a RUNNING event moved to another device is rekeyed, not cancelled', async function () {
        const ctx = loadService({
            jobIds: ['sch1_device-a_ev1_start', 'sch1_device-a_ev1_end']
        });
        const active = ctx.service.getActiveEventModeSchedules();
        active.set('ev1', runningEvent('ev1', DEVICE_A, 0));

        const summary = await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [eventModeEvent('ev1')] }));

        expect(summary.deleted, 'it still counts as a deletion from device-a').to.equal(1);
        expect(ctx.cancelled, 'its jobs must NOT be cancelled - the event is still running')
            .to.deep.equal([]);
        const moved = active.get('ev1');
        expect(moved, 'the bookkeeping is rekeyed under the same id').to.not.equal(undefined);
        expect(moved.deviceName, 'and moved to the new device').to.equal('device-b');
        expect(moved.variableId).to.equal('b.t1');
        // THE BUG THIS PINS: the index used to be looked up in the OLD device's new event list,
        // which no longer contains the event, so it was always -1 - while the countdown frames name
        // the NEW device. A client matching frames by (device, index) could not match any of them.
        expect(moved.eventIndex, 'and points at its index on the NEW device').to.equal(0);
        expect(moved.endTime, 'the ORIGINAL timeout is kept, not restarted').to.be.greaterThan(Date.now());
    });

    it('the old device is told its copy is no longer active', async function () {
        const ctx = loadService({ jobIds: [] });
        ctx.service.getActiveEventModeSchedules().set('ev1', runningEvent('ev1', DEVICE_A, 0));

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [eventModeEvent('ev1')] }));

        const frames = ctx.emitted.filter((e) => e.event === ACTIVE);
        expect(frames).to.have.length(1);
        expect(frames[0].payload.deviceName).to.equal('device-a');
        expect(frames[0].payload.active).to.equal(false);
        expect(frames[0].payload.eventData.label, 'the frame says what happened').to.contain('Transferred from');
    });

    it('an event that is NOT running on the old device is simply cancelled', async function () {
        // The contrast case: without live bookkeeping there is nothing to move, so the jobs go.
        const ctx = loadService({ jobIds: ['sch1_device-a_ev1_start', 'sch1_device-a_ev1_end'] });

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [eventModeEvent('ev1')] }));

        expect(ctx.cancelled.sort()).to.deep.equal(['sch1_device-a_ev1_end', 'sch1_device-a_ev1_start']);
        expect(ctx.emitted.filter((e) => e.event === ACTIVE)).to.deep.equal([]);
    });

    it('an event moved to a device with a DIFFERENT variable id follows the new tag', async function () {
        const ctx = loadService({ jobIds: [] });
        ctx.service.getActiveEventModeSchedules().set('ev1', runningEvent('ev1', DEVICE_A, 0));

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [eventModeEvent('ev1')] }));

        expect(ctx.service.getActiveEventModeSchedules().get('ev1').variableId).to.equal('b.t1');
    });

    it('a TIMER event moved to another device is not transferred, because it has no live timer', async function () {
        // Only event-mode events are transferred: a timer event is driven by clock rules, which are
        // rebuilt by the update path anyway.
        const ctx = loadService({ jobIds: ['sch1_device-a_ev2_start', 'sch1_device-a_ev2_end'] });
        const timer = { id: 'ev2', eventMode: false, startTime: '08:00', endTime: '09:00' };

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [timer] }),
            dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [timer] }));

        expect(ctx.cancelled.length, 'the old jobs are cancelled').to.equal(2);
    });

    it('a running event whose device was REMOVED entirely still stops cleanly', async function () {
        const ctx = loadService({ jobIds: ['sch1_device-a_ev1_start'] });
        ctx.service.getActiveEventModeSchedules().set('ev1', runningEvent('ev1', DEVICE_A, 0));

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([], {}));

        expect(ctx.cancelled, 'nothing to transfer to, so the job goes').to.deep.equal(['sch1_device-a_ev1_start']);
        expect(ctx.service.getActiveEventModeSchedules().has('ev1'),
            'and the live bookkeeping is dropped').to.equal(false);
    });

    it('the index follows the target device even when it is not the first event there', async function () {
        // A stronger form of the same assertion: put the matching event second on the new device and
        // require index 1, so a fix that merely defaulted to 0 would fail.
        const ctx = loadService({ jobIds: [] });
        ctx.service.getActiveEventModeSchedules().set('ev1', runningEvent('ev1', DEVICE_A, 0));

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([DEVICE_A, DEVICE_B], {
                'device-a': [],
                'device-b': [eventModeEvent('ev-other'), eventModeEvent('ev1')]
            }));

        expect(ctx.service.getActiveEventModeSchedules().get('ev1').eventIndex).to.equal(1);
    });

    it('a transferred event keeps counting down rather than restarting', async function () {
        const ctx = loadService({ jobIds: [] });
        const original = runningEvent('ev1', DEVICE_A, 0);
        original.endTime = Date.now() + 5000;
        ctx.service.getActiveEventModeSchedules().set('ev1', original);

        await ctx.service.handleEventDeletions('sch1',
            dataFor([DEVICE_A], { 'device-a': [eventModeEvent('ev1')] }),
            dataFor([DEVICE_A, DEVICE_B], { 'device-a': [], 'device-b': [eventModeEvent('ev1')] }));

        const moved = ctx.service.getActiveEventModeSchedules().get('ev1');
        expect(moved.endTime, 'the same end time, not a fresh 60 seconds').to.equal(original.endTime);
        expect(moved.interval, 'and the same interval handle').to.equal(original.interval);
        expect(moved.endTimeout).to.equal(original.endTimeout);
    });
});
