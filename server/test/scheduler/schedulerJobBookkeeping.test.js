'use strict';

/**
 * Stopping a scheduler must stop ITS jobs and only its jobs.
 *
 * Eighth file of scheduler coverage. `stopScheduler` runs on every scheduler update and on delete,
 * and it is the only thing that puts jobs down.
 *
 * THE DEFECT THIS PINS: a job id is `${schedulerId}_${deviceName}_${eventId}_${start|end}`, and the
 * membership test was a bare `jobId.startsWith(schedulerId)`. That is a prefix match with no
 * boundary, so stopping `s1` also cancelled every job of `s10`, `s11`, `s100`... A scheduler being
 * toggled off took OTHER schedulers' jobs down with it. Nothing reported it, because the function
 * returned nothing and each cancellation was silent.
 *
 * It now cancels only ids that are exactly the scheduler id or start with `schedulerId_`, and
 * returns what it cancelled so the answer is observable.
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
        devices: { setTagValue: sinon.stub().resolves(true), getDeviceIdFromTag: () => 'dev-a' },
        schedulerStorage: { getAllSchedulers: sinon.stub().resolves([]) },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return service;
}

/** A job double that records whether it was cancelled. */
function makeJob() {
    return { cancelled: false, cancel() { this.cancelled = true; } };
}

describe('scheduler job bookkeeping (stopScheduler)', () => {
    let service;

    beforeEach(() => {
        service = loadService();
        service.clearAllJobsForTest();
    });

    afterEach(() => {
        service.clearAllJobsForTest();
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('cancels the jobs of the scheduler it was asked to stop', function () {
        const a1 = makeJob();
        const a2 = makeJob();
        service.registerJobForTest('sch1_device-a_ev1_start', a1);
        service.registerJobForTest('sch1_device-a_ev1_end', a2);

        const result = service.stopScheduler('sch1');

        expect(result.cancelled).to.equal(2);
        expect(a1.cancelled).to.equal(true);
        expect(a2.cancelled).to.equal(true);
        expect(service.registeredJobIds(), 'cancelled jobs are forgotten').to.deep.equal([]);
    });

    it('does NOT touch a scheduler whose id merely STARTS with the same characters', function () {
        // THE DEFECT. "s1" is a prefix of "s10", and a bare startsWith treated them as the same
        // scheduler.
        const other = makeJob();
        const mine = makeJob();
        service.registerJobForTest('s10_device-a_ev1_start', other);
        service.registerJobForTest('s1_device-a_ev1_start', mine);

        const result = service.stopScheduler('s1');

        expect(mine.cancelled).to.equal(true);
        expect(other.cancelled, 's10 is a DIFFERENT scheduler and must keep its jobs').to.equal(false);
        expect(service.registeredJobIds()).to.deep.equal(['s10_device-a_ev1_start']);
        expect(result.cancelledIds).to.deep.equal(['s1_device-a_ev1_start']);
    });

    it('leaves unrelated schedulers alone', function () {
        const b = makeJob();
        service.registerJobForTest('schB_device-b_ev2_start', b);
        const result = service.stopScheduler('schA');
        expect(result.cancelled).to.equal(0);
        expect(b.cancelled).to.equal(false);
    });

    it('is a no-op for a scheduler with no jobs, and says so', function () {
        const result = service.stopScheduler('nothing-here');
        expect(result.cancelled).to.equal(0);
        expect(result.cancelledIds).to.deep.equal([]);
    });

    it('cancels every job of the scheduler, across devices and events', function () {
        const jobs = {};
        ['device-a_ev1_start', 'device-a_ev1_end', 'device-b_ev2_start', 'device-b_ev2_end'].forEach((suffix) => {
            jobs[suffix] = makeJob();
            service.registerJobForTest('sch1_' + suffix, jobs[suffix]);
        });
        service.registerJobForTest('sch2_device-a_ev1_start', makeJob());

        const result = service.stopScheduler('sch1');

        expect(result.cancelled).to.equal(4);
        Object.values(jobs).forEach((j) => expect(j.cancelled).to.equal(true));
        expect(service.registeredJobIds()).to.deep.equal(['sch2_device-a_ev1_start']);
    });

    it('the membership rule is exact about the separator, and the helper states it', function () {
        expect(service.jobBelongsToScheduler('sch1_device-a_ev1_start', 'sch1')).to.equal(true);
        expect(service.jobBelongsToScheduler('sch1', 'sch1')).to.equal(true);
        expect(service.jobBelongsToScheduler('sch10_device-a_ev1_start', 'sch1')).to.equal(false);
        expect(service.jobBelongsToScheduler('sch1x_device-a_ev1_start', 'sch1')).to.equal(false);
        expect(service.jobBelongsToScheduler('', 'sch1')).to.equal(false);
        expect(service.jobBelongsToScheduler('sch1_x', ''), 'an empty scheduler id must match nothing')
            .to.equal(false);
        expect(service.jobBelongsToScheduler(null, 'sch1')).to.equal(false);
    });

    it('an empty scheduler id does not cancel the world', function () {
        // Every real id starts with the empty string, so a bare startsWith('') cancelled EVERY job.
        const a = makeJob();
        service.registerJobForTest('sch1_device-a_ev1_start', a);
        const result = service.stopScheduler('');
        expect(result.cancelled).to.equal(0);
        expect(a.cancelled).to.equal(false);
    });
});
