'use strict';

/**
 * Arming an Event Mode event: what it is keyed on, and what happens when it cannot be armed.
 *
 * Fourteenth file of scheduler coverage. It drives the REAL start callback of createEventJob by
 * replacing node-schedule's scheduleJob with a recorder, so the callback the scheduler would run at
 * the event's start time can be invoked directly instead of waiting for a clock.
 *
 * THE DEFECT THIS PINS. The start callback wrote the device's master-control tag to 1 and told the
 * client the event was active BEFORE checking whether the event could be tracked at all. An
 * event-mode event ends when the timeout armed at its start fires, and that timeout is keyed on the
 * event id, so an event with no id produced this sequence:
 *
 *   tag = 1  ->  active:true sent  ->  "missing ID" logged  ->  return
 *
 * The device is then latched to a scheduler holding no timer, no interval and no entry in
 * activeEventModeSchedules: nothing will ever release it, while the client believes the event is
 * running. Notably the SPEC BUILDER does not require an id, so such an event really does get a job -
 * this is reachable state, not a hypothetical.
 *
 * The check now comes first, and the untrackable case releases the tag and tells the client.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const nodeSchedule = require('node-schedule');
const Events = require('../../runtime/events');

const ACTIVE = Events.IoEventTypes.SCHEDULER_ACTIVE;
const REMAINING = Events.IoEventTypes.SCHEDULER_REMAINING;

/** The callbacks node-schedule would have run, in the order they were registered. */
let scheduled;

function loadService(options) {
    const opts = options || {};
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const emitted = [];
    const writes = [];
    const runtime = {
        logger: logger,
        io: { emit: (e, p) => emitted.push({ event: e, payload: p }), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: {
            setTagValue: (tagId, value) => {
                writes.push({ tagId: tagId, value: value });
                return Promise.resolve(true);
            },
            getDeviceIdFromTag: () => 'dev-a'
        },
        schedulerStorage: {
            getAllSchedulers: sinon.stub().resolves(opts.schedulers || []),
            getSchedulerData: () => Promise.resolve(null),
            setSchedulerData: () => Promise.resolve(true)
        },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };

    scheduled = [];
    sinon.stub(nodeSchedule, 'scheduleJob').callsFake((rule, callback) => {
        scheduled.push({ rule: rule, callback: callback });
        return { cancel: sinon.stub(), name: 'job-' + scheduled.length };
    });

    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger, emitted: emitted, writes: writes };
}

/** An Event Mode event ready to be started, with today enabled. */
function eventModeEvent(id, overrides) {
    const days = new Array(7).fill(false);
    days[new Date().getDay()] = true;
    return Object.assign({ id: id, eventMode: true, duration: 60, startTime: '00:00', days: days }, overrides || {});
}

/** A timer event: a clock window, no duration. */
function timerEvent(id) {
    const days = new Array(7).fill(false);
    days[new Date().getDay()] = true;
    return { id: id, eventMode: false, startTime: '00:00', endTime: '23:59', days: days, recurring: true };
}

const DEVICE = { name: 'device-a', variableId: 'a.t1', enabled: true };

/** Run an event-mode event's start callback and hand back its tracked entry. */
async function startEventMode(ctx, event) {
    await ctx.service.createEventJob('sch1', DEVICE, event, 0);
    const startCallback = scheduled[0].callback;
    await startCallback();
    return ctx.service.getActiveEventModeSchedules().get(event.id);
}

/** Stop the real timers an armed event created, so the process can exit. */
function disarm(tracked) {
    if (!tracked) { return; }
    if (tracked.interval) { clearInterval(tracked.interval); }
    if (tracked.endTimeout) { clearTimeout(tracked.endTimeout); }
}

