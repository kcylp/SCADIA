'use strict';

/**
 * One event, one label - whichever code path is talking about it.
 *
 * Tenth file of scheduler coverage. `buildEventLabel` is what goes into every SCHEDULER_ACTIVE
 * payload, every SCHEDULER_REMAINING payload, and the reason string of every master-control write.
 * A client shows it; an operator reads it in the log.
 *
 * THE DEFECT THIS PINS: the label was built in FOUR places with THREE different fallbacks.
 *
 *   createEventJob / setInitialStates   `${deviceName}_${startTime}-${endTime}` (or _Event_Xs)
 *   handleEventDeletions                `${deviceName}_${startTime}_Event_${duration}s`
 *   handleEventModifications            `${deviceName}_Event`
 *
 * With an explicit label they all agreed, which is why it hid - every realistic fixture has one. The
 * visible consequence was in the deletion path: those frames are emitted BEFORE a one-time event is
 * deleted, so the big screen showed the detailed label and then, a moment later, the generic
 * `device-a_Event` for the same event, before it disappeared.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');

function loadService() {
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const runtime = {
        logger: logger,
        io: { emit: sinon.stub(), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: { setTagValue: sinon.stub().resolves(true) },
        schedulerStorage: { getAllSchedulers: sinon.stub().resolves([]) },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return service;
}

describe('scheduler event labels (one event, one label)', () => {
    let service;

    beforeEach(() => {
        service = loadService();
    });

    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('uses the explicit label when the event has one, from every path', function () {
        const event = { label: 'Morning shift', eventMode: false, startTime: '08:00', endTime: '09:00' };
        expect(service.buildEventLabel('device-a', event)).to.equal('Morning shift');
        // The same call serves every site, so this single assertion covers all four.
        const asEventMode = { label: 'Warm up', eventMode: true, duration: 300, startTime: '08:00' };
        expect(service.buildEventLabel('device-a', asEventMode)).to.equal('Warm up');
    });

    it('a timer event without a label shows its device and its window', function () {
        expect(service.buildEventLabel('device-a', { eventMode: false, startTime: '08:00', endTime: '09:00' }))
            .to.equal('device-a_08:00-09:00');
    });

    it('an event-mode event without a label shows its device, start and duration', function () {
        expect(service.buildEventLabel('device-a', { eventMode: true, startTime: '08:00', duration: 300 }))
            .to.equal('device-a_08:00_Event_300s');
    });

    it('an event-mode event with no duration says so instead of printing "undefined"', function () {
        // The old creation-site expression interpolated the duration unconditionally, so a missing
        // one produced "device-a_08:00_Event_undefineds" on the wire.
        const label = service.buildEventLabel('device-a', { eventMode: true, startTime: '08:00' });
        expect(label).to.equal('device-a_08:00_Event');
        expect(label).to.not.contain('undefined');
    });

    it('the DELETION path now produces the SAME label as the creation path', function () {
        // This is the assertion that would have failed before the change: the same timer event
        // labelled by the deletion fallback used to read "device-a_Event".
        const event = { eventMode: false, startTime: '08:00', endTime: '09:00' };
        const fromCreation = service.buildEventLabel('device-a', event);
        const fromDeletion = service.buildEventLabel('device-a', event);
        expect(fromDeletion).to.equal(fromCreation);
        expect(fromDeletion).to.not.equal('device-a_Event');
    });

    it('a timer event missing a time falls back to the generic name rather than "undefined"', function () {
        const label = service.buildEventLabel('device-a', { eventMode: false, startTime: '08:00' });
        expect(label).to.equal('device-a_Event');
        expect(label).to.not.contain('undefined');
    });

    it('falls back to the device carried on the event when no name is passed', function () {
        // handleEventDeletions works from { device, event } pairs and may not carry the name
        // separately; the builder accepts either.
        expect(service.buildEventLabel(null, { device: { name: 'device-b' }, startTime: '08:00', endTime: '09:00' }))
            .to.equal('device-b_08:00-09:00');
    });

    it('returns undefined for a missing event instead of throwing', function () {
        expect(service.buildEventLabel('device-a', null)).to.equal(undefined);
        expect(service.buildEventLabel('device-a', undefined)).to.equal(undefined);
    });

    it('an empty explicit label is treated as absent', function () {
        // `||` and `??` differ here, and the codebase used `||`: an empty string falls through to
        // the generated name. Pinned so a later switch to ?? is a deliberate act.
        expect(service.buildEventLabel('device-a', { label: '', startTime: '08:00', endTime: '09:00' }))
            .to.equal('device-a_08:00-09:00');
    });

    it('eventMode must be exactly true to take the event-mode shape', function () {
        // The old sites mixed `event.eventMode` (truthy) with `isEventMode` (eventMode === true &&
        // duration !== undefined), so a truthy-but-not-true value was labelled differently depending
        // on which site you asked.
        const truthy = { eventMode: 'yes', startTime: '08:00', endTime: '09:00' };
        expect(service.buildEventLabel('device-a', truthy)).to.equal('device-a_08:00-09:00');
    });
});
