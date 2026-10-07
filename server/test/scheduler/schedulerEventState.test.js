'use strict';

/**
 * The event-state broadcast, and the week-edge helper - third file of scheduler coverage.
 *
 * scheduler-service.js had no test that executed it at all. Batch 13 covered the action executor,
 * batch 14 master control; this covers the state path that runs every time a scheduler job fires:
 *
 *   checkAndNotifyEventState(...)  decides active/inactive and emits SCHEDULER_ACTIVE (and, for a
 *                                  duration event, SCHEDULER_REMAINING). It is what the big screen's
 *                                  scheduler widget listens to.
 *   isLastDayOfWeekForEvent(...)   the "is this the last scheduled day this week" test.
 *
 * Both read the clock themselves. Neither gets a clock injected: that would mean changing a
 * production signature to suit a test. Fixtures are computed from the same clock reading instead.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');
const Events = require('../../runtime/events');

const ACTIVE = Events.IoEventTypes.SCHEDULER_ACTIVE;
const REMAINING = Events.IoEventTypes.SCHEDULER_REMAINING;

function nowParts() {
    const now = new Date();
    return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
}

function clock(minutes) {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return String(Math.floor(wrapped / 60)).padStart(2, '0') + ':' + String(wrapped % 60).padStart(2, '0');
}

/** A runtime with a recording io, loaded through the module's own init(). */
function loadService() {
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const emitted = [];
    const runtime = {
        logger: logger,
        io: {
            emit: (event, payload) => emitted.push({ event: event, payload: payload }),
            on: sinon.stub()
        },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: {
            setTagValue: sinon.stub().resolves(true),
            getDeviceIdFromTag: sinon.stub().returns('dev-a')
        },
        schedulerStorage: { getAllSchedulers: sinon.stub().resolves([]) },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger, emitted: emitted };
}

/** The last SCHEDULER_ACTIVE payload that was emitted. */
function lastActive(emitted) {
    const hits = emitted.filter((e) => e.event === ACTIVE);
    return hits.length ? hits[hits.length - 1].payload : null;
}

