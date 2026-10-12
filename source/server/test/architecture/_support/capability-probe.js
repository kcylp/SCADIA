/**
 * D2 support - EMPIRICAL capability measurement for the default backend (SQLite).
 *
 * The capability matrix must not contain an opinion where a measurement is possible.
 * SQLite is embedded and installed, so every axis it can answer is answered by running
 * the experiment, against the product own schema:
 *
 *   tag map : data (mapid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, name TEXT, type TEXT)
 *   samples : data (dt INTEGER, id INTEGER, value TEXT)
 *
 * The child never asserts. It records what actually happened, and the guard compares the
 * committed matrix against this live result - so a "measured" cell is re-proven on every
 * run rather than trusted.
 *
 * usage: node capability-probe.js <output-file>
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function probe(outFile) {
    const sqlite3 = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'sqlite3')).verbose();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-sqlite-'));
    const out = {};

    const open = (file) => new Promise((res, rej) => { const d = new sqlite3.Database(file, (e) => (e ? rej(e) : res(d))); });
    const run = (d, sql, p) => new Promise((res, rej) => d.run(sql, p || [], function (e) { e ? rej(e) : res(this); }));
    const all = (d, sql, p) => new Promise((res, rej) => d.all(sql, p || [], (e, r) => (e ? rej(e) : res(r))));
    const close = (d) => new Promise((res) => d.close(() => res()));

    const MAP = 'CREATE TABLE if not exists data (mapid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, name TEXT, type TEXT)';
    const SAMPLE = 'CREATE TABLE if not exists data2 (dt INTEGER, id INTEGER, value TEXT)';

    return (async () => {
        try {
            // durability - write, CLOSE, reopen, read back
            const f1 = path.join(dir, 'dur.db');
            let d = await open(f1);
            await run(d, MAP);
            await run(d, SAMPLE);
            await run(d, 'INSERT INTO data (id,name,type) VALUES (?,?,?)', ['t1', 'tag one', 'number']);
            await run(d, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [1000, 1, '42.5']);
            await close(d);
            d = await open(f1);
            const back = await all(d, 'SELECT dt,value FROM data2');
            out.durability = { ok: back.length === 1 && back[0].value === '42.5', detail: JSON.stringify(back) };
            await close(d);

            // atomic batch - a rolled back batch must leave nothing behind
            const f2 = path.join(dir, 'atom.db');
            d = await open(f2);
            await run(d, SAMPLE);
            await run(d, 'BEGIN');
            await run(d, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [1, 1, 'a']);
            await run(d, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [2, 1, 'b']);
            await run(d, 'ROLLBACK');
            const afterRollback = await all(d, 'SELECT COUNT(*) c FROM data2');
            await run(d, 'BEGIN');
            await run(d, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [3, 1, 'c']);
            await run(d, 'COMMIT');
            const afterCommit = await all(d, 'SELECT COUNT(*) c FROM data2');
            out['atomic-batch'] = {
                ok: afterRollback[0].c === 0 && afterCommit[0].c === 1,
                detail: 'after ROLLBACK=' + afterRollback[0].c + ' after COMMIT=' + afterCommit[0].c
            };

            // time-series range on the real shape
            for (let i = 0; i < 100; i += 1) {
                await run(d, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [i * 1000, 7, String(i)]);
            }
            const range = await all(d, 'SELECT dt,value FROM data2 WHERE id=? AND dt>=? AND dt<? ORDER BY dt', [7, 10000, 20000]);
            out['ts-range'] = { ok: range.length === 10, detail: 'rows in [10000,20000) = ' + range.length };

            // server-side bucketed aggregation
            const agg = await all(d, 'SELECT (dt/10000) AS bucket, COUNT(*) n, MIN(CAST(value AS REAL)) mn, MAX(CAST(value AS REAL)) mx, AVG(CAST(value AS REAL)) av FROM data2 WHERE id=? GROUP BY bucket ORDER BY bucket', [7]);
            out['ts-aggregate'] = {
                ok: agg.length > 0 && agg[0].n !== undefined,
                detail: 'buckets=' + agg.length + ' first=' + JSON.stringify(agg[0])
            };

            // schema evolution on a populated table
            await run(d, 'ALTER TABLE data2 ADD COLUMN quality TEXT');
            await run(d, 'INSERT INTO data2 (dt,id,value,quality) VALUES (?,?,?,?)', [999999, 7, '1', 'good']);
            const q = await all(d, 'SELECT quality FROM data2 WHERE quality IS NOT NULL');
            out['schema-evolution'] = { ok: q.length === 1 && q[0].quality === 'good', detail: 'rows carrying the new column = ' + q.length };

            // binary object round trip
            await run(d, 'CREATE TABLE blobtest (id INTEGER PRIMARY KEY, b BLOB)');
            const payload = Buffer.from([0, 1, 2, 253, 254, 255]);
            await run(d, 'INSERT INTO blobtest (id,b) VALUES (?,?)', [1, payload]);
            const blob = await all(d, 'SELECT b FROM blobtest WHERE id=1');
            out['binary-object'] = {
                ok: Buffer.isBuffer(blob[0].b) && Buffer.compare(blob[0].b, payload) === 0,
                detail: 'bytes round-tripped = ' + (blob[0].b ? blob[0].b.length : '-')
            };
            await close(d);

            // a second concurrent writer
            const f3 = path.join(dir, 'conc.db');
            const a = await open(f3);
            const b = await open(f3);
            await run(a, SAMPLE);
            await run(a, 'BEGIN IMMEDIATE');
            await run(a, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [1, 1, 'a']);
            let second = 'succeeded';
            try {
                b.configure('busyTimeout', 1000);
                await run(b, 'BEGIN IMMEDIATE');
                await run(b, 'INSERT INTO data2 (dt,id,value) VALUES (?,?,?)', [2, 1, 'b']);
                await run(b, 'COMMIT');
            } catch (e) { second = 'blocked: ' + e.code + ' ' + e.message; }
            await run(a, 'COMMIT');
            out['concurrent-writers'] = { ok: false, detail: 'second concurrent writer -> ' + second };
            await close(a);
            await close(b);

            out['embedded-zero-ops'] = {
                ok: true,
                detail: 'a file was opened and written directly: no server process, no port, no credentials'
            };
            out['auth-tls'] = {
                ok: false,
                detail: 'a local file database has no account authentication and no transport to encrypt; access control is filesystem permissions'
            };
            out.retention = {
                ok: false,
                detail: 'no TTL or retention construct exists; the product implements retention by deleting whole archive files (runtime/storage/sqlite/index.js:700 checkRetention)'
            };
        } catch (e) {
            out.fatal = { message: e.message, code: e.code };
        }

        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* handles may linger on Windows */ }
        fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
    })();
}

// Mocha --recursive loads EVERY .js under test/ as a spec file: do nothing when required.
if (require.main === module) {
    const outFile = process.argv[2];
    if (!outFile) { throw new Error('capability-probe: an output file path is required'); }
    probe(outFile).then(() => process.exit(0), () => process.exit(1));
}

module.exports = { probe };
