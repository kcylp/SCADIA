'use strict';

/**
 * Master control: the time-window decision, and the write it drives.
 *
 * Second file of coverage for runtime/scheduler/scheduler-service.js, which had none. Batch 13
 * covered the action executor; this one covers the two pieces the tag-change path runs through:
 *
 *   checkIfAnyEventActive(schedules)  the pure decision - "is any schedule of this device active
 *                                     right now". It is the input to master control, it has
 *                                     midnight-wrapping arithmetic, and it had never been called
 *                                     from a test.
 *   writeTagFromEvent(tagId, value)   the effect, plus the loop break that makes it safe to call.
 *
 * WHAT THE TESTS FOUND
 *
 *   - writeTagFromEvent swallowed a REFUSED write: setTagValue resolves false rather than throwing,
 *     and that path logged nothing and published nothing. Same defect class as the action handlers
 *     (batch 13). It now logs, names the reason, and returns a boolean.
 *
 * TIME IS NOT MOCKED, and that is deliberate. checkIfAnyEventActive reads the clock itself, and
 * injecting a clock would mean changing a production signature to suit a test. Instead the fixtures
 * are computed from the SAME clock reading, so every case is deterministic without touching
 * production code: a case that must match is built for today, and a case that must not match is
 * built for tomorrow (or for a window that cannot contain now).
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');

/** The clock readings the function under test uses, computed the same way. */
function nowParts() {
    const now = new Date();
    return {
        day: now.getDay(),
        month: now.getMonth(),
        date: now.getDate(),
        minutes: now.getHours() * 60 + now.getMinutes()
    };
}

