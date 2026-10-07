'use strict';

/**
 * The state-broadcast pass: one payload shape, and one malformed event cannot silence the rest.
 *
 * Eleventh file of scheduler coverage. `notifyEventStates` runs after every scheduler update and at
 * startup, and it is what tells the clients which events are active. Two things were wrong with it:
 *
 *   1. IT ASSEMBLED ITS OWN PAYLOAD. The same shape was built twice - here and before
 *      checkAndNotifyEventState in setInitialStates - and the two were NOT identical: the second
 *      omitted `days`, `disabled` and `recurring`. So a client got a different payload depending on
 *      whether the frame came from a refresh or from a state change.
 *
 *   2. IT MAPPED `event.days` WITHOUT CHECKING IT IS AN ARRAY. The map ran inside a forEach
 *      callback, so one event missing its days array threw, the enclosing catch logged a single
 *      line, and NO state was broadcast for that scheduler - every event after the malformed one
 *      went silent on the client.
 *
 * `eventDayNumbers` and `buildEventPayload` are now the single source for both, and the payload
 * shape is pinned field by field.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');
const Events = require('../../runtime/events');

const ACTIVE = Events.IoEventTypes.SCHEDULER_ACTIVE;

function loadService() {
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const emitted = [];
    const runtime = {
        logger: logger,
        io: { emit: (e, p) => emitted.push({ event: e, payload: p }), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: { setTagValue: sinon.stub().resolves(true) },
        schedulerStorage: { getAllSchedulers: sinon.stub().resolves([]) },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger, emitted: emitted };
}

/**
 * Assertions about the logger must be SPECIFIC, not "nothing was logged at all": loading this
 * module with a stub runtime makes the runtime itself log unrelated startup noise (for example
 * "Failed to load project data:" when there is no project), which has nothing to do with the
 * scheduler. So the tests below ask whether a SCHEDULER error was logged.
 */
function schedulerErrors(logger) {
    return logger.error.getCalls().map((c) => c.args.join(' ')).filter((m) => m.indexOf('notifying event') !== -1);
}

/** A device whose event list is under the test's control. */
function dataFor(events) {
    return {
        settings: { devices: [{ name: 'device-a', variableId: 'a.t1' }] },
        schedules: { 'device-a': events }
    };
}

function activesOf(emitted) {
    return emitted.filter((e) => e.event === ACTIVE).map((e) => e.payload);
}

