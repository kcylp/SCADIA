'use strict';

/**
 * Whether an event schedules at all, and with which indices - decided here, tested here.
 *
 * Sixth file of scheduler coverage. `buildEventScheduleSpec` is the first ~100 lines of
 * `createEventJob` (374 lines, the largest uncovered unit in the file), extracted so the decision
 * "does this event get a job" can be tested without standing up node-schedule and a storage backend.
 *
 * TWO THINGS THIS PINS DOWN
 *
 *   1. THE VALIDATION LADDER. An event that fails here gets NO job and NO error - it simply never
 *      runs. So every refusal is a silent failure in the field, and each one has to be deliberate.
 *      Note the ladder changes with `isEventMode`: an event-mode event needs a positive duration and
 *      no end time; a timer-mode event needs an end time.
 *
 *   2. THE INDEX BASES. The client sends BOOLEAN ARRAYS; node-schedule wants index lists. Only
 *      daysOfMonth is shifted (the array is 0-based, the field is 1-31); days and months are passed
 *      through as-is. That asymmetry is the classic off-by-one waiting to happen.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');

/** The spec builder only needs a logger, and the module reads it from init(). */
function loadService() {
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const runtime = { logger: logger, io: { emit: sinon.stub(), on: sinon.stub() }, events: { on: sinon.stub(), emit: sinon.stub() } };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger };
}

/** A timer-mode event that schedules: day 0 selected, 08:30 to 09:00. */
function timerEvent(overrides) {
    const days = new Array(7).fill(false);
    days[0] = true;
    return Object.assign({
        days: days,
        monthMode: false,
        startTime: '08:30',
        endTime: '09:00'
    }, overrides || {});
}

