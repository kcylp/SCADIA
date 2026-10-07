'use strict';

/**
 * Deleting an event must release the device's master-control tag, and say so if it could not.
 *
 * Fifth file of scheduler coverage. `handleEventDeletions` compares the old and new scheduler data,
 * finds the events that disappeared, and for a device left with NO active event writes its tag to 0
 * - the same latch release batch 16 covered on the other path. Two of those writes discarded their
 * answer, so a refused release left the device latched with nothing to show for it.
 *
 * Scope note: this file covers the DATA DECISIONS of the deletion path - which events count as
 * deleted, when the tag is released, and what is reported. The job-cancellation and the
 * "event moved to another device" transfer are NOT covered here; they live in the same function and
 * are recorded as remaining work under N-29.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');
const Events = require('../../runtime/events');

const ACTIVE = Events.IoEventTypes.SCHEDULER_ACTIVE;

function loadService(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const writes = [];
    const emitted = [];
    const runtime = {
        logger: logger,
        io: {
            emit: (event, payload) => emitted.push({ event: event, payload: payload }),
            on: sinon.stub()
        },
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
    return { service: service, logger: logger, writes: writes, emitted: emitted };
}

/** Scheduler data with one device and a list of clock-driven events. */
function data(devices, schedulesByDevice) {
    return { settings: { devices: devices }, schedules: schedulesByDevice || {} };
}

function clockEvent(id, startTime, endTime) {
    // `days` matters: the "is anything still active" test is a day-of-week check followed by a time
    // window, so an event without today enabled is never active however wide its window is. My first
    // fixture omitted it and the device looked unlatched.
    const days = new Array(7).fill(false);
    days[new Date().getDay()] = true;
    return { id: id, eventMode: false, days: days, startTime: startTime, endTime: endTime };
}

/** An event that is active RIGHT NOW: today enabled, window built from the current clock. */
function activeNow(id) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const fmt = (m) => String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0') + ':' +
        String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0');
    return clockEvent(id, fmt(minutes - 5), fmt(minutes + 5));
}

const DEVICE_A = { name: 'device-a', variableId: 'a.t1' };

describe('scheduler event deletion releases the master-control tag', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('releases the tag when the device is left with no events at all', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00')] }),
            data([DEVICE_A], { 'device-a': [] }));

        expect(summary.deleted).to.equal(1);
        expect(ctx.writes, 'the latch must be released').to.deep.equal([{ tagId: 'a.t1', value: 0 }]);
        expect(summary.resets[0].applied).to.equal(true);
    });

    it('does NOT release the tag while another event on that device remains', async function () {
        // The device is still under scheduler control: releasing here would un-latch a device that
        // is still being driven. This is the boundary the whole function rests on.
        // The release test is "no remaining event is ACTIVE" (via checkIfAnyEventActive), not "no
        // remaining event exists", so the surviving event has to be inside its window right now -
        // which means today enabled AND the current minute inside start..end.
        const survives = activeNow('ev2');
        const ctx = loadService();
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00'), survives] }),
            data([DEVICE_A], { 'device-a': [survives] }));

        expect(summary.deleted).to.equal(1);
        expect(ctx.writes, 'one event is gone but the device still has an active window').to.deep.equal([]);
        expect(summary.resets).to.deep.equal([]);
    });

    it('and it DOES release when the surviving event is not currently active', async function () {
        // The release condition is about the DEVICE being unlatched, not about the event being
        // absent: a surviving event outside its window leaves the device with nothing to enforce.
        const survives = clockEvent('ev2', '20:00', '20:01');
        const ctx = loadService();
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00'), survives] }),
            data([DEVICE_A], { 'device-a': [survives] }));

        expect(summary.deleted).to.equal(1);
        const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
        const inWindow = nowMinutes >= 20 * 60 && nowMinutes < 20 * 60 + 1;
        expect(ctx.writes.length, 'now is minute ' + nowMinutes).to.equal(inWindow ? 0 : 1);
    });

    it('an event that is still present is not a deletion', async function () {
        const ctx = loadService();
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00')] }),
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '10:00')] }));

        expect(summary.deleted).to.equal(0);
        expect(ctx.writes).to.deep.equal([]);
    });

    it('a device removed from the scheduler counts its events AND writes the tag', async function () {
        // Measured, and it corrected TWO of my assumptions in a row.
        //   1. The maps are built from settings.devices, so a removed device's events count as deleted.
        //   2. The tag IS written here: newEventsByDevice has no entry for the device, so
        //      newDeviceEvents is empty, checkIfAnyEventActive([]) is false, and the release runs.
        // handleTagChanges (batch 16) also writes it, because the runtime calls both. The duplicate
        // is harmless - setting the same tag to 0 twice is idempotent and both paths report it - but
        // "only one of them writes" was wrong, and this test records what actually happens.
        const ctx = loadService();
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00')] }),
            data([], {}));

        expect(summary.deleted).to.equal(1);
        expect(ctx.writes).to.deep.equal([{ tagId: 'a.t1', value: 0 }]);
    });

    it('missing old or new data is not an error and deletes nothing', async function () {
        const ctx = loadService();
        for (const [oldData, newData] of [
            [undefined, data([DEVICE_A], {})],
            [data([DEVICE_A], {}), undefined],
            [null, null],
            [{ settings: {} }, data([DEVICE_A], {})]
        ]) {
            const summary = await ctx.service.handleEventDeletions('sch1', oldData, newData);
            expect(summary.deleted).to.equal(0);
        }
        expect(ctx.writes).to.deep.equal([]);
    });

    it('a REFUSED release is reported, with the device and the tag', async function () {
        const ctx = loadService({ writeResult: false });
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00')] }),
            data([DEVICE_A], { 'device-a': [] }));

        expect(summary.resets[0].applied).to.equal(false);
        expect(summary.resets[0].variableId).to.equal('a.t1');
        const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(logged, 'a refused release leaves a trace through writeTagFromEvent').to.contain('Event deletion');
    });

    it('a throwing release does not abort the caller', async function () {
        const ctx = loadService({ writeThrows: true });
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A], { 'device-a': [clockEvent('ev1', '08:00', '09:00')] }),
            data([DEVICE_A], { 'device-a': [] }));

        expect(summary.resets[0].applied).to.equal(false);
        expect(ctx.logger.error.callCount).to.be.greaterThan(0);
    });

    it('deletions on two devices are both counted', async function () {
        const ctx = loadService();
        const deviceB = { name: 'device-b', variableId: 'b.t1' };
        const summary = await ctx.service.handleEventDeletions('sch1',
            data([DEVICE_A, deviceB], {
                'device-a': [clockEvent('ev1', '08:00', '09:00')],
                'device-b': [clockEvent('ev2', '08:00', '09:00')]
            }),
            data([DEVICE_A, deviceB], { 'device-a': [], 'device-b': [] }));

        expect(summary.deleted).to.equal(2);
        expect(ctx.writes.map((w) => w.tagId).sort()).to.deep.equal(['a.t1', 'b.t1']);
        expect(ctx.writes.every((w) => w.value === 0)).to.equal(true);
    });
});
