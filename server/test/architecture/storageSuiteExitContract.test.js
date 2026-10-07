/**
 * The storage suite may only leave the process via --exit if --exit changes NOTHING but the exit.
 *
 * WHY THIS FILE EXISTS
 *
 * test/storage/*.test.js does not terminate on its own. Investigated rather than assumed:
 *
 *   - the suite PASSES in about 100 ms and then hangs, so the problem is after the last assertion;
 *   - it is one file, not the directory: daqQueryContract.test.js hangs alone, 3 times out of 3,
 *     while the other five files in the same directory exit cleanly;
 *   - the cause is in the module graph, not the test: importing runtime/storage/daqstorage pulls the
 *     REAL sqlite3 native driver in (it is in require.cache after the require, before any call), and
 *     that driver's internal session leaves two live Socket handles. `process._getActiveHandles()`
 *     reports them, and they are still there after daqstorage.reset().
 *
 * So the suite is given `--exit`: mocha runs every test and every assertion, reports, and then
 * terminates the process instead of waiting for a native thread pool that will never drain.
 *
 * THE RISK THAT MAKES THIS FILE NECESSARY. `--exit` is a real footgun if it is used to hide a
 * process that is stuck BEFORE the tests finish: the run would report a partial, green result. So
 * this test asks mocha twice - once with the flag, once without - and requires the two reports to
 * agree exactly on passed / failed / pending. If a future change makes the suite stop early under
 * --exit, the numbers diverge and this fails.
 *
 * The comparison is run with a hard timeout on the no-flag run, because that run is EXPECTED not to
 * terminate: its exit status is meaningless, only its JSON report is.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const MOCHA = path.join(SERVER_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
const SPEC = path.join('test', 'storage', '*.test.js');

/** Run mocha and return the JSON stats, or a diagnosis. */
function runMocha(extraArgs, timeoutMs) {
    const result = spawnSync(process.execPath, [MOCHA, SPEC, '--timeout', '90000', '--reporter', 'json', ...extraArgs], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        timeout: timeoutMs
    });
    const stdout = result.stdout || '';
    const start = stdout.indexOf('{');
    if (start === -1) {
        return { ok: false, reason: 'no JSON report (status ' + result.status + ', signal ' + result.signal + ')' };
    }
    try {
        const report = JSON.parse(stdout.slice(start));
        const stats = report.stats || {};
        return {
            ok: true,
            passes: stats.passes || 0,
            failures: stats.failures || 0,
            pending: stats.pending || 0,
            failing: (report.failures || []).length
        };
    } catch (err) {
        return { ok: false, reason: 'JSON did not parse: ' + err.message };
    }
}

describe('the storage suite report is the same with and without --exit', () => {
    it('the assertions actually count: --exit only ends the process', function () {
        this.timeout(300000);

        // With the flag. The run terminates, so it can also be checked for exit status.
        const flagged = spawnSync(process.execPath, [MOCHA, SPEC, '--timeout', '90000', '--exit',
            '--reporter', 'json'], { cwd: SERVER_ROOT, encoding: 'utf8', timeout: 300000 });
        const flaggedJson = (function () {
            const out = flagged.stdout || '';
            const at = out.indexOf('{');
            if (at === -1) { return null; }
            try { return JSON.parse(out.slice(at)); } catch (err) { return null; }
        })();
        expect(flaggedJson, 'no JSON report from the --exit run').to.not.equal(null);
        const withFlag = flaggedJson.stats || {};
        expect(flagged.status, 'the --exit run must be green').to.equal(0);
        expect(withFlag.failures || 0, 'the --exit run must have no failing tests').to.equal(0);

        // Without the flag. This run is EXPECTED to hang after reporting, so it is killed once the
        // report has been written - the report is produced BEFORE the process would have exited,
        // which is the whole point. The timeout is short on purpose: waiting it out costs four
        // minutes of gate time to learn nothing extra, and a four-minute gate is a gate people
        // start skipping.
        const plain = runMocha([], 30000);
        expect(plain.ok, 'the no-flag run produced no usable report: ' + plain.reason).to.equal(true);

        expect(
            { passes: plain.passes, failures: plain.failures, pending: plain.pending },
            'the two runs disagree, which means --exit is ending the suite EARLY rather than just ' +
            'ending the process. Do not "fix" this by relaxing the comparison.'
        ).to.deep.equal({
            passes: withFlag.passes || 0,
            failures: withFlag.failures || 0,
            pending: withFlag.pending || 0
        });

        expect(plain.passes, 'a storage suite that asserts nothing is not a suite').to.be.greaterThan(30);
    });

    it('the storage suite stays OUT of test:gate, and this file is the reason (N-33)', function () {
        // N-33 asked whether the one remaining un-gated directory should join the gate. The answer is
        // measured rather than preferred, and it is no:
        //
        //   - this suite cannot terminate on its own (first test in this file: the sqlite3 native
        //     session leaves two live Socket handles after the last assertion);
        //   - the gate must NOT use --exit (pinned above), because a --exit gate ends the moment any
        //     suite leaves a handle behind - including a suite that stopped early;
        //   - so adding this directory would reproduce the batch-45 defect exactly: a gate that
        //     prints its report and never returns.
        //
        // What the project has instead is the right shape: the suite runs as its own command
        // (test:storage, with --exit), and this file runs it TWICE and requires the two reports to
        // agree, so --exit is provably not hiding a partial run. Both halves are asserted here so a
        // later "let's just add storage to the gate" cannot pass silently.
        const pkg = require(path.join(SERVER_ROOT, 'package.json'));
        const gate = String((pkg.scripts || {})['test:gate'] || '');
        expect(gate, 'test:gate must not load test/storage/*.test.js - see the comment above').to.not.contain('test/storage');
        expect(gate, 'test:gate must not load test/storage/*.test.js - see the comment above').to.not.contain('test\\storage');
        expect(pkg.scripts['test:storage'], 'the storage suite must still be runnable on its own').to.be.a('string');
        expect(fs.existsSync(path.join(SERVER_ROOT, 'test', 'storage', 'daqQueryContract.test.js')),
            'the file this decision is about is gone - if the hang is fixed, revisit N-33 instead of leaving this guard behind')
            .to.equal(true);
    });

    it('the script that uses --exit is the storage one, not the gate', function () {
        // Cheap adjacency check: the gate must not depend on --exit, because a --exit gate would
        // end the whole run the moment any suite left a handle behind - including a suite that
        // stopped early.
        const pkg = require(path.join(SERVER_ROOT, 'package.json'));
        const scripts = pkg.scripts || {};
        expect(String(scripts['test:storage'] || ''), 'test:storage must carry --exit').to.contain('--exit');
        expect(String(scripts['test:gate'] || ''), 'the gate must NOT carry --exit').to.not.contain('--exit');
    });
});
