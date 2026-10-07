/**
 * The scheduler suite has to end by itself. It may not need --exit, and it may not need a timeout.
 *
 * WHY THIS FILE EXISTS
 *
 * Measured, not assumed (batch 45): `npm run test:gate` printed its full summary -
 * "822 passing / 16 pending" - and then NEVER EXITED. It was still alive 12 minutes later and had to
 * be killed. The gate is a command a human waits on and CI times out, so a green report with no exit
 * is a red gate wearing a green coat.
 *
 * Bisected file by file: every spec file in the gate exits in under 3 seconds except
 * test/scheduler/schedulerInitialState.test.js, and inside that file exactly one case -
 * "attempts one job per event, and counts them". Cause: createSchedulerJobs really calls
 * schedule.scheduleJob, node-schedule arms one real, deliberately NOT unref'd timer per pending
 * invocation (node_modules/node-schedule/lib/Invocation.js, runOnDate -> long-timeout), and the case
 * arms six jobs whose next run is an hour out. The event loop therefore stays non-empty until 20:33,
 * and mocha, without --exit, waits - correctly.
 *
 * The fix is in that spec file (cancel what it armed, and fail if anything is left armed). This file
 * is the guard that keeps it fixed, and it is deliberately the STRONG assertion: it does not compare
 * two reports, it requires the process to LEAVE ON ITS OWN.
 *
 * Scope note: this runs the scheduler suite, not the whole gate, because that is the suite that was
 * measured to hang and the check stays cheap enough that nobody starts skipping it.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const MOCHA = path.join(SERVER_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');

describe('the scheduler suite exits on its own, with no --exit and no timeout', () => {
    it('mocha returns instead of hanging on an armed node-schedule timer', function () {
        this.timeout(60000);

        // Deliberately NO --exit: --exit would hide exactly the defect this guard is about, by
        // ending the process the moment the report is written.
        const run = spawnSync(process.execPath, [
            MOCHA, path.join('test', 'scheduler', '*.test.js'), '--timeout', '90000', '--reporter', 'dot'
        ], { cwd: SERVER_ROOT, encoding: 'utf8', timeout: 40000 });

        expect(run.error && run.error.code, 'the scheduler suite did not exit within 40s: an armed ' +
            'node-schedule timer is holding the event loop, which is what hung the gate in batch 45. ' +
            'Cancel the jobs the test armed (see schedulerInitialState.test.js cancelPendingJobs).')
            .to.not.equal('ETIMEDOUT');

        const output = (run.stdout || '') + (run.stderr || '');
        expect(run.status, 'the scheduler suite must exit green:\n' + output.slice(-2000)).to.equal(0);
        expect(output, 'a suite that asserts nothing is not a suite').to.match(/\d+ passing/);
        expect(output, 'no failing tests are acceptable here').to.not.match(/\d+ failing/);
    });
});
