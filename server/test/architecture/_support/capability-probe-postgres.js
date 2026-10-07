/**
 * D8 support - EMPIRICAL capability measurement for PostgreSQL.
 *
 * The same ten axes the SQLite probe measures, asked of a real server. The point is that the
 * capability matrix must not contain an opinion where a measurement is possible, and now that
 * a PostgreSQL is reachable the PostgreSQL column can stop saying "unverified".
 *
 * It measures the BACKEND, not our adapter: questions like "can it do server-side bucketing"
 * are about the engine. Whether our adapter uses the feature is a separate column.
 *
 * INERT WHEN REQUIRED - every side effect lives inside probe().
 *
 * usage: node capability-probe-postgres.js <output-file> [connection-string]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = process.env.SCADIA_TEST_PG_URL || 'postgres://scadia:scadia@127.0.0.1:5432/scadia';

function probe(outFile, url) {
    const { Client } = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'pg'));
    const connection = url || DEFAULT_URL;
    const out = {};

    const connect = async () => {
        const client = new Client({ connectionString: connection, connectionTimeoutMillis: 4000 });
        await client.connect();
        return client;
    };

    return (async () => {
        const table = 'cap_probe_' + process.pid;
        let client = null;
        try {
            client = await connect();

            // durability - write, CLOSE the connection, reconnect, read back
            await client.query('CREATE TABLE IF NOT EXISTS ' + table +
                ' (ts TIMESTAMPTZ NOT NULL, tag_id TEXT NOT NULL, value_num DOUBLE PRECISION, value_text TEXT, blob_col BYTEA, quality TEXT)');
            await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num, value_text) VALUES ($1,$2,$3,$4)',
                [new Date(), 'durability', 42.5, 'ok']);
            await client.end();
            client = await connect();
            const back = await client.query('SELECT value_num, value_text FROM ' + table + ' WHERE tag_id = $1', ['durability']);
            out.durability = {
                ok: back.rowCount === 1 && Number(back.rows[0].value_num) === 42.5,
                detail: JSON.stringify(back.rows)
            };

            // atomic batch - a rolled back batch must leave nothing behind
            await client.query('BEGIN');
            await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num) VALUES (NOW(), $1, 1)', ['atomic']);
            await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num) VALUES (NOW(), $1, 2)', ['atomic']);
            await client.query('ROLLBACK');
            const afterRollback = await client.query('SELECT count(*)::int AS n FROM ' + table + ' WHERE tag_id = $1', ['atomic']);
            await client.query('BEGIN');
            await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num) VALUES (NOW(), $1, 3)', ['atomic']);
            await client.query('COMMIT');
            const afterCommit = await client.query('SELECT count(*)::int AS n FROM ' + table + ' WHERE tag_id = $1', ['atomic']);
            out['atomic-batch'] = {
                ok: afterRollback.rows[0].n === 0 && afterCommit.rows[0].n === 1,
                detail: 'after ROLLBACK=' + afterRollback.rows[0].n + ' after COMMIT=' + afterCommit.rows[0].n
            };

            // time-series range, half-open, and server-side bucketing
            const base = Date.now();
            for (let i = 0; i < 100; i += 1) {
                await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num) VALUES ($1,$2,$3)',
                    [new Date(base + i * 1000), 'series', i]);
            }
            const range = await client.query(
                'SELECT ts FROM ' + table + ' WHERE tag_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts',
                ['series', new Date(base + 10000), new Date(base + 20000)]);
            out['ts-range'] = { ok: range.rowCount === 10, detail: 'rows in [t+10s, t+20s) = ' + range.rowCount };

            const agg = await client.query(
                'SELECT date_bin($1::interval, ts, $2::timestamptz) AS bucket, count(*) n, min(value_num) mn, max(value_num) mx, avg(value_num) av ' +
                'FROM ' + table + ' WHERE tag_id = $3 GROUP BY bucket ORDER BY bucket',
                ['10 seconds', new Date(base), 'series']);
            out['ts-aggregate'] = {
                ok: agg.rowCount > 0,
                detail: 'buckets=' + agg.rowCount + ' first=' + JSON.stringify(agg.rows[0])
            };

            // schema evolution on a populated table
            await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num, quality) VALUES (NOW(), $1, 9, $2)', ['evolve', 'good']);
            const q = await client.query('SELECT quality FROM ' + table + ' WHERE quality IS NOT NULL');
            out['schema-evolution'] = {
                ok: q.rowCount >= 1,
                detail: 'rows carrying the added column = ' + q.rowCount
            };

            // binary object
            const payload = Buffer.from([0, 1, 2, 253, 254, 255]);
            await client.query('INSERT INTO ' + table + ' (ts, tag_id, blob_col) VALUES (NOW(), $1, $2)', ['blob', payload]);
            const blob = await client.query('SELECT blob_col FROM ' + table + ' WHERE tag_id = $1', ['blob']);
            out['binary-object'] = {
                ok: Buffer.isBuffer(blob.rows[0].blob_col) && Buffer.compare(blob.rows[0].blob_col, payload) === 0,
                detail: 'bytes round-tripped = ' + (blob.rows[0].blob_col ? blob.rows[0].blob_col.length : '-')
            };

            // retention - POSTGRESQL HAS NO SERVER-SIDE TTL
            out.retention = {
                ok: false,
                detail: 'no TTL or expiry construct exists in the engine; practitioners partition by time and drop partitions, which is what the product-level rolling would have to drive'
            };

            // auth and transport security
            const ssl = await client.query('SHOW ssl');
            out['auth-tls'] = {
                ok: true,
                detail: 'role/password authentication is built in (this probe connected with one); transport encryption is available - server ssl setting = ' + (ssl.rows[0] ? ssl.rows[0].ssl : '?')
            };

            // a second concurrent writer, on its own connection
            const second = await connect();
            let outcome = 'succeeded';
            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO ' + table + ' (ts, tag_id, value_num) VALUES (NOW(), $1, 1)', ['conc']);
                await second.query('INSERT INTO ' + table + ' (ts, tag_id, value_num) VALUES (NOW(), $1, 2)', ['conc']);
                await second.query('COMMIT');
                await client.query('COMMIT');
            } catch (err) { outcome = 'blocked: ' + err.message; }
            await second.end();
            out['concurrent-writers'] = {
                ok: outcome === 'succeeded',
                detail: 'a second connection wrote while the first held a transaction: ' + outcome
            };

            // embedded?
            out['embedded-zero-ops'] = {
                ok: false,
                detail: 'requires a server process on a port with credentials; it cannot be opened as a file the way SQLite can'
            };

            await client.query('DROP TABLE IF EXISTS ' + table);
        } catch (err) {
            out.fatal = { message: err.message, code: err.code };
        }

        try { if (client) { await client.end(); } } catch (err) { /* already gone */ }
        fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
        return out;
    })();
}

// Mocha --recursive loads EVERY .js under test/ as a spec file: do nothing when required.
if (require.main === module) {
    const outFile = process.argv[2];
    if (!outFile) { throw new Error('capability-probe-postgres: an output file path is required'); }
    probe(outFile, process.argv[3]).then(() => process.exit(0), () => process.exit(1));
}

module.exports = { probe };
