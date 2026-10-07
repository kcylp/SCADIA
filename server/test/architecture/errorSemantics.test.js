/**
 * D1 / class 4 of 6 - ERROR SEMANTICS.
 *
 * Contract 10 fixed the DAQ query semantics: "no data", "device offline" and "tag
 * unknown" must not be the same answer. This class guards that the storage plane keeps
 * telling the difference, and that it never fails by going quiet.
 *
 * Behaviour that needs its own process (a rejection that would kill the runner, or a
 * monkey-patched factory) is measured by a probe under _support/ and reported as data.
 */

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const arch = require('./_support/architecture');
const { runProbe } = require('./_support/child-probe');

describe('architecture: error semantics', function () {
    const daqstorage = require(path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'daqstorage'));

    /** Routing is a behaviour, so it is measured once and reused. */
    let routingMeasurement = null;
    const routing = () => {
        if (!routingMeasurement) { routingMeasurement = runProbe('routing-probe.js'); }
        return routingMeasurement;
    };

    /** Same for the adapter probe used by the two A-07 checks below: one child run, two readers. */
    let adapterMeasurement = null;
    const adapterProbe = () => {
        if (!adapterMeasurement) { adapterMeasurement = runProbe('backend-config-probe.js'); }
        return adapterMeasurement;
    };

    it('querySeries answers with a status per tag instead of throwing', async function () {
        const cases = [
            { name: 'no tags', tags: [], from: 0, to: 1000 },
            { name: 'unknown tag', tags: ['no.such.tag'], from: 0, to: 1000 },
            { name: 'non-numeric range', tags: ['a'], from: NaN, to: 1000 },
            { name: 'inverted range', tags: ['a'], from: 1000, to: 0 },
            { name: 'range beyond the contract maximum', tags: ['a'], from: 0, to: 400 * 24 * 60 * 60 * 1000 },
            { name: 'more tags than the contract allows', tags: Array.from({ length: 201 }, (_v, i) => 't' + i), from: 0, to: 1000 }
        ];

        for (const c of cases) {
            let envelope;
            try { envelope = await daqstorage.querySeries(c.tags, c.from, c.to); }
            catch (err) { throw new Error('querySeries threw on "' + c.name + '": ' + err.message); }

            expect(envelope, c.name + ': must return an envelope').to.be.an('object');
            expect(envelope.contractVersion, c.name + ': envelope must be versioned').to.equal(1);
            expect(envelope.requested.interval, c.name + ': half-openness must be stated').to.equal('[from,to)');
            for (const tag of c.tags) {
                expect(envelope.status, c.name + ': ' + tag + ' must carry a status').to.have.property(tag);
                expect(Object.values(daqstorage.QUERY_STATUS), c.name + ': status must come from the contract vocabulary')
                    .to.include(envelope.status[tag]);
            }
        }
    });

    it('the query status vocabulary is unique and machine-stable', function () {
        const values = Object.values(daqstorage.QUERY_STATUS);
        expect(new Set(values).size, 'duplicate status value').to.equal(values.length);
        for (const v of values) {
            expect(v, 'status values are lowercase kebab-case').to.match(/^[a-z]+(-[a-z]+)*$/);
        }
        for (const required of ['OK', 'UNKNOWN_TAG', 'DAQ_DISABLED', 'NO_DATA', 'BACKEND_ERROR', 'RANGE_TOO_LARGE']) {
            expect(daqstorage.QUERY_STATUS, 'QUERY_STATUS must still distinguish ' + required).to.have.property(required);
        }
    });

    it('a limit breach is an explicit status, never a silent truncation', async function () {
        const tooMany = await daqstorage.querySeries(
            Array.from({ length: 201 }, (_v, i) => 't' + i), 0, 1000);
        expect(tooMany.status.t0).to.equal(daqstorage.QUERY_STATUS.TOO_MANY_TAGS);

        const tooLong = await daqstorage.querySeries(['a'], 0, 400 * 24 * 60 * 60 * 1000);
        expect(tooLong.status.a).to.equal(daqstorage.QUERY_STATUS.RANGE_TOO_LARGE);
    });

    it('the storage plane never terminates the process', function () {
        const offenders = [];
        for (const f of arch.listJsFiles(path.join(arch.SERVER_ROOT, 'runtime', 'storage'))) {
            if (/process\.exit\s*\(/.test(arch.readSource(f))) { offenders.push(arch.rel(f)); }
        }
        expect(offenders, 'storage must fail as data, not by killing the host').to.deep.equal([]);
    });

    it('the storage plane never swallows an error without saying so', function () {
        const offenders = [];
        for (const f of arch.listJsFiles(path.join(arch.SERVER_ROOT, 'runtime', 'storage'))) {
            const raw = fs.readFileSync(f, 'utf8').split('\n');
            const stripped = arch.stripComments(fs.readFileSync(f, 'utf8')).split('\n');
            stripped.forEach((stripLine, i) => {
                if (!/catch\s*\([^)]*\)\s*\{\s*\}\s*;?\s*$/.test(stripLine)) { return; }
                const full = raw[i] || '';
                const previous = (raw[i - 1] || '').trim();
                const hasInline = /\/\*[\s\S]*\*\//.test(full) || /\/\//.test(full.split('catch')[0]);
                const hasAbove = previous.endsWith('*/') || previous.startsWith('//') ||
                    previous.startsWith('*') || previous.startsWith('/*');
                if (hasInline || hasAbove) { return; }
                offenders.push(arch.rel(f) + ':' + (i + 1));
            });
        }
        expect(offenders, 'an empty catch must say why it is empty:\n' + offenders.join('\n')).to.deep.equal([]);
    });

    it('the storage plane never swallows a caught error without saying so', function () {
        // A caught error that is never read is a failure nobody will ever see. Either
        // use it, or say in a comment why doing nothing is correct.
        // A-08 used to sit here pinned: the legacy read path rejected with ['ERR', ...],
        // dropping the cause and logging nothing. D5 replaced it with the real error.
        const unexplained = [];
        for (const f of arch.listJsFiles(path.join(arch.SERVER_ROOT, 'runtime', 'storage'))) {
            for (const c of arch.caughtBindings(f)) {
                if (c.usesBinding || c.explained) { continue; }
                unexplained.push(arch.rel(f) + ':' + c.line + '  catch(' + c.name + ') { ' + c.body + ' }');
            }
        }
        expect(unexplained, 'undeclared error swallowing in the storage plane:\n' +
            unexplained.join('\n')).to.deep.equal([]);
    });

    it('every spelling either end can send routes to the backend it names', function () {
        const measured = routing().routing;

        expect(measured.SQlite).to.equal('SQlite');
        expect(measured.influxDB).to.equal('influxDB');
        expect(measured.influxDB18).to.equal('influxDB');
        expect(measured.TDengine).to.equal('TDengine');
        expect(measured.questDB).to.equal('questDB');

        // The two legacy spellings. 'influxDB 1.8' is the client enum VALUE - a dropdown
        // label, not what the client sends (the template binds the member name), but it
        // sits in old settings files and in the model, so it must not fall through to a
        // backend it does not name.
        expect(measured['influxDB 1.8']).to.equal('influxDB');
        expect(measured.QuestDB).to.equal('questDB');
    });

    it('an unknown daqstore type is refused instead of silently becoming SQLite', function () {
        const measured = routing();
        expect(measured.routing.MySQL, 'an unknown type must not pick a backend at all').to.equal(null);
        expect(measured.diagnostics.MySQL.join(' '), 'and it must say why it refused')
            .to.match(/refused:.*MySQL/);
    });

    it('a backend handed an unusable configuration degrades instead of killing the host (A-07, closed at D9)', function () {
        // Pinky-promise-free: measured in a child process, because the failure is an
        // unhandled rejection and would otherwise terminate this runner.
        const measured = adapterProbe().tdengine;

        // What A-07 looked like before D9:
        //  1. create() reports success for a configuration it cannot possibly use;
        //  2. the failure escapes as an unhandled rejection the caller cannot catch
        //     (tdengine/index.js:116 - `this.init().then(...)` with no rejection handler);
        //  3. Node terminates the process on an unhandled rejection by default, so a typo
        //     in the DAQ credentials is a crash, not a message.
        expect(measured.syncThrow, 'construction must not throw at the caller').to.equal(null);
        expect(measured.returnedAHandle, 'it still hands back a handle').to.equal(true);
        expect(measured.unhandledRejections,
            'an unusable configuration must not escape as an unhandled rejection')
            .to.deep.equal([]);
        expect(measured.readWhenDisconnected,
            'and reading from it must settle with no data, not hang and not reject')
            .to.deep.equal([]);
    });

    it('every backend that talks to a server answers a read with no data when it is not connected (A-07, batch 90-B)', function () {
        // A-07 was pinned on one adapter and was sitting in four of them. Measured before the
        // fix, all four rejected: TDengine with 'not connected' (runtime/storage/tdengine
        // /index.js:130), InfluxDB with a TypeError from dereferencing the client it never built
        // (there was no guard at all), and PostgreSQL and QuestDB with ECONNREFUSED - because
        // both of those tested `!pool`, and the pool is constructed BEFORE anything is proven
        // reachable, so a server that is DOWN leaves pool non-null and the read falls through to
        // a real query.
        //
        // SQLite is deliberately not in the probe: it needs no server, it is already correct
        // (runtime/storage/sqlite/index.js:381-387 answers [] for a tag it has no map for), and
        // it opens a sqlite3 native handle that would stop the probe's child from exiting - the
        // same reason test/storage stays out of the gate. It is pinned, container-free, in
        // test/storage/disconnectedRead.test.js.
        const measured = adapterProbe();
        expect(measured.disconnectedReads, 'a read on a backend that is not connected must settle ' +
            'with no data: not reject, not hang. Each key is the measured outcome of one ' +
            'getDaqValue() on an adapter created with an unusable configuration.')
            .to.deep.equal({
                tdengine: 'empty',
                influxdb: 'empty',
                postgresql: 'empty',
                questdb: 'empty'
            });
    });
});