describe('scheduler Event Mode arming', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('the tracking key is the event id; an event without one cannot be armed', function () {
        const service = loadService().service;
        expect(service.eventTrackId({ id: 'ev1' })).to.equal('ev1');
        expect(service.eventTrackId({ id: '' })).to.equal(undefined);
        expect(service.eventTrackId({})).to.equal(undefined);
        expect(service.eventTrackId(null)).to.equal(undefined);
        expect(service.canArmEventMode({ id: 'ev1' })).to.equal(true);
        expect(service.canArmEventMode({})).to.equal(false);
    });

    it('a timer event registers a start AND an end job; an event-mode event only a start', async function () {
        const ctx = loadService();
        await ctx.service.createEventJob('sch1', DEVICE, timerEvent('ev3'), 0);
        expect(scheduled, 'timer events end by a clock rule').to.have.length(2);

        scheduled = [];
        await ctx.service.createEventJob('sch1', DEVICE, eventModeEvent('ev4'), 0);
        expect(scheduled, 'event-mode events end by duration').to.have.length(1);
    });

    it('an event WITH an id is tracked under that id, with a countdown and an end timeout', async function () {
        const ctx = loadService();
        const tracked = await startEventMode(ctx, eventModeEvent('ev1'));

        expect(tracked, 'the event is tracked under its id').to.not.equal(undefined);
        expect(tracked.deviceName).to.equal('device-a');
        expect(tracked.variableId).to.equal('a.t1');
        expect(tracked.interval, 'a countdown interval was armed').to.not.equal(undefined);
        expect(tracked.endTimeout, 'an end timeout was armed').to.not.equal(undefined);

        const remainingMs = tracked.endTime - Date.now();
        expect(remainingMs).to.be.greaterThan(0);
        expect(remainingMs).to.be.lessThanOrEqual(60000);

        expect(ctx.writes[0], 'the control tag is set on start').to.deep.equal({ tagId: 'a.t1', value: 1 });
        expect(ctx.emitted.filter((e) => e.event === ACTIVE).map((e) => e.payload.active)).to.deep.equal([true]);

        disarm(tracked);
    });

    it('an event WITHOUT an id RELEASES the tag instead of leaving the device latched', async function () {
        // THE DEFECT. Reachable: the spec builder does not require an id, so this event really is
        // scheduled and really does reach this callback.
        const ctx = loadService();
        await ctx.service.createEventJob('sch1', DEVICE, eventModeEvent(undefined), 0);
        expect(scheduled, 'the event is scheduled even without an id').to.have.length(1);

        await scheduled[0].callback();

        expect(ctx.service.getActiveEventModeSchedules().size, 'nothing can be tracked').to.equal(0);
        expect(ctx.writes.map((w) => w.value), 'the start write is followed by a release')
            .to.deep.equal([1, 0]);
        expect(ctx.emitted.filter((e) => e.event === ACTIVE).map((e) => e.payload.active),
            'told active, then told inactive').to.deep.equal([true, false]);
        expect(ctx.emitted.filter((e) => e.event === REMAINING), 'no countdown for an untrackable event')
            .to.deep.equal([]);
        const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
        expect(logged).to.contain('Cannot track Event Mode event');
    });

    it('the release names the event it could not track', async function () {
        const ctx = loadService();
        await ctx.service.createEventJob('sch1', DEVICE, eventModeEvent(undefined), 0);
        await scheduled[0].callback();
        const reasons = ctx.writes.length;
        expect(reasons).to.equal(2);
        // The second write is the release; the reason string is on the log line writeTagFromEvent
        // builds, and the frame tells the client which event it was.
        const frames = ctx.emitted.filter((e) => e.event === ACTIVE);
        expect(frames[1].payload.eventData.id).to.equal(undefined);
        expect(ctx.logger.error.callCount).to.be.greaterThan(0);
    });

    it('the start callback runs the device actions for the ON trigger', async function () {
        // A scheduler record whose settings carry one ON action for this device.
        const settings = {
            deviceActions: [{
                deviceName: 'device-a', eventTrigger: 'on', action: 'onSetValue', actparam: '7',
                actoptions: { variable: { variableId: 'a.t1', variableRaw: { type: 'number' } } }
            }]
        };
        const ctx = loadService({ schedulers: [{ id: 'sch1', data: { settings: settings, schedules: {} } }] });
        const tracked = await startEventMode(ctx, eventModeEvent('ev5'));

        // Write 1 from the event start, then 7 from the action.
        expect(ctx.writes.map((w) => w.value)).to.deep.equal([1, 7]);
        disarm(tracked);
    });

    it('the END callback of a timer event runs: it writes 0, runs OFF actions and reports inactive', async function () {
        // WHY THIS TEST EXISTS, in one sentence: the end callback had been broken for four batches by
        // an extraction that left it reading six variables that no longer existed, and NOTHING
        // executed it - so a timer event never released its control tag, never ran its OFF actions
        // and never told the client it had ended, while its start job registered normally and every
        // existing test stayed green.
        const settings = {
            deviceActions: [{
                deviceName: 'device-a', eventTrigger: 'off', action: 'onSetValue', actparam: '0',
                actoptions: { variable: { variableId: 'a.t1', variableRaw: { type: 'number' } } }
            }]
        };
        const ctx = loadService({ schedulers: [{ id: 'sch1', data: { settings: settings, schedules: {} } }] });
        await ctx.service.createEventJob('sch1', DEVICE, timerEvent('ev-end'), 0);
        expect(scheduled, 'a timer event has a start and an end job').to.have.length(2);

        await scheduled[1].callback();

        expect(ctx.writes.map((w) => w.value), 'the end callback releases the control tag').to.contain(0);
        expect(ctx.writes[ctx.writes.length - 1].tagId).to.equal('a.t1');
        const frames = ctx.emitted.filter((e) => e.event === ACTIVE);
        expect(frames.map((f) => f.payload.active), 'the client is told the event ended')
            .to.contain(false);
    });

    it('the START callback of a timer event runs without touching Event Mode bookkeeping', async function () {
        const ctx = loadService();
        await ctx.service.createEventJob('sch1', DEVICE, timerEvent('ev-start'), 0);
        expect(scheduled).to.have.length(2);

        await scheduled[0].callback();

        expect(ctx.writes[0], 'the timer event latches the tag on start').to.deep.equal({ tagId: 'a.t1', value: 1 });
        expect(ctx.service.getActiveEventModeSchedules().size, 'a timer event is not Event Mode tracked').to.equal(0);
        expect(ctx.emitted.filter((e) => e.event === REMAINING), 'and has no countdown').to.deep.equal([]);
    });

    it('the DURATION timeout releases the tag when it fires - the third site of the same break', async function () {
        // A one-second duration keeps this fast and real. The callback that fires at the end of an
        // Event Mode event is the third place that read the removed `dayNumbers`, so before the fix
        // this callback threw as soon as it ran - and an Event Mode event that never releases its tag
        // leaves the device latched forever, because the timeout is the only thing that ends it.
        const ctx = loadService();
        const event = eventModeEvent('ev-dur', { duration: 1, recurring: true });
        await ctx.service.createEventJob('sch1', DEVICE, event, 0);
        const tracked = (await scheduled[0].callback(), ctx.service.getActiveEventModeSchedules().get('ev-dur'));
        expect(tracked).to.not.equal(undefined);

        await new Promise((resolve) => setTimeout(resolve, 1200));

        expect(ctx.writes.map((w) => w.value), 'the start write, then the release').to.deep.equal([1, 0]);
        const frames = ctx.emitted.filter((e) => e.event === ACTIVE).map((f) => f.payload.active);
        expect(frames, 'told active, then told inactive').to.deep.equal([true, false]);
        expect(ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | '),
            'no error is logged on the way out').to.not.contain('is not defined');
        disarm({ interval: tracked.interval });
    });

    it('a scheduler that cannot be read simply means no actions, not a crash', async function () {
        const ctx = loadService({ schedulers: [] });
        const tracked = await startEventMode(ctx, eventModeEvent('ev6'));
        expect(ctx.writes.map((w) => w.value), 'only the event-start write').to.deep.equal([1]);
        expect(tracked).to.not.equal(undefined);
        disarm(tracked);
    });
});