describe('scheduler event state broadcast', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    describe('checkAndNotifyEventState - clock-driven events', () => {
        const device = { name: 'dev-a' };
        const p = nowParts();
        // checkAndNotifyEventState is handed a list of day NUMBERS (setInitialStates maps the
        // client's boolean array to indices before calling it), so the fixture is a number list.
        const todayOnly = [p.day];

        function timedEvent(startOffset, endOffset) {
            return {
                id: 'ev-1',
                eventMode: false,
                startTime: clock(p.minutes + startOffset),
                endTime: clock(p.minutes + endOffset)
            };
        }

        it('reports ACTIVE for an event covering now, with the identifying fields', function () {
            const ctx = loadService();
            ctx.service.checkAndNotifyEventState('sch1', device, timedEvent(-30, 30), 2, todayOnly);

            const payload = lastActive(ctx.emitted);
            expect(payload).to.not.equal(null);
            expect(payload.active).to.equal(true);
            expect(payload.schedulerId).to.equal('sch1');
            expect(payload.deviceName).to.equal('dev-a');
            expect(payload.eventIndex).to.equal(2);
            expect(payload.eventId).to.equal('ev-1');
        });

        it('reports INACTIVE for an event whose window is later today', function () {
            const ctx = loadService();
            ctx.service.checkAndNotifyEventState('sch1', device, timedEvent(60, 120), 0, todayOnly);
            expect(lastActive(ctx.emitted).active).to.equal(false);
        });

        it('reports INACTIVE when today is not a scheduled day, whatever the time is', function () {
            const ctx = loadService();
            const otherDays = [(p.day + 1) % 7];
            ctx.service.checkAndNotifyEventState('sch1', device, timedEvent(-30, 30), 0, otherDays);
            expect(lastActive(ctx.emitted).active).to.equal(false);
        });

        it('emits NOTHING for an event with no endTime when today is a scheduled day', function () {
            const ctx = loadService();
            const noEnd = timedEvent(-30, 30);
            delete noEnd.endTime;
            ctx.service.checkAndNotifyEventState('sch1', device, noEnd, 0, todayOnly);
            expect(ctx.emitted, 'no endTime means no window, so this branch bails before emitting')
                .to.deep.equal([]);
        });

        it('but it DOES emit INACTIVE for such an event when today is not scheduled', function () {
            // Measured, not assumed: the day check comes FIRST, so an unscheduled day answers
            // INACTIVE and returns before the missing endTime is ever looked at. The two orders give
            // different wire traffic for the same malformed event, and that is worth pinning so a
            // later reordering is a deliberate act.
            const ctx = loadService();
            const noEnd = timedEvent(-30, 30);
            delete noEnd.endTime;
            const otherDays = [(p.day + 1) % 7];
            ctx.service.checkAndNotifyEventState('sch1', device, noEnd, 0, otherDays);
            expect(ctx.emitted).to.have.length(1);
            expect(lastActive(ctx.emitted).active).to.equal(false);
        });

        it('an overnight window covering now is active', function () {
            const ctx = loadService();
            const overnight = { id: 'ev-2', eventMode: false, startTime: '23:00', endTime: '01:00' };
            ctx.service.checkAndNotifyEventState('sch1', device, overnight, 0, todayOnly);
            const expected = (p.minutes >= 23 * 60) || (p.minutes < 60);
            expect(lastActive(ctx.emitted).active, 'now is ' + clock(p.minutes)).to.equal(expected);
        });
    });

    describe('checkAndNotifyEventState - EVENT MODE events', () => {
        const device = { name: 'dev-a' };

        it('an event-mode event with no id is reported inactive', function () {
            const ctx = loadService();
            ctx.service.checkAndNotifyEventState('sch1', device, { eventMode: true }, 0, []);
            expect(lastActive(ctx.emitted).active).to.equal(false);
        });

        it('an event-mode event that has never been armed is reported inactive', function () {
            const ctx = loadService();
            ctx.service.checkAndNotifyEventState('sch1', device, { eventMode: true, id: 'never-armed' }, 0, []);
            expect(lastActive(ctx.emitted).active).to.equal(false);
        });

        it('an event-mode event never emits a remaining-time frame it has no basis for', function () {
            const ctx = loadService();
            ctx.service.checkAndNotifyEventState('sch1', device,
                { eventMode: true, id: 'ev-x', duration: 60 }, 0, []);
            expect(ctx.emitted.filter((e) => e.event === REMAINING)).to.deep.equal([]);
        });
    });

    describe('isLastDayOfWeekForEvent', () => {
        it('is true when today is the only remaining scheduled day', async function () {
            expect(await scheduler.isLastDayOfWeekForEvent([], 3)).to.equal(true);
            expect(await scheduler.isLastDayOfWeekForEvent([2], 3)).to.equal(true);
            expect(await scheduler.isLastDayOfWeekForEvent([1, 2], 3)).to.equal(true);
        });

        it('is false when a later day this week is also scheduled', async function () {
            expect(await scheduler.isLastDayOfWeekForEvent([4], 3)).to.equal(false);
            expect(await scheduler.isLastDayOfWeekForEvent([1, 4, 5], 3)).to.equal(false);
        });

        it('a day EARLIER in the week does not count as remaining', async function () {
            // The filter is day >= currentDay, so Monday (1) is not "remaining" on Wednesday (3).
            expect(await scheduler.isLastDayOfWeekForEvent([1], 3)).to.equal(true);
        });

        it('an event with NO scheduled days answers true', async function () {
            // Measured, and worth knowing: the empty list makes remainingDays empty, and the early
            // return answers true. So an event with nothing selected is treated as "the last day of
            // the week" - which is what arms the weekly-completion path. Recorded as-is rather than
            // "fixed" here: whether it should be false is a product decision, and this test exists
            // so the decision is visible.
            expect(await scheduler.isLastDayOfWeekForEvent([], 0)).to.equal(true);
        });
    });
});
