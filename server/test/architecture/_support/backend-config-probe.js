/**
 * D1 class 4 / D9 support - how does an adapter behave when its configuration is unusable?
 *
 * Runs in its own process and hands the result over through a FILE, for two reasons:
 *   - the failure being measured is an UNHANDLED PROMISE REJECTION, which terminates a Node
 *     process by default, so it must not happen inside the mocha process;
 *   - capturing piped stdout from a child hangs in this environment.
 *
 * INERT WHEN REQUIRED. Mocha --recursive loads every .js under test/ as a spec file, so a
 * helper that does anything on require corrupts the run. An earlier version of this file put
 * its setImmediate block OUTSIDE the guard while reading process.argv[2] at module scope -
 * which under mocha is the SPEC PATH, so requiring it overwrote a test file one tick later.
 * scannerContract.test.js now catches that with a child process and a sentinel path.
 *
 * usage: node backend-config-probe.js <output-file>
 */

'use strict';

const fs = require('fs');
const path = require('path');

function probe(outFile) {
    const storageDir = path.join(__dirname, '..', '..', '..', 'runtime', 'storage');

    // Observe rejections instead of being killed by them.
    const escapes = [];
    process.on('unhandledRejection', (reason) => {
        escapes.push(String((reason && reason.message) || reason));
    });

    const silent = { info() {}, debug() {}, warn() {}, error() {} };
    const result = {};

    // TDengine: configured with no credentials at all.
    {
        const TDengine = require(path.join(storageDir, 'tdengine'));
        let syncThrow = null;
        let returned = null;
        try {
            returned = TDengine.create({ daqstore: { type: 'TDengine' } }, silent, null);
        } catch (err) { syncThrow = err; }
        result.tdengine = {
            syncThrow: syncThrow ? syncThrow.message : null,
            returnedAHandle: returned !== null && typeof returned === 'object'
        };
    }

    /**
     * A read on a disconnected adapter must settle with data, not hang and not reject.
     *
     * Batch 90-B widened this from TDengine alone to every adapter that talks to a SERVER,
     * because the same defect was sitting in three more of them (measured: all four rejected).
     * SQLite is deliberately absent: it is a local file store, it needs no server, and its
     * sqlite3 native session leaves handles behind that would stop this probe from exiting -
     * the same reason test/storage stays out of the gate (N-33). It is covered, container-free,
     * in test/storage/disconnectedRead.test.js.
     */
    const DISCONNECTED_READ_CASES = ['tdengine', 'influxdb', 'postgresql', 'questdb'];
    const TYPE_OF = { tdengine: 'TDengine', influxdb: 'influxDB', postgresql: 'PostgreSQL', questdb: 'questDB' };

    /** 'empty' | 'rows' | 'not-an-array' | 'rejected: ...' | 'hung' */
    function readWhenDisconnected(name) {
        const settings = { daqstore: { type: TYPE_OF[name] } };
        const adapter = require(path.join(storageDir, name)).create(settings, silent, null, {});
        const settle = adapter.getDaqValue('some-tag', 0, 1000);
        const hung = new Promise((resolve) => setTimeout(() => resolve('hung'), 15000));
        return Promise.race([
            Promise.resolve(settle).then(
                (rows) => (Array.isArray(rows) ? (rows.length ? 'rows' : 'empty') : 'not-an-array'),
                (err) => 'rejected: ' + ((err && err.message) || err)
            ),
            hung
        ]).then((outcome) => {
            try { adapter.close(); } catch (err) { /* best effort: the probe is about the read */ }
            return outcome;
        });
    }

    setImmediate(() => setImmediate(() => {
        result.tdengine.unhandledRejections = escapes;
        let chain = Promise.resolve();
        result.disconnectedReads = {};
        for (const name of DISCONNECTED_READ_CASES) {
            chain = chain.then(() => readWhenDisconnected(name)).then((outcome) => {
                result.disconnectedReads[name] = outcome;
            });
        }
        chain.then(() => {
            // Kept as its own field: the A-07 assertion has read this key since D9.
            result.tdengine.readWhenDisconnected =
                result.disconnectedReads.tdengine === 'empty' ? [] : result.disconnectedReads.tdengine;
            result.tdengine.unhandledRejections = escapes;
            fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
            // Leave on purpose: the HTTP clients this probe constructs (the TDengine REST agent,
            // pg, the QuestDB sender) leave keep-alive sockets behind, and measured, the child
            // then lives for another ~60 s before Node lets it go - which is inside runProbe's
            // 60 s execFileSync budget, so it is a coin flip whether the guard sees the file or
            // an ETIMEDOUT. The measurement is finished and the file is on disk at this point;
            // every read above is capped by its own 15 s race, so a HANG still produces no file
            // and still fails loudly.
            process.exit(0);
        }).catch((err) => {
            result.probeError = String((err && err.stack) || err);
            fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
            process.exit(0);
        });
    }));
}

// Mocha --recursive loads EVERY .js under test/ as a spec file: do nothing when required.
// Everything that can have an effect lives inside probe(), including the listener and the
// setImmediate - see the note at the top for why that matters.
if (require.main === module) {
    const outFile = process.argv[2];
    if (!outFile) { throw new Error('backend-config-probe: an output file path is required'); }
    probe(outFile);
}

module.exports = { probe };