/** "HH:MM" for a minute-of-day, wrapping into the next day. */
function clock(minutes) {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    const h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/** A schedule that contains RIGHT NOW, or one that does not. */
function scheduleContainingNow(include) {
    const p = nowParts();
    // checkIfAnyEventActive indexes the client's boolean array: days[currentDay] !== true.
    const days = new Array(7).fill(false);
    days[p.day] = true;
    return {
        days: days,
        monthMode: false,
        eventMode: false,
        startTime: include ? clock(p.minutes - 30) : clock(p.minutes + 60),
        endTime: include ? clock(p.minutes + 30) : clock(p.minutes + 120)
    };
}

describe('scheduler master control', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    describe('checkIfAnyEventActive', () => {
        it('is false for nothing, an empty list or a non-list', function () {
            expect(scheduler.checkIfAnyEventActive(undefined)).to.equal(false);
            expect(scheduler.checkIfAnyEventActive(null)).to.equal(false);
            expect(scheduler.checkIfAnyEventActive([])).to.equal(false);
        });

        it('is true when an event covers the current moment', function () {
            expect(scheduler.checkIfAnyEventActive([scheduleContainingNow(true)])).to.equal(true);
        });

        it('is false when every event is outside the current window', function () {
            expect(scheduler.checkIfAnyEventActive([scheduleContainingNow(false)])).to.equal(false);
        });

        it('only looks at events marked for TODAY', function () {
            const p = nowParts();
            const wrongDay = scheduleContainingNow(true);
            wrongDay.days = new Array(7).fill(false);
            wrongDay.days[(p.day + 1) % 7] = true;
            expect(scheduler.checkIfAnyEventActive([wrongDay])).to.equal(false);
        });

        it('in MONTH mode it uses months and daysOfMonth instead of the weekday list', function () {
            const p = nowParts();
            const inMonthMode = {
                monthMode: true,
                months: new Array(12).fill(false),
                daysOfMonth: new Array(31).fill(false),
                eventMode: false,
                startTime: clock(p.minutes - 10),
                endTime: clock(p.minutes + 10)
            };
            inMonthMode.months[p.month] = true;
            inMonthMode.daysOfMonth[p.date - 1] = true;
            expect(scheduler.checkIfAnyEventActive([inMonthMode])).to.equal(true);

            // wrong month
            inMonthMode.months = new Array(12).fill(false);
            inMonthMode.months[(p.month + 1) % 12] = true;
            expect(scheduler.checkIfAnyEventActive([inMonthMode])).to.equal(false);

            // right month, wrong day of month
            inMonthMode.months[p.month] = true;
            inMonthMode.daysOfMonth = new Array(31).fill(false);
            inMonthMode.daysOfMonth[(p.date + 1) % 31] = true;
            expect(scheduler.checkIfAnyEventActive([inMonthMode])).to.equal(false);
        });

        it('an event with neither mode is skipped, not treated as always-on', function () {
            const noMode = { days: [], eventMode: false, startTime: '00:00', endTime: '23:59' };
            expect(scheduler.checkIfAnyEventActive([noMode])).to.equal(false);
        });

        it('EVENT MODE events are excluded - they are state-driven, not clock-driven', function () {
            const asEventMode = scheduleContainingNow(true);
            asEventMode.eventMode = true;
            expect(scheduler.checkIfAnyEventActive([asEventMode])).to.equal(false);
        });

        it('an event with no endTime is skipped', function () {
            const noEnd = scheduleContainingNow(true);
            delete noEnd.endTime;
            expect(scheduler.checkIfAnyEventActive([noEnd])).to.equal(false);
        });

        it('a window that crosses midnight is active on BOTH sides of it', function () {
            // 23:00 -> 01:00 must contain 23:30 and 00:30. This is the arithmetic that the
            // "endMinutes < startMinutes" branch exists for, and nothing tested it.
            const p = nowParts();
            const days = new Array(7).fill(false);
            days[p.day] = true;
            const overnight = {
                days: days, monthMode: false, eventMode: false,
                startTime: '23:00', endTime: '01:00'
            };
            const range = (p.minutes >= 23 * 60) || (p.minutes < 60);
            expect(scheduler.checkIfAnyEventActive([overnight]),
                'now is ' + clock(p.minutes) + ', so an overnight window is ' + (range ? 'active' : 'inactive'))
                .to.equal(range);
        });

        it('one active event among many is enough', function () {
            expect(scheduler.checkIfAnyEventActive([
                scheduleContainingNow(false),
                scheduleContainingNow(true),
                scheduleContainingNow(false)
            ])).to.equal(true);
        });
    });

    describe('writeTagFromEvent', () => {
        function loadWith(writeResult) {
            const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
            const emitted = [];
            const runtime = {
                logger: logger,
                devices: { setTagValue: sinon.stub().resolves(writeResult) },
                events: { emit: (name, payload) => emitted.push({ name: name, payload: payload }), on: sinon.stub() },
                io: { emit: sinon.stub(), on: sinon.stub() },
                schedulerStorage: { getAllSchedulers: sinon.stub().resolves([]) },
                scriptsMgr: { runScript: sinon.stub().resolves(true) }
            };
            delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
            const service = require('../../runtime/scheduler/scheduler-service');
            service.init({}, logger, runtime);
            return { service: service, logger: logger, runtime: runtime, emitted: emitted };
        }

        it('an applied write is reported true and publishes the change', async function () {
            const ctx = loadWith(true);
            const applied = await ctx.service.writeTagFromEvent('dev-a.t1', 1, 'test');
            expect(applied).to.equal(true);
            expect(ctx.emitted.map((e) => e.name)).to.deep.equal(['device-value:changed']);
            expect(ctx.emitted[0].payload.values['dev-a.t1'].value).to.equal(1);
        });

        it('a REFUSED write is reported false and leaves a trace', async function () {
            // setTagValue resolves false; before this change nothing was logged and the caller could
            // not tell a refused write from an applied one.
            const ctx = loadWith(false);
            const applied = await ctx.service.writeTagFromEvent('dev-a.t1', 1, 'Master control enforcement');
            expect(applied).to.equal(false);
            expect(ctx.emitted, 'a refused write must not be published as if it happened').to.deep.equal([]);
            const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
            expect(logged).to.contain('Master control enforcement');
            expect(logged).to.contain('dev-a.t1');
        });

        it('a throwing write is reported false, with the message', async function () {
            const ctx = loadWith(true);
            ctx.runtime.devices.setTagValue.rejects(new Error('transport down'));
            const applied = await ctx.service.writeTagFromEvent('dev-a.t1', 1, 'test');
            expect(applied).to.equal(false);
            const logged = ctx.logger.error.getCalls().map((c) => c.args.join(' ')).join(' | ');
            expect(logged).to.contain('transport down');
        });

        it('a failed write releases the loop break immediately, so a later write is not lost', async function () {
            // The guard holds the tag for 1000 ms after a SUCCESSFUL write. On failure there is no
            // echo to ignore, so holding the tag would swallow the next legitimate change.
            const ctx = loadWith(false);
            await ctx.service.writeTagFromEvent('dev-a.t1', 1, 'test');
            const again = await ctx.service.writeTagFromEvent('dev-a.t1', 0, 'test');
            expect(ctx.runtime.devices.setTagValue.callCount, 'the second write must reach the device').to.equal(2);
            expect(again).to.equal(false);
        });
    });
});
