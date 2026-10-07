/**
 * The WHOLE gate must exit on its own, and it must cover every suite the gate declares (N-40).
 *
 * WHY THIS IS SEPARATE FROM THE TWO GUARDS THAT ALREADY EXIST. test/architecture/
 * storageSuiteExitContract.test.js and schedulerSuiteExitContract.test.js each pin ONE SUBSET, and
 * that shape is what let the original defect through: batch 45 measured `npm run test:gate`
 * printing "822 passing / 16 pending" and then living for twelve minutes, because one spec file
 * armed a node-schedule timer and nothing owned the question "does the gate, as declared, end?".
 * Subset guards answer "is this suite healthy"; they cannot answer "is the command a human runs
 * healthy", because the command is the union of the subsets plus everything nobody pinned.
 *
 * WHAT IT DOES:
 *   1. reads the spec list OUT OF package.json (so it cannot drift from what a human runs),
 *   2. refuses to run unless that list is identical to the gate's own - if the gate grows a suite
 *      and this guard does not, the two lists differ and this fails instead of quietly covering
 *      less,
 *   3. runs it with NO --exit and a hard timeout, and requires a clean, GREEN exit.
 *
 * IT MUST NOT RUN ITSELF. The first version of this guard ran \`test:gate\` verbatim, and the gate now
 * contains THIS FILE - so the child ran the guard, which spawned a grandchild running the guard
 * again. Measured: the guard hung and its own timeout fired (ETIMEDOUT), and the failure looked like
 * the batch-45 defect it was written to catch. The spec list is therefore the gate's list MINUS the
 * three exit-contract guards (this one and the two subset ones, which are themselves the thing being
 * replicated here). Keeping them would be recursion; dropping anything else would be a smaller gate.
 *
 * THE COST, STATED PLAINLY: this still re-runs most of the gate inside the gate. Measured effect on
 * \`npm run test:gate\`: none, because the child is capped at 180s and the gate is ~90s ... the cap is
 * what to watch. It is deliberately below the point where a hung child could outlive the gate.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const MOCHA = path.join(SERVER_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
const TIMEOUT_MS = 180000;

/**
 * The suites the gate must cover.
 *
 * Kept EXPLICIT rather than derived from 'test:gate' by string surgery, because the two things it
 * has to be checked against (the gate's list and this list) then differ in a way that a reader can
 * see. `storage` is deliberately ABSENT: it hangs in a shared process by design (batch 12, sqlite3),
 * it is not part of `test:gate`, and it is owned by storageSuiteExitContract.
 */
const SUITES = [
    'test/reporting/*.test.js', 'test/i18n/*.test.js', 'test/jobs/*.test.js',
    'test/authorization/*.test.js', 'test/alarms/*.test.js', 'test/calibration/*.test.js',
    'test/cameras/*.test.js', 'test/help/*.test.js', 'test/opcua-server/*.test.js',
    'test/plugins/*.test.js', 'test/recipes/*.test.js', 'test/scheduler/*.test.js',
    'test/devices/brandingGuard.test.js', 'test/devices/driverDispatch.test.js',
    'test/devices/driverEmitDiscipline.test.js', 'test/devices/driverInterface.test.js',
    'test/devices/deviceAccessors.test.js', 'test/devices/s7Scoping.test.js',
    'test/devices/scadiaServerRuntime.test.js', 'test/devices/driverOverloadPolicy.test.js',
    'test/api/useAsset.test.js',
    'test/project/*.test.js', 'test/runtime/*.test.js',
    'test/architecture/*.test.js', 'test/contract/*.test.js'
];

/** The exit-contract guards: recursion if the child runs them, and they are what this file replaces. */
const NOT_RECURSED = [
    'test/architecture/gateExitContract.test.js',
    'test/architecture/storageSuiteExitContract.test.js',
    'test/architecture/schedulerSuiteExitContract.test.js'
];

/** The gate's own spec arguments, with the globs expanded to the files mocha would actually load. */
function gateSpecs(pkg) {
    const declared = specsOf(pkg.scripts['test:gate']);
    const expanded = [];
    declared.forEach((spec) => {
        if (spec.indexOf('*') === -1) { expanded.push(spec); return; }
        const dir = path.dirname(path.join(SERVER_ROOT, spec));
        fs.readdirSync(dir).filter((n) => n.endsWith('.test.js')).sort()
            .forEach((n) => expanded.push(path.join(path.relative(SERVER_ROOT, dir), n).split(path.sep).join('/')));
    });
    return expanded;
}

/** Every spec argument in a script string, in order, ignoring mocha flags and their values. */
function specsOf(script) {
    const out = [];
    const re = /"([^"]*\.test\.js)"|([\w./*-]+\.test\.js)/g;
    let m;
    while ((m = re.exec(script))) { out.push(m[1] || m[2]); }
    return out;
}

describe('the gate exits on its own, and covers what it declares (N-40)', () => {
    it('this guard covers exactly the suites test:gate declares', function () {
        const pkg = require(path.join(SERVER_ROOT, 'package.json'));
        const declared = gateSpecs(pkg);
        expect(declared.length, 'no specs were parsed out of test:gate - the guard would be ' +
            'vacuous, which is the failure mode it exists to prevent').to.be.greaterThan(20);
        // Every file the gate loads must be either inside one of SUITES' patterns or one of the
        // three guards. The patterns are matched, not compared as strings: the gate declares globs
        // and this expansion is precisely what turns them into the files mocha will load.
        const covered = (spec) => NOT_RECURSED.indexOf(spec) !== -1 || SUITES.some((pattern) => {
            const re = new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/\*\*/g, '.+').replace(/\*/g, '[^/]+') + '$');
            return re.test(spec);
        });
        const uncovered = declared.filter((spec) => !covered(spec));
        expect(uncovered, 'test:gate loads spec files this guard does not account for. A suite the ' +
            'gate runs and this guard ignores is a suite whose exit nobody checks; a guard it runs is ' +
            'recursion. Decide which, here:\n' + uncovered.join('\n')).to.deep.equal([]);
    });

    it('the whole gate exits GREEN, with no --exit and without hanging', function () {
        this.timeout(TIMEOUT_MS + 60000);
        const pkg = require(path.join(SERVER_ROOT, 'package.json'));
        const specs = gateSpecs(pkg).filter((s) => NOT_RECURSED.indexOf(s) === -1);
        expect(specs.length, 'the child would run nothing').to.be.greaterThan(20);
        const started = Date.now();
        const run = spawnSync(process.execPath, [MOCHA, ...specs, '--timeout', '90000', '--reporter', 'dot'], {
            cwd: SERVER_ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024
        });
        const elapsed = Math.round((Date.now() - started) / 1000);
        const output = ((run.stdout || '') + (run.stderr || '')).trim();
        const tail = output.split(/\r?\n/).slice(-25).join('\n');

        expect(run.error && run.error.code, 'the gate did not exit within ' + (TIMEOUT_MS / 1000) + 's ' +
            '(it ran for ' + elapsed + 's). This is the batch 45 defect: a suite armed something the ' +
            'event loop will not let go of. Find the spec that does it by running the suites one at a ' +
            'time - the two subset guards here (storage, scheduler) show the technique.\n' + tail)
            .to.not.equal('ETIMEDOUT');
        expect(run.status, 'the gate exited ' + run.status + ' after ' + elapsed + 's:\n' + tail).to.equal(0);
        expect(output, 'a gate that asserts nothing is not a gate').to.match(/\d+ passing/);
        expect(output, 'no failing tests are acceptable in the gate').to.not.match(/\d+ failing/);
    });
});