describe('scheduler state broadcast pass', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    describe('eventDayNumbers', () => {
        it('returns the indices of the days whose value is exactly true', function () {
            const service = loadService().service;
            expect(service.eventDayNumbers({ days: [true, false, true, false, false, true, false] }))
                .to.deep.equal([0, 2, 5]);
        });

        it('treats a missing or non-array days as no days, instead of throwing', function () {
            // This is the guard whose absence silenced a whole scheduler.
            const service = loadService().service;
            expect(service.eventDayNumbers({})).to.deep.equal([]);
            expect(service.eventDayNumbers({ days: undefined })).to.deep.equal([]);
            expect(service.eventDayNumbers({ days: 'monday' })).to.deep.equal([]);
            expect(service.eventDayNumbers(null)).to.deep.equal([]);
            expect(service.eventDayNumbers(undefined)).to.deep.equal([]);
        });

        it('only a literal true counts', function () {
            const service = loadService().service;
            expect(service.eventDayNumbers({ days: [1, 'true', true, null] })).to.deep.equal([2]);
        });
    });

    describe('buildEventPayload', () => {
        it('carries the fields the client was written against', function () {
            const service = loadService().service;
            const event = {
                id: 'ev1', startTime: '08:00', endTime: '09:00', days: [true, false, false, false, false, false, false],
                disabled: false, recurring: true, eventMode: false, duration: undefined, label: 'Shift A'
            };
            const payload = service.buildEventPayload('device-a', event);

            expect(Object.keys(payload).sort()).to.deep.equal(
                ['days', 'disabled', 'duration', 'endTime', 'eventMode', 'id', 'label', 'recurring', 'startTime'].sort());
            expect(payload.label).to.equal('Shift A');
            expect(payload.id).to.equal('ev1');
            expect(payload.eventMode).to.equal(false);
        });

        it('is the SAME shape the notify pass emits', async function () {
            // The regression: before the change, this pass assembled its own payload, so the shape
            // depended on which code path produced the frame.
            const ctx = loadService();
            const event = { id: 'ev1', startTime: '00:00', endTime: '23:59', days: new Array(7).fill(true), recurring: true };
            await ctx.service.notifyEventStates('sch1', dataFor([event]));

            const payload = activesOf(ctx.emitted)[0].eventData;
            expect(Object.keys(payload).sort()).to.deep.equal(
                Object.keys(ctx.service.buildEventPayload('device-a', event)).sort());
        });
    });

    describe('notifyEventStates', () => {
        it('emits one state per event, with the index the client needs', async function () {
            const ctx = loadService();
            const days = new Array(7).fill(false);
            days[new Date().getDay()] = true;
            const m = new Date().getHours() * 60 + new Date().getMinutes();
            const fmt = (x) => String(Math.floor((((x % 1440) + 1440) % 1440) / 60)).padStart(2, '0') + ':' +
                String((((x % 1440) + 1440) % 1440) % 60).padStart(2, '0');
            const events = [
                { id: 'ev0', startTime: fmt(m + 60), endTime: fmt(m + 120), days: days },
                { id: 'ev1', startTime: fmt(m - 5), endTime: fmt(m + 5), days: days }
            ];
            await ctx.service.notifyEventStates('sch1', dataFor(events));

            const payloads = activesOf(ctx.emitted);
            expect(payloads).to.have.length(2);
            expect(payloads.map((p) => p.eventIndex).sort()).to.deep.equal([0, 1]);
            expect(payloads.find((p) => p.eventId === 'ev1').active, 'the event covering now is active').to.equal(true);
            expect(payloads.find((p) => p.eventId === 'ev0').active).to.equal(false);
        });

        it('ONE malformed event does not silence the events after it', async function () {
            // THE REGRESSION. Without the array guard, the event missing `days` threw inside the
            // forEach, the catch swallowed it, and the event after it was never broadcast.
            const ctx = loadService();
            const summary = await ctx.service.notifyEventStates('sch1', dataFor([
                { id: 'ok-first', startTime: '08:00', endTime: '09:00', days: [true, false, false, false, false, false, false] },
                { id: 'no-days', startTime: '08:00', endTime: '09:00' },
                { id: 'ok-last', startTime: '08:00', endTime: '09:00', days: [true, false, false, false, false, false, false] }
            ]));

            const ids = activesOf(ctx.emitted).map((p) => p.eventId);
            expect(ids, 'the event after the malformed one must still be broadcast').to.contain('ok-last');
            expect(ids).to.contain('ok-first');
            expect(ids, 'an event with no day selected is not broadcast as a state').to.not.contain('no-days');
            expect(summary.broadcast).to.equal(2);
            expect(summary.skippedNoDays).to.equal(1);
            expect(schedulerErrors(ctx.logger), 'and it must not have thrown its way out').to.deep.equal([]);
        });

        it('an event with every day switched off is counted, not broadcast', async function () {
            // Measured: with an empty day list the day check logs an error per event, which is noise
            // that hides real failures. Such an event can never be active, so it is counted instead.
            const ctx = loadService();
            const summary = await ctx.service.notifyEventStates('sch1', dataFor([
                { id: 'ev-all-off', startTime: '08:00', endTime: '09:00', days: new Array(7).fill(false) }
            ]));
            expect(summary.skippedNoDays).to.equal(1);
            expect(summary.broadcast).to.equal(0);
            expect(schedulerErrors(ctx.logger), 'not broadcasting is not an error').to.deep.equal([]);
        });

        it('malformed scheduler data emits nothing and does not throw', async function () {
            const ctx = loadService();
            for (const bad of [null, undefined, {}, { settings: {} }, { settings: { devices: [] } }]) {
                await ctx.service.notifyEventStates('sch1', bad);
            }
            expect(ctx.emitted).to.deep.equal([]);
        });

        it('a device with no schedules entry emits nothing for it', async function () {
            const ctx = loadService();
            await ctx.service.notifyEventStates('sch1', {
                settings: { devices: [{ name: 'device-missing', variableId: 'x.t1' }] },
                schedules: {}
            });
            expect(ctx.emitted).to.deep.equal([]);
        });
    });
});
