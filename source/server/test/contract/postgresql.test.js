/**
 * D8 - the storage contract suite against a real PostgreSQL.
 *
 * This file is the whole point of "add a backend without moving the architecture": the cases
 * are the SAME shared cases SQLite runs, the adapter is reached through the SAME registry, and
 * the only backend-specific knowledge in the world is the twenty lines of fixture below.
 *
 * It detects its own environment. With a server reachable it runs for real; without one it
 * reports pending WITH A REASON rather than quietly passing, and the coverage guard keeps
 * PostgreSQL marked unproven in the registry until this file can actually run.
 *
 *   npm run test:backends:up      # docker compose, one command
 *   npm run test:contract         # this file now runs for real
 *   npm run test:backends:down
 */

'use strict';

const { Client } = require('pg');

const registry = require('../../runtime/storage/registry');
const { defineStorageContract, waitUntil, delay, ALL_TIME } = require('./_support/storageContractSuite');

const CONNECTION = process.env.SCADIA_TEST_PG_URL || 'postgres://scadia:scadia@127.0.0.1:5432/scadia';
const TAG_ID = 'contract-tag';
const PROBE_TAG = 'contract-probe';

function makeLogger(sink) {
    return {
        info: (m) => sink.push('info:' + m),
        warn: (m) => sink.push('warn:' + m),
        error: (m) => sink.push('error:' + m)
    };
}

/** Setup and teardown talk to the server directly; the tests never see this client. */
function adminClient() {
    return new Client({ connectionString: CONNECTION, connectionTimeoutMillis: 4000 });
}

async function canConnect() {
    const client = adminClient();
    try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return { ok: true };
    } catch (err) {
        try { await client.end(); } catch (ignored) { /* already gone */ }
        return { ok: false, reason: err.message };
    }
}

let reachability = null;

/**
 * The hooks live INSIDE a describe on purpose. A before/beforeEach declared at file scope is
 * attached to mocha global root suite, so it would run for every test in the whole run - the
 * SQLite suite went pending the first time this was written at the top level.
 */
let tableCounter = 0;

const fixture = {
    label: 'PostgreSQL',

    async open() {
        tableCounter += 1;
        const table = 'scadia_contract_' + process.pid + '_' + tableCounter;

        const settings = {
            daqstore: {
                type: 'PostgreSQL',
                host: connectionParts().host,
                port: connectionParts().port,
                database: connectionParts().database,
                tableName: table,
                credentials: connectionParts().credentials
            }
        };
        const logs = [];
        const logger = makeLogger(logs);

        const tagDef = { id: TAG_ID, name: 'Contract Tag', type: 'number', daq: { enabled: true }, value: 0 };
        const probeDef = { id: PROBE_TAG, name: 'Contract Probe', type: 'number', daq: { enabled: true }, value: 1 };
        const definitions = {};
        definitions[TAG_ID] = tagDef;
        definitions[PROBE_TAG] = probeDef;

        let adapter = registry.create('postgresql', settings, logger, null, {});
        adapter.setCall((tagid) => definitions[tagid] || null);

        const read = (range) => adapter.getDaqValue(TAG_ID, range[0], range[1]);

        await waitUntil(async () => {
            adapter.addDaqValues({ [PROBE_TAG]: probeDef }, 'contract-device', 'contract-device');
            await delay(50);
            return (await adapter.getDaqValue(PROBE_TAG, ALL_TIME[0], ALL_TIME[1])).length > 0;
        }, 25000, 'the PostgreSQL adapter to accept a write');

        const handle = {
            adapter: adapter,
            tagId: TAG_ID,
            logs: logs,

            async write(value) {
                tagDef.value = value;
                await waitUntil(async () => {
                    adapter.addDaqValues({ [TAG_ID]: tagDef }, 'contract-device', 'contract-device');
                    await delay(50);
                    return (await read(ALL_TIME)).length > 0;
                }, 25000, 'the written sample to become readable');
            },

            read: read,

            async reopen() {
                // A fresh adapter over the same table, with the same settings.
                adapter.close();
                await delay(100);
                adapter = registry.create('postgresql', settings, logger, null, {});
                adapter.setCall((tagid) => definitions[tagid] || null);
                handle.adapter = adapter;
                await waitUntil(async () => (await read(ALL_TIME)).length > 0, 25000,
                    'the reopened store to show the committed sample');
            },

            async close() {
                try { adapter.close(); } catch (err) { /* already closed */ }
                const client = adminClient();
                try {
                    await client.connect();
                    await client.query('DROP TABLE IF EXISTS ' + table);
                    await client.end();
                } catch (err) { /* best effort: the container is disposable anyway */ }
            }
        };

        return handle;
    }
};

describe('PostgreSQL contract fixture', function () {
    before(async function () {
        reachability = await canConnect();
        if (!reachability.ok) {
            console.log('\n    [contract/postgresql] no server reachable at ' + CONNECTION +
                ' - ' + reachability.reason);
            console.log('    [contract/postgresql] prove it with: npm run test:backends:up && npm run test:contract\n');
        }
    });

    beforeEach(function () {
        if (reachability && !reachability.ok) { this.skip(); }
    });

    // Inside the describe, so the hooks above apply to this suite only.
    defineStorageContract(fixture);
});

function connectionParts() {
    const url = new URL(CONNECTION);
    return {
        host: url.hostname,
        port: Number(url.port) || 5432,
        database: url.pathname.replace(/^\//, '') || 'scadia',
        credentials: {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password)
        }
    };
}
