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

    setImmediate(() => setImmediate(() => {
        result.tdengine.unhandledRejections = escapes;
        // A read on a disconnected adapter must settle with data, not hang and not reject.
        Promise.resolve()
            .then(() => require(path.join(storageDir, 'tdengine'))
                .create({ daqstore: { type: 'TDengine' } }, silent, null)
                .getDaqValue('some-tag', 0, 1000))
            .then((rows) => {
                result.tdengine.readWhenDisconnected = Array.isArray(rows) ? rows : 'not-an-array';
                result.tdengine.unhandledRejections = escapes;
                fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
            })
            .catch((err) => {
                result.tdengine.readWhenDisconnected = 'rejected: ' + err.message;
                result.tdengine.unhandledRejections = escapes;
                fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
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