describe('scheduler recurrence spec (does this event get a job at all)', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    describe('the happy path', () => {
        it('a timer event with one day selected produces a weekday rule at its start time', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(timerEvent(), false);
            expect(spec).to.not.equal(null);
            expect(spec.isMonthMode).to.equal(false);
            expect(spec.dayNumbers).to.deep.equal([0]);
            expect(spec.startHour).to.equal(8);
            expect(spec.startMin).to.equal(30);
        });

        it('days are passed through with the SAME base as sent', function () {
            const ctx = loadService();
            const days = [true, false, true, false, true, false, true];
            const spec = ctx.service.buildEventScheduleSpec(timerEvent({ days: days }), false);
            expect(spec.dayNumbers).to.deep.equal([0, 2, 4, 6]);
        });

        it('an event-mode event needs a duration and NO end time', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(
                { days: [true, false, false, false, false, false, false], startTime: '10:00', eventMode: true, duration: 60 },
                true);
            expect(spec).to.not.equal(null);
            expect(spec.startHour).to.equal(10);
        });

        it('the spec carries BOTH the start and the end time, since two rules are built from it', function () {
            // THE REGRESSION THIS EXISTS FOR: when the rule-building was extracted out of
            // createEventJob (batch 18), the end rule kept reading isMonthMode / monthNumbers /
            // dayOfMonthNumbers / endHour / endMin - names that no longer existed in that scope. The
            // start job was built fine, so nothing looked wrong; the END job threw
            // "isMonthMode is not defined" into a catch that logged it. A timer event therefore never
            // got an end job, so it never wrote its tag back to 0 and never ran its OFF actions.
            // node --check cannot see an undefined identifier, so this has to be asserted.
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(timerEvent({ startTime: '08:30', endTime: '17:45' }), false);
            expect(spec.startHour).to.equal(8);
            expect(spec.startMin).to.equal(30);
            expect(spec.endHour, 'the end rule needs its own hour, parsed in the same place').to.equal(17);
            expect(spec.endMin).to.equal(45);
        });

        it('an event-mode event has no end time to carry, and says so by leaving it undefined', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(
                { days: [true, false, false, false, false, false, false], startTime: '10:00', eventMode: true, duration: 60 }, true);
            expect(spec.endHour).to.equal(undefined);
            expect(spec.endMin).to.equal(undefined);
        });

        it('a midnight start is parsed as 0:00, not as a missing value', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(timerEvent({ startTime: '00:00', endTime: '06:00' }), false);
            expect(spec.startHour).to.equal(0);
            expect(spec.startMin).to.equal(0);
        });
    });

    describe('the validation ladder - every refusal is a silent no-job', () => {
        it('refuses an event with neither days nor month mode', function () {
            const ctx = loadService();
            expect(ctx.service.buildEventScheduleSpec(timerEvent({ days: undefined, monthMode: false }), false)).to.equal(null);
        });

        it('refuses month mode without months, and month mode without daysOfMonth', function () {
            const ctx = loadService();
            const base = timerEvent({ monthMode: true, months: [true, false, false, false, false, false, false, false, false, false, false, false], daysOfMonth: new Array(31).fill(false) });
            base.daysOfMonth[0] = true;
            expect(ctx.service.buildEventScheduleSpec(Object.assign({}, base, { months: undefined }), false)).to.equal(null);
            expect(ctx.service.buildEventScheduleSpec(Object.assign({}, base, { daysOfMonth: undefined }), false)).to.equal(null);
        });

        it('refuses an event with no startTime', function () {
            const ctx = loadService();
            expect(ctx.service.buildEventScheduleSpec(timerEvent({ startTime: undefined }), false)).to.equal(null);
        });

        it('refuses a TIMER event with no endTime', function () {
            const ctx = loadService();
            expect(ctx.service.buildEventScheduleSpec(timerEvent({ endTime: undefined }), false)).to.equal(null);
        });

        it('but an EVENT-MODE event is fine without an endTime', function () {
            // The ladder is mode-dependent: this is the pair that a single unconditional check
            // would get wrong in one direction or the other.
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(
                { days: [true, false, false, false, false, false, false], startTime: '10:00', eventMode: true, duration: 30 }, true);
            expect(spec).to.not.equal(null);
        });

        it('refuses an EVENT-MODE event with no duration, zero duration or a negative one', function () {
            const ctx = loadService();
            const base = { days: [true, false, false, false, false, false, false], startTime: '10:00', eventMode: true };
            expect(ctx.service.buildEventScheduleSpec(Object.assign({}, base), true)).to.equal(null);
            expect(ctx.service.buildEventScheduleSpec(Object.assign({}, base, { duration: 0 }), true)).to.equal(null);
            expect(ctx.service.buildEventScheduleSpec(Object.assign({}, base, { duration: -5 }), true)).to.equal(null);
        });

        it('refuses malformed start times', function () {
            const ctx = loadService();
            for (const startTime of ['08', '08:30:00', 'aa:bb', ':30', '08:']) {
                expect(ctx.service.buildEventScheduleSpec(timerEvent({ startTime: startTime }), false),
                    'startTime ' + JSON.stringify(startTime)).to.equal(null);
            }
        });

        it('refuses malformed end times on a timer event', function () {
            const ctx = loadService();
            for (const endTime of ['09', 'aa:bb', '09:00:00']) {
                expect(ctx.service.buildEventScheduleSpec(timerEvent({ endTime: endTime }), false),
                    'endTime ' + JSON.stringify(endTime)).to.equal(null);
            }
        });

        it('refuses an event with no days selected at all', function () {
            const ctx = loadService();
            expect(ctx.service.buildEventScheduleSpec(timerEvent({ days: new Array(7).fill(false) }), false)).to.equal(null);
        });

        it('refuses month mode with months but no day of month selected, and warns', function () {
            const ctx = loadService();
            const months = new Array(12).fill(false);
            months[3] = true;
            const spec = ctx.service.buildEventScheduleSpec(timerEvent({
                monthMode: true, months: months, daysOfMonth: new Array(31).fill(false)
            }), false);
            expect(spec).to.equal(null);
            expect(ctx.logger.warn.callCount, 'a month-mode refusal says so out loud').to.equal(1);
        });

        it('refuses null rather than throwing', function () {
            const ctx = loadService();
            expect(ctx.service.buildEventScheduleSpec(null, false)).to.equal(null);
            expect(ctx.service.buildEventScheduleSpec(undefined, true)).to.equal(null);
        });
    });

    describe('month mode and the index bases', () => {
        function monthEvent() {
            const months = new Array(12).fill(false);
            months[0] = true;
            months[11] = true;
            const daysOfMonth = new Array(31).fill(false);
            daysOfMonth[0] = true;   // 1st
            daysOfMonth[30] = true;  // 31st
            return timerEvent({ monthMode: true, months: months, daysOfMonth: daysOfMonth });
        }

        it('months keep their base (0-11, January is 0)', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(monthEvent(), false);
            expect(spec.isMonthMode).to.equal(true);
            expect(spec.monthNumbers).to.deep.equal([0, 11]);
        });

        it('daysOfMonth are SHIFTED by one (array is 0-based, field is 1-31)', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(monthEvent(), false);
            expect(spec.dayOfMonthNumbers, 'the 1st is index 0 and must come out as 1').to.deep.equal([1, 31]);
        });

        it('in month mode the weekday list is not used even when days is present', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(monthEvent(), false);
            expect(spec.dayNumbers, 'days is mapped but must not drive the rule in month mode').to.deep.equal([0]);
            expect(spec.isMonthMode).to.equal(true);
        });

        it('a non-array days/months/daysOfMonth is treated as empty, not as a crash', function () {
            const ctx = loadService();
            const spec = ctx.service.buildEventScheduleSpec(timerEvent({ days: 'monday' }), false);
            expect(spec, 'a string of days is not a selection, so there is nothing to schedule').to.equal(null);
        });
    });
});
