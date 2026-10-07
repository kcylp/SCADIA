/**
 * D6 - the storage contract suite, run for real against the default backend.
 *
 * Everything backend-specific lives in the fixture below; the cases themselves are in
 * _support/storageContractSuite.js and know nothing about SQLite.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../../runtime/storage/registry');
const { defineStorageContract, waitUntil, delay, ALL_TIME } = require('./_support/storageContractSuite');

const NODE_ID = 'contract-device';
const TAG_ID = 'contract-tag';
const PROBE_TAG = 'contract-probe';

function makeLogger(sink) {
    return {
        info: (m) => sink.push('info:' + m),
        warn: (m) => sink.push('warn:' + m),
        error: (m) => sink.push('error:' + m)
    };
}

const fixture = {
    label: 'SQLite',

    async open() {
        const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-contract-'));
        const settings = { dbDir: dbDir, daqstore: { type: 'SQlite', retention: 'none' }, daqTokenizer: 0 };
        const logs = [];
        const logger = makeLogger(logs);

        const tagDef = { id: TAG_ID, name: 'Contract Tag', type: 'number', daq: { enabled: true }, value: 0 };
        const probeDef = { id: PROBE_TAG, name: 'Contract Probe', type: 'number', daq: { enabled: true }, value: 1 };

        // The lookup must answer for the tag id it is ASKED about: the adapter calls it to
        // learn a tag's definition the first time it sees one, and a lookup that ignores its
        // argument silently registers whatever tag it happens to return.
        const definitions = {};
        definitions[TAG_ID] = tagDef;
        definitions[PROBE_TAG] = probeDef;
        const lookup = (tagid) => definitions[tagid] || null;

        let adapter = registry.create('sqlite', settings, logger, null, { nodeId: NODE_ID });
        adapter.setCall(lookup);

        let ready = false;

        /**
         * The adapter finishes binding its databases asynchronously and drops any write that
         * arrives first (daqstorage/sqlite/index.js checks an internal initready flag with no
         * error path). Rather than guess a sleep, probe with a SECOND tag until it shows up -
         * a different tag so the cases that count rows on the real tag stay exact.
         */
        async function ensureReady() {
            if (ready) { return; }
            // Two things make this a loop rather than a sleep: the adapter drops writes that
            // arrive before its internal initready flag, AND the first write for a tag only
            // registers the tag in the map - the value lands on a later call.
            await waitUntil(async () => {
                adapter.addDaqValues({ [PROBE_TAG]: probeDef }, 'contract-device', NODE_ID);
                await delay(30);
                let rows = [];
                try { rows = await adapter.getDaqValue(PROBE_TAG, ALL_TIME[0], ALL_TIME[1]); }
                catch (err) { rows = []; }
                return Array.isArray(rows) && rows.length > 0;
            }, 20000, 'the adapter to finish its asynchronous initialisation');
            ready = true;
        }

        const read = (range) => adapter.getDaqValue(TAG_ID, range[0], range[1]);

        const handle = {
            adapter: adapter,
            tagId: TAG_ID,
            logs: logs,

            async write(value) {
                await ensureReady();
                tagDef.value = value;
                // Issued until it is actually readable, for the same reason: the first call
                // maps the tag, the next one stores a value.
                await waitUntil(async () => {
                    adapter.addDaqValues({ [TAG_ID]: tagDef }, 'contract-device', NODE_ID);
                    await delay(30);
                    return (await read(ALL_TIME)).length > 0;
                }, 20000, 'the written sample to become readable');
            },

            read: read,

            async reopen() {
                adapter.close();
                await delay(50);
                adapter = registry.create('sqlite', settings, logger, null, { nodeId: NODE_ID });
                adapter.setCall(lookup);
                handle.adapter = adapter;
                ready = false;
                await ensureReady();
            },

            async close() {
                try { adapter.close(); } catch (err) { /* already closed */ }
                try { fs.rmSync(dbDir, { recursive: true, force: true }); }
                catch (err) { /* sqlite may still hold the file on Windows; the temp dir is disposable */ }
            }
        };

        return handle;
    }
};

defineStorageContract(fixture);
