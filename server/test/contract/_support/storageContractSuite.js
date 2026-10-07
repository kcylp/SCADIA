/**
 * D6 - THE STORAGE CONTRACT SUITE.
 *
 * One set of cases every backend adapter must pass, so that D8-D10 have an acceptance bar
 * instead of a hope. The suite knows nothing about any particular backend: a fixture opens a
 * store and hands back an adapter, and everything below drives only the frozen instance
 * contract from D1 (setCall / addDaqValues / getDaqValue / getDaqMap / close).
 *
 * What is deliberately NOT asserted here:
 *
 *   - ORDERING. The adapter is not required to return rows in time order - SQLite
 *     concatenates archive files ahead of the live database, and TDengine issues a query
 *     with no ORDER BY. Putting rows in order is runtime/storage/daqstorage.js:querySeries()
 *     job, and asserting it here would invent a promise no backend made.
 *   - How samples get their timestamps. Some backends stamp on arrival; the suite learns the
 *     timestamp from the data rather than dictating it.
 *
 * A fixture is:
 *   { label: string, open: async () => ({ adapter, tagId, write(value), close() }) }
 * where write(value) stores one sample for tagId through the adapter public API.
 */

'use strict';

const { expect } = require('chai');

/**
 * A window wide enough to contain anything the run just wrote.
 *
 * NOT Number.MAX_SAFE_INTEGER. That worked while every backend stored epoch milliseconds as
 * an INTEGER, but a backend with a native timestamp type (PostgreSQL TIMESTAMPTZ) cannot
 * express it as a date at all - the driver sends "Invalid Date" and the server rejects it.
 * Ten years ahead is beyond any test and legal in every dialect. The PostgreSQL fill found
 * this on its first run, which is the entire point of a second engine.
 */
const ALL_TIME = [0, Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)];

/**
 * The earliest timestamp in a result. Rows are NOT promised to be ordered - SQLite puts
 * archive files ahead of the live database and TDengine issues no ORDER BY - so "the first
 * sample" is the smallest timestamp, not rows[0].
 */
function earliest(rows) {
    return rows.reduce((min, r) => Math.min(min, Number(r.dt)), Number.MAX_SAFE_INTEGER);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the condition holds, or fail at the deadline. Never a fixed sleep. */
async function waitUntil(condition, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let ok = false;
        try { ok = await condition(); } catch (err) { ok = false; }
        if (ok) { return; }
        if (Date.now() > deadline) { throw new Error('timed out waiting for ' + what); }
        await delay(25);
    }
}

function defineStorageContract(fixture) {
    describe('storage adapter contract (' + fixture.label + ')', function () {
        this.timeout(30000);

        let store = null;
        afterEach(async function () {
            if (store) { await store.close(); store = null; }
        });

        it('exposes exactly the instance contract frozen in D1', async function () {
            store = await fixture.open();
            for (const method of ['setCall', 'addDaqValues', 'getDaqValue', 'getDaqMap', 'close']) {
                expect(store.adapter, 'the facade calls ' + method + ' on every backend')
                    .to.have.property(method).that.is.a('function');
            }
            expect(store.adapter.setCall(function () { return null; }), 'setCall returns the write function')
                .to.be.a('function');
        });

        it('stores a sample and gives it back', async function () {
            store = await fixture.open();
            await store.write(42);
            const rows = await store.read(ALL_TIME);
            expect(rows.length, 'the sample must be readable').to.be.greaterThan(0);
            expect(Number.isFinite(Number(rows[0].dt)), 'every row carries a numeric timestamp').to.equal(true);
        });

        it('answers an unknown tag with an empty list, not an error', async function () {
            store = await fixture.open();
            const rows = await store.adapter.getDaqValue('never-written-tag', ALL_TIME[0], ALL_TIME[1]);
            expect(rows).to.be.an('array');
            expect(rows).to.deep.equal([]);
        });

        it('uses a half-open interval: the sample at "from" is inside', async function () {
            store = await fixture.open();
            await store.write(7);
            const at = earliest(await store.read(ALL_TIME));

            const fromIncluded = await store.adapter.getDaqValue(store.tagId, at, at + 1);
            expect(fromIncluded.length, 'from is inclusive: [from, to)').to.be.greaterThan(0);
        });

        it('uses a half-open interval: the sample at "to" is outside', async function () {
            // This is the case that a BETWEEN-based query fails: BETWEEN is closed on both
            // ends, so the upper bound leaks in. querySeries() filters it back out, which is
            // why the leak survived - but getNodesValues() does not, so a report window
            // [00:00, 24:00) would carry the 24:00 sample.
            store = await fixture.open();
            await store.write(7);
            const at = earliest(await store.read(ALL_TIME));

            const toExcluded = await store.adapter.getDaqValue(store.tagId, at + 1, at + 2);
            expect(toExcluded.length, 'to is exclusive: [from, to)').to.equal(0);

            const windowEndingAtIt = await store.adapter.getDaqValue(store.tagId, at - 100, at);
            expect(windowEndingAtIt.length, 'a window that ends exactly at the sample excludes it').to.equal(0);
        });

        it('returns nothing for a window that ends before the first sample', async function () {
            store = await fixture.open();
            await store.write(7);
            const at = earliest(await store.read(ALL_TIME));
            const before = await store.adapter.getDaqValue(store.tagId, at - 1000, at - 500);
            expect(before).to.deep.equal([]);
        });

        it('still holds the samples after the store is closed and reopened (durability)', async function () {
            store = await fixture.open();
            await store.write(11);
            const before = await store.read(ALL_TIME);
            expect(before.length).to.be.greaterThan(0);
            const at = earliest(before);

            await store.reopen();
            const after = await store.read(ALL_TIME);
            expect(after.length, 'a committed sample survives a restart').to.be.greaterThan(0);
            expect(earliest(after), 'the same sample, still there').to.equal(at);
        });

        it('reports which tags it holds through getDaqMap', async function () {
            store = await fixture.open();
            await store.write(1);
            const map = await store.adapter.getDaqMap(store.tagId);
            expect(map, 'getDaqMap returns a map').to.be.an('object');
            expect(Object.prototype.hasOwnProperty.call(map, store.tagId),
                'the tag it holds must appear in the map it reports').to.equal(true);
        });
    });
}

module.exports = { defineStorageContract, waitUntil, delay, ALL_TIME };
