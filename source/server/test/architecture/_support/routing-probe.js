/**
 * D1 / class 4 support - which backend does a configured daqstore.type actually select?
 *
 * Runs as its own process on purpose: it replaces the backend create() factories with
 * stubs, and that must not leak into the shared mocha process.
 *
 * The result is handed over through a FILE, not stdout. Capturing a child's piped stdout
 * hangs in this environment (spawnSync ETIMEDOUT on a probe that finishes in under a
 * second when run by hand), so the guard must not depend on pipes.
 *
 * The stubs return a no-op handle and never touch a database, the network or the disk:
 * this probe measures ONE thing, the routing decision, so no backend needs to be
 * reachable, installed or configured.
 *
 * usage: node routing-probe.js <output-file>
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function probe(outFile) {

const storageDir = path.join(__dirname, '..', '..', '..', 'runtime', 'storage');
const chosen = [];

const stubHandle = () => ({
    setCall() { return function addDaqValues() {}; },
    getDaqMap() { return {}; },
    getDaqValue() { return Promise.resolve([]); },
    addDaqValues() {},
    close() {}
});

const spy = (moduleName, label) => {
    const mod = require(path.join(storageDir, moduleName));
    mod.create = function () {
        chosen.push(label);
        return stubHandle();
    };
};

spy('sqlite', 'SQlite');
spy('influxdb', 'influxDB');
spy('tdengine', 'TDengine');
spy('questdb', 'questDB');

const daqstorage = require(path.join(storageDir, 'daqstorage'));

const TYPES = ['SQlite', 'influxDB', 'influxDB18', 'influxDB 1.8', 'TDengine', 'questDB', 'QuestDB', 'MySQL'];
const routing = {};
const diagnostics = {};

for (const type of TYPES) {
    chosen.length = 0;
    const notes = [];
    const logger = {
        info() {},
        debug() {},
        error(m) { notes.push('error:' + m); },
        warn(m) { notes.push('warn:' + m); }
    };
    // init() validates the configured type and refuses an unknown one (ledger A-03), so the
    // call itself can throw - it belongs inside the try with everything else.
    try {
        daqstorage.init({ dbDir: os.tmpdir(), daqstore: { type: type, retention: 'none' } }, logger, {});
        daqstorage.addDaqNode('probe-device', function () {});
    } catch (err) { notes.push('refused:' + err.message); }
    routing[type] = chosen[0] || null;
    diagnostics[type] = notes;
    try { daqstorage.reset(); } catch (err) { /* the probe owns this instance */ }
}

fs.writeFileSync(outFile, JSON.stringify({ routing: routing, diagnostics: diagnostics }, null, 2), 'utf8');

    // The sqlite3 driver keeps handles (and its thread pool) alive, so this child would
    // never exit on its own and the caller would time out waiting for a process that
    // already wrote its answer. Exit explicitly, once the answer is on disk.
    process.exit(0);
}

// Mocha --recursive loads EVERY .js under test/ as a spec file, so this module must do
// nothing at all when it is required rather than run. Guarded, and enforced by
// test/architecture/scannerContract.test.js.
if (require.main === module) {
    const outFile = process.argv[2];
    if (!outFile) { throw new Error('routing-probe: an output file path is required'); }
    probe(outFile);
}