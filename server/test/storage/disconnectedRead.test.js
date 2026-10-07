'use strict';

/**
 * A backend that is NOT CONNECTED answers a READ with no data (A-07, batch 90-B).
 *
 * WHY THIS FILE EXISTS, AND WHY IT SITS HERE RATHER THAN IN test/architecture/
 *
 * The A-07 contract is asserted in test/architecture/errorSemantics.test.js, which measures
 * TDengine out of process through test/architecture/_support/backend-config-probe.js. That is the
 * right shape FOR THE GATE, but it comes with a hole: the gate must not load a suite that opens
 * something the event loop will not let go of (N-33, pinned by
 * test/architecture/storageSuiteExitContract.test.js), and every adapter below opens sockets - or,
 * for SQLite, a sqlite3 native handle. So the same rule is pinned here as well, where the suite is
 * allowed to end with --exit and where SQLite can be included too. Same guard, two runners: the
 * gate gets the network backends, this file gets all five and can be run on its own.
 *
 * NO CONTAINER AND NO SERVER IS INVOLVED, ON PURPOSE. Every network adapter is pointed at
 * 127.0.0.1:1, a reserved port nothing listens on, and is given no credentials it could use, so
 * the measured state is "not connected" whether or not Docker happens to be running. That is the
 * whole point of batch 90-B: the old gate was green because the container was DOWN and the probe
 * never reached the defective line, so a guard that changes its answer with the container is
 * worth nothing here.
 *
 * WHAT THE CONTRACT IS. A read on a backend that cannot be reached settles with NO DATA. It must
 * not reject (the caller cannot tell a configuration typo from a device that never moved) and it
 * must not hang (a chart request would sit there forever). A backend that IS reachable and fails
 * the query is a different thing and still travels as a failure - that distinction is the query
 * contract's, and it is not weakened by this file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const STORAGE = path.join(__dirname, '..', '..', 'runtime', 'storage');

/** A logger that swallows everything: the message is not what is under test here. */
const silent = { info() {}, debug() {}, warn() {}, error() {} };

/** 127.0.0.1:1 is reserved and nothing listens on it - a dead server without a container. */
const DEAD_SERVER = { host: '127.0.0.1', port: 1 };

const CASES = [
    { backend: 'tdengine', type: 'TDengine' },
    { backend: 'influxdb', type: 'influxDB' },
    { backend: 'postgresql', type: 'PostgreSQL' },
    { backend: 'questdb', type: 'questDB' },
    { backend: 'sqlite', type: 'SQlite' }
];

/**
 * 'empty' | 'rows' | 'not-an-array' | 'rejected: <message>' | 'hung: <why>'.
 *
 * The race is what makes "must not hang" testable: without it a hanging adapter would only show
 * up as a mocha timeout, which reads as a broken test rather than as the defect it is.
 */
function settle(adapter, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('hung: the read never settled'), timeoutMs);
        Promise.resolve()
            .then(() => adapter.getDaqValue('any-tag', 0, 1000))
            .then(
                (rows) => {
                    clearTimeout(timer);
                    resolve(Array.isArray(rows) ? (rows.length ? 'rows' : 'empty') : 'not-an-array');
                },
                (err) => {
                    clearTimeout(timer);
                    resolve('rejected: ' + ((err && err.message) || err));
                }
            );
    });
}

describe('a disconnected backend reads as no data (A-07)', function () {
    let workDir;
    const open = [];

    before(function () {
        // A real directory: the SQLite adapter scans it while it is being constructed, and the
        // alternative - pointing it at the working directory - writes a database into the repo.
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-disconnected-read-'));
    });

    after(function () {
        for (const adapter of open) {
            try { adapter.close(); } catch (err) { /* best effort: the suite is ending anyway */ }
        }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (err) { /* the sqlite3 handle may hold it */ }
    });

    for (const c of CASES) {
        it(c.backend + ': getDaqValue on a backend that is not connected settles with []', async function () {
            const settings = { daqstore: Object.assign({ type: c.type }, DEAD_SERVER) };
            if (c.backend === 'sqlite') { settings.dbDir = workDir; }

            const adapter = require(path.join(STORAGE, c.backend)).create(settings, silent, null, {});
            open.push(adapter);

            expect(await settle(adapter, 5000), c.backend +
                ' must answer an unreachable backend with no data: not a rejection, not a hang')
                .to.equal('empty');
        });
    }

    it('tdengine: the read settles empty while init() is still failing (the batch 90-B regression)', async function () {
        // The exact line this guard exists for: runtime/storage/tdengine/index.js:130 used to
        // reject with new Error('not connected') while the write path in the same file (:92-98)
        // logged once and returned. Put the reject back and this test goes red - that is the
        // experiment that makes it a guard rather than a decoration.
        const settings = { daqstore: Object.assign({ type: 'TDengine' }, DEAD_SERVER) };
        const adapter = require(path.join(STORAGE, 'tdengine')).create(settings, silent, null, {});
        open.push(adapter);

        // Deliberately read IMMEDIATELY, before init() has settled: an adapter that is not
        // connected yet is still not connected, and the guard must not depend on a race.
        const rows = await adapter.getDaqValue('some-tag', 0, 1000);

        expect(rows, 'a telnet check must not decide whether a chart request fails')
            .to.deep.equal([]);
    });
});
