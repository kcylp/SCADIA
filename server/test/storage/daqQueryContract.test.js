'use strict';

/**
 * DAQ query semantics (2026-09-29, contract 10 / ledger L-14).
 *
 * Before this change every situation below answered the same thing - an empty array -
 * so an AI consumer could not tell "the value never moved" from "the device was
 * offline" from "that tag does not exist". querySeries() reports the difference, and
 * it never interpolates across a gap.
 */

const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

/** Resolved once, at module scope: see the note inside Module._load. */
const STORAGE_DIR = 'storage' + require('path').sep;

/** rows handed back by the stubbed backend, keyed by tagId */
let ROWS = {};
let ORIGINAL_LOAD = null;
let daqstorage = null;

/** Minimal stand-in for the SQLite DAQ backend: only the surface we exercise. */
const fakeSqlite = {
    create: () => ({
        setCall: () => () => {},
        getDaqMap: (tagId) => (Object.prototype.hasOwnProperty.call(ROWS, tagId) ? { [tagId]: true } : {}),
        getDaqValue: (tagId) => Promise.resolve(ROWS[tagId] || []),
        close: () => {}
    }),
    checkRetention: () => {}
};

describe('DAQ query semantics (contract v1)', () => {
    let dbDir;
    let devicesById;

    beforeEach(() => {
        ORIGINAL_LOAD = Module._load;
        // A real directory, not process.cwd(): pointing a DAQ store at the working directory
        // makes the test write a database into the repository it is testing.
        dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-daqquery-'));
        Module._load = function (request, parent) {
            // NOTE: never call require() before the cheap string test. Module._load is what
            // require() itself goes through, so a require evaluated unconditionally here
            // recurses until the stack dies.
            if (request === './sqlite' && parent && parent.filename) {
                // The stopper moves with the architecture: since D5 the adapter is created by
                // ./registry.js, so the fake has to answer for that parent too.
                const ownsTheAdapter =
                    parent.filename.endsWith(STORAGE_DIR + 'daqstorage.js') ||
                    parent.filename.endsWith(STORAGE_DIR + 'registry.js');
                if (ownsTheAdapter) { return fakeSqlite; }
            }
            return ORIGINAL_LOAD.apply(this, arguments);
        };
        delete require.cache[require.resolve('../../runtime/storage/daqstorage')];
        daqstorage = require('../../runtime/storage/daqstorage');

        devicesById = {
            'device-a': {
                id: 'device-a',
                tags: {
                    'tag-live': { id: 'tag-live', daq: { enabled: true } },
                    'tag-nodaq': { id: 'tag-nodaq', daq: { enabled: false } }
                }
            }
        };
        const owner = { 'tag-live': 'device-a', 'tag-nodaq': 'device-a' };
        const silent = { info: () => {}, warn: () => {}, error: () => {} };

        daqstorage.init({ dbDir: dbDir, daqstore: { type: 'SQlite' } }, silent, {
            devices: {
                resolveTag: (tagId) => {
                    if (!owner[tagId]) { return null; }
                    return { deviceId: owner[tagId], tagId: tagId, ambiguous: false, candidates: [owner[tagId]] };
                }
            },
            project: { getDevices: () => devicesById },
            logger: silent
        });
        daqstorage.addDaqNode('device-a', () => undefined);
    });

    afterEach(() => {
        Module._load = ORIGINAL_LOAD;
        delete require.cache[require.resolve('../../runtime/storage/daqstorage')];
        try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch (err) { /* disposable */ }
    });

    const FROM = 1000;
    const TO = 2000;

    it('uses a half-open interval [from, to)', async () => {
        ROWS = {
            'tag-live': [
                { dt: FROM - 1, value: 1 },
                { dt: FROM, value: 2 },
                { dt: FROM + 500, value: 3 },
                { dt: TO, value: 4 },
                { dt: TO + 1, value: 5 }
            ]
        };

        const res = await daqstorage.querySeries(['tag-live'], FROM, TO);

        expect(res.requested.interval).to.equal('[from,to)');
        expect(res.status['tag-live']).to.equal('ok');
        expect(res.series['tag-live'].map(p => p.v)).to.deep.equal([2, 3]);
    });

    it('separates an unknown tag from a tag with no data', async () => {
        ROWS = { 'tag-live': [] };
        const res = await daqstorage.querySeries(['tag-live', 'does-not-exist'], FROM, TO);

        expect(res.status['does-not-exist']).to.equal('unknown-tag');
        expect(res.status['tag-live']).to.equal('no-data');
    });

    it('reports a tag whose archiving is switched off', async () => {
        ROWS = { 'tag-nodaq': [{ dt: FROM + 10, value: 9 }] };
        const res = await daqstorage.querySeries(['tag-nodaq'], FROM, TO);

        expect(res.status['tag-nodaq']).to.equal('daq-disabled');
        expect(res.series['tag-nodaq']).to.deep.equal([]);
    });

    it('never interpolates: a gap stays a gap and is reported', async () => {
        ROWS = {
            'tag-live': [
                { dt: 1000, value: 1 },
                { dt: 1100, value: 2 },
                { dt: 1200, value: 3 },
                { dt: 1900, value: 4 }
            ]
        };

        const res = await daqstorage.querySeries(['tag-live'], FROM, TO);
        const points = res.series['tag-live'];

        expect(points).to.have.length(4);
        expect(points.map(p => p.v)).to.deep.equal([1, 2, 3, 4]);
        expect(res.gaps['tag-live']).to.have.length(1);
        expect(res.gaps['tag-live'][0]).to.deep.equal({ from: 1200, to: 1900, reason: 'no-data' });
    });

    it('declares the actual resolution of the series', async () => {
        ROWS = {
            'tag-live': [
                { dt: 1000, value: 1 },
                { dt: 1100, value: 2 },
                { dt: 1200, value: 3 }
            ]
        };

        const res = await daqstorage.querySeries(['tag-live'], FROM, TO);
        expect(res.resolution['tag-live'].medianStrideMs).to.equal(100);
        expect(res.resolution['tag-live'].points).to.equal(3);
    });

    it('refuses an oversized range explicitly instead of truncating', async () => {
        const res = await daqstorage.querySeries(['tag-live'], 0, 10 * 365 * 24 * 3600 * 1000);

        expect(res.status['tag-live']).to.equal('range-too-large');
        expect(res.series['tag-live']).to.deep.equal([]);
    });

    it('refuses too many tags explicitly', async () => {
        const many = Array.from({ length: 5 }, (_v, i) => 'tag-' + i);
        const res = await daqstorage.querySeries(many, FROM, TO, { limits: { maxTags: 2 } });

        expect(res.status['tag-0']).to.equal('too-many-tags');
    });

    it('marks quality as unknown rather than pretending it is good', async () => {
        ROWS = { 'tag-live': [{ dt: 1500, value: 7 }] };
        const res = await daqstorage.querySeries(['tag-live'], FROM, TO);

        expect(res.series['tag-live'][0].quality).to.equal('unknown');
    });

    it('supports cancellation without inventing data', async () => {
        ROWS = { 'tag-live': [{ dt: 1500, value: 7 }] };
        const res = await daqstorage.querySeries(['tag-live'], FROM, TO, { signal: { cancelled: true } });

        expect(res.status['tag-live']).to.equal('cancelled');
        expect(res.series['tag-live']).to.deep.equal([]);
    });

    it('reports whether the whole query was answered', async () => {
        ROWS = { 'tag-live': [{ dt: 1500, value: 7 }] };
        const complete = await daqstorage.querySeries(['tag-live'], FROM, TO);
        const partial = await daqstorage.querySeries(['tag-live', 'nope'], FROM, TO);

        expect(daqstorage.isQueryComplete(complete)).to.equal(true);
        expect(daqstorage.isQueryComplete(partial)).to.equal(false);
    });

    it('returns a JSON-serialisable envelope', async () => {
        ROWS = { 'tag-live': [{ dt: 1500, value: 7 }] };
        const res = await daqstorage.querySeries(['tag-live'], FROM, TO);

        expect(() => JSON.stringify(res)).to.not.throw();
        expect(typeof res.series['tag-live'][0].t).to.equal('number');
    });
});
