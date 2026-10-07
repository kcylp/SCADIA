/**
 * D9 - the storage contract suite against a real TDengine.
 *
 * Same shared cases as SQLite and PostgreSQL, same registry, and the only backend-specific
 * knowledge is the fixture below. It detects its own environment: with a server reachable it
 * runs for real, without one it reports pending WITH A REASON rather than quietly passing.
 *
 *   npm run test:backends:up      # docker compose, one command
 *   npm run test:contract         # this file now runs for real
 *   npm run test:backends:down
 *
 * ONE CASE IS EXPECTED TO BE INTERESTING HERE. TDengine has no transactions on business data
 * (the vendor's own words; see 20_纸上实现_D3.md F-1), which is why ruling D-3 keeps atomicity
 * out of the TimeSeries contract and treats it as a capability the Config domain depends on
 * instead. This suite is where that claim gets checked rather than believed.
 */

'use strict';

const { connect, options: driverOptions } = require('@tdengine/rest');

const registry = require('../../runtime/storage/registry');
const { defineStorageContract, waitUntil, delay, ALL_TIME } = require('./_support/storageContractSuite');

const HOST = process.env.SCADIA_TEST_TD_HOST || '127.0.0.1';
const PORT = Number(process.env.SCADIA_TEST_TD_PORT) || 6041;
const USER = process.env.SCADIA_TEST_TD_USER || 'root';
const PASS = process.env.SCADIA_TEST_TD_PASS || 'taosdata';
const DATABASE = 'scadia_contract_' + process.pid;

const TAG_ID = 'contract-tag';
const PROBE_TAG = 'contract-probe';

function makeLogger(sink) {
    return {
        info: (m) => sink.push('info:' + m),
        warn: (m) => sink.push('warn:' + m),
        error: (m) => sink.push('error:' + m)
    };
}

/**
 * The options to hand the driver.
 *
 * WHY THIS IS NOT A BARE {host, port, user, passwd} - a real defect, measured 2026-10-06.
 * The driver's Cursor builds its URL out of the option object itself:
 *
 *     `\${uri.scheme}://\${uri.host}:\${uri.port}\${uri.path}`
 *
 * and it only fills scheme/path in when they are already present, so an options object WITHOUT
 * them produces the string "undefined://127.0.0.1:6041undefined" and node-fetch throws `Invalid URL`.
 * That is the reason this fixture reported for being pending ON EVERY MACHINE, CONTAINER OR NOT:
 * the fixture never reached a socket at all, so it could not tell "no server" apart from "cannot
 * even build the request". The driver exports its own defaults (scheme http, path /rest/sql/) and
 * the adapter already starts from them with Object.assign; the fixture now does the same, which
 * makes the pending reason a real connection error and lets the suite run the moment a server
 * answers.
 */
function connectionOptions() {
    return Object.assign({}, driverOptions, { host: HOST, port: PORT, user: USER, passwd: PASS });
}

/** Reachability is decided by the driver, not by the adapter - the adapter swallows errors. */
async function canConnect() {
    try {
        const cursor = connect(connectionOptions()).cursor();
        await cursor.query('SHOW DATABASES');
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

async function adminQuery(sql) {
    const cursor = connect(connectionOptions()).cursor();
    return cursor.query(sql);
}

let reachability = null;

describe('TDengine contract fixture', function () {
    before(async function () {
        reachability = await canConnect();
        if (!reachability.ok) {
            console.log('\n    [contract/tdengine] no server reachable at ' + HOST + ':' + PORT +
                ' - ' + reachability.reason);
            console.log('    [contract/tdengine] prove it with: npm run test:backends:up && npm run test:contract\n');
        }
    });

    after(async function () {
        if (reachability && reachability.ok) {
            try { await adminQuery('DROP DATABASE IF EXISTS ' + DATABASE); }
            catch (err) { /* the container is disposable anyway */ }
        }
    });

    beforeEach(function () {
        if (reachability && !reachability.ok) { this.skip(); }
    });

    const fixture = {
        label: 'TDengine',

        async open() {
            const settings = {
                daqstore: {
                    type: 'TDengine',
                    host: HOST,
                    port: PORT,
                    database: DATABASE,
                    retention: 'none',
                    credentials: { username: USER, password: PASS }
                }
            };
            const logs = [];
            const logger = makeLogger(logs);

            const tagDef = { id: TAG_ID, name: 'Contract Tag', type: 'number', daq: { enabled: true }, value: 0 };
            const probeDef = { id: PROBE_TAG, name: 'Contract Probe', type: 'number', daq: { enabled: true }, value: 1 };
            const definitions = {};
            definitions[TAG_ID] = tagDef;
            definitions[PROBE_TAG] = probeDef;

            const adapter = registry.create('tdengine', settings, logger, null, {});
            adapter.setCall((tagid) => definitions[tagid] || null);

            const read = (range) => adapter.getDaqValue(TAG_ID, range[0], range[1]);

            // TDengine stamps rows with NOW on arrival, so the fixture learns the timestamp
            // from the data rather than dictating it - the same rule the shared suite follows.
            await waitUntil(async () => {
                adapter.addDaqValues({ [PROBE_TAG]: probeDef }, 'contract-device', 'contract-device');
                await delay(120);
                return (await adapter.getDaqValue(PROBE_TAG, ALL_TIME[0], ALL_TIME[1])).length > 0;
            }, 40000, 'the TDengine adapter to accept a write');

            return {
                adapter: adapter,
                tagId: TAG_ID,
                logs: logs,

                async write(value) {
                    tagDef.value = value;
                    await waitUntil(async () => {
                        adapter.addDaqValues({ [TAG_ID]: tagDef }, 'contract-device', 'contract-device');
                        await delay(120);
                        return (await read(ALL_TIME)).length > 0;
                    }, 40000, 'the written sample to become readable');
                },

                read: read,

                async reopen() {
                    // close() is a no-op for the REST client; a fresh instance over the same
                    // database is what "reopen" means for this backend.
                    adapter.close();
                    await delay(100);
                    const again = registry.create('tdengine', settings, logger, null, {});
                    again.setCall((tagid) => definitions[tagid] || null);
                    await waitUntil(async () => (await again.getDaqValue(TAG_ID, ALL_TIME[0], ALL_TIME[1])).length > 0,
                        40000, 'the reopened store to show the committed sample');
                    return { adapter: again };
                },

                async close() {
                    adapter.close();
                }
            };
        }
    };

    defineStorageContract(fixture);
});
