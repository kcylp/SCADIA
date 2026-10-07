/**
 * The tree the reverse harness starts from must be the tree it thinks it started from.
 *
 * WHY THIS EXISTS - a real failure, not a hypothetical.
 *
 * The harness works by injecting a violation, watching the owning check go red, then restoring
 * the file. If a run is killed mid-flight the file stays mutated, and because `main()` snapshots
 * the tree at STARTUP, the NEXT run adopts the mutated tree as pristine. From then on it:
 *
 *   - reports "baseline was not green" for every case in that suite, which reads as "the guard
 *     is broken" when in fact a previous run broke the code;
 *   - "restores" the file to the damage, so the damage is now the committed state of the tree.
 *
 * That is exactly what happened to runtime/storage/tdengine/index.js: case 28 replaced
 * `resolve([])` with `reject(new Error('not connected'))`, a run was killed, and the damage
 * survived as the baseline. It was then found by a plain `npm run test:gate` failure - which is
 * the point: the cost of the undetected version is a debugging session that starts from the
 * wrong premise.
 *
 * WHAT THIS SNAPSHOT IS. Not a version-control baseline nobody has: a record of the tree AS THE
 * LAST RUN OF THIS HARNESS LEFT IT. `main()` calls endSession() on the way out, so a clean run's
 * record matches a clean tree, and a killed run leaves a record that no longer matches - which is
 * the signal. (An external edit between runs also trips it, and that is honest too: the harness
 * cannot tell the difference, and this record is the only thing it can compare against.)
 *
 * An unmatched record is a HARD STOP unless SCADIA_REVERSE_ALLOW_DRIFT=1 is set, in which case
 * the run continues and says out loud which files it has adopted as pristine.
 *
 * This file must do NOTHING when required rather than run: mocha --recursive loads every .js
 * under test/ as a spec, and scannerContract.test.js enforces that.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.reverse-tree-state.json');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every .js the harness may touch, outside the directories it never writes to. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '_ui_verify', '_widgets', '_pkg', '.git']);

function walkServer(serverRoot) {
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.js')) { found.push(full); }
        }
    };
    walk(serverRoot);
    return found.sort();
}

/** file (relative, forward slashes) -> sha256. */
function snapshot(serverRoot) {
    const map = {};
    for (const file of walkServer(serverRoot)) {
        map[path.relative(serverRoot, file).split(path.sep).join('/')] = sha(file);
    }
    return map;
}

/**
 * Files this harness is expected to mutate. A drift report that names one of these is the
 * dangerous case and is described as such; a drift outside the set cannot have been caused by
 * an injection at all, so it is almost always an edit made by hand.
 */
const INJECTION_TARGETS = new Set([
    'main.js',
    'runtime/devices/device.js',
    'runtime/events.js',
    'runtime/index.js',
    'runtime/project/index.js',
    'runtime/storage/calculator.js',
    'runtime/storage/postgresql/index.js',
    'runtime/storage/registry.js',
    'runtime/storage/tdengine/index.js',
    'runtime/utils.js',
    'test/architecture/_support/reverse-verify.js',
    'test/architecture/_support/storage-contract.js'
]);

/**
 * Does the tree still match the state the last run left behind?
 * @param {string} serverRoot absolute path of server/
 * @returns {{checked: boolean, reason?: string, drifted: string[], hazard?: string[]}}
 */
function checkBaseline(serverRoot) {
    if (!fs.existsSync(STATE_FILE)) {
        return { checked: false, reason: 'no state file yet (first run with this check)', drifted: [] };
    }
    let previous;
    try {
        previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (err) {
        return { checked: false, reason: 'state file is unreadable: ' + err.message, drifted: [] };
    }
    if (!previous || !previous.files) {
        return { checked: false, reason: 'state file has no file map', drifted: [] };
    }

    const now = snapshot(serverRoot);
    const drifted = [];
    for (const file of Object.keys(previous.files)) {
        if (!(file in now)) { drifted.push(file + '  (deleted since the last run)'); continue; }
        if (now[file] !== previous.files[file]) { drifted.push(file + '  (content changed since the last run)'); }
    }
    for (const file of Object.keys(now)) {
        if (!(file in previous.files)) { drifted.push(file + '  (created since the last run)'); }
    }
    drifted.sort();

    return {
        checked: true,
        drifted,
        hazard: drifted.filter((entry) => INJECTION_TARGETS.has(entry.split('  ')[0]))
    };
}

/** Record the state a completed run is leaving behind - the baseline the next run compares to. */
function endSession(serverRoot) {
    const files = snapshot(serverRoot);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
        writtenBy: 'test/architecture/_support/reverse-verify.js',
        when: new Date().toISOString(),
        fileCount: Object.keys(files).length,
        files
    }, null, 2) + '\n', 'utf8');
    return Object.keys(files).length;
}

/** Everything a caller needs to report, without deciding for it. */
function describeBaseline(report) {
    if (!report.checked) { return 'baseline check skipped: ' + report.reason; }
    if (!report.drifted.length) { return 'baseline matches the last run'; }
    return report.drifted.length + ' file(s) differ from the state the last run left behind';
}

module.exports = { checkBaseline, endSession, snapshot, describeBaseline, STATE_FILE, INJECTION_TARGETS };

// See the header: this module must not run when it is loaded as a spec file.
if (require.main === module) {
    const serverRoot = path.resolve(__dirname, '..', '..', '..');
    const report = checkBaseline(serverRoot);
    console.log(describeBaseline(report));
    report.drifted.forEach((entry) => console.log('  ' + entry));
}
