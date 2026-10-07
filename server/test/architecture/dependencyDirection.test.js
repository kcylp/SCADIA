/**
 * D1 / class 1 of 6 - DEPENDENCY DIRECTION.
 *
 * The storage plane can only be swapped (SQLite -> PostgreSQL -> TDengine -> Dameng)
 * if the arrows point one way. Each rule below is a direction that must never reverse.
 */

'use strict';

const { expect } = require('chai');
const path = require('path');
const arch = require('./_support/architecture');
const debt = require('./_support/known-debt');

describe('architecture: dependency direction', function () {
    const { runtime, api, all } = arch.serverLayers();
    const graph = arch.buildGraph(all);

    const edgesFrom = (files, predicate) => {
        const found = [];
        for (const f of files) {
            for (const target of graph.get(f) || []) {
                if (predicate(arch.rel(f), arch.rel(target))) { found.push(arch.rel(f) + '  ->  ' + arch.rel(target)); }
            }
        }
        return found;
    };

    it('scans a meaningful number of files', function () {
        expect(runtime.length).to.be.greaterThan(80);
        expect(api.length).to.be.greaterThan(15);
    });

    it('the runtime never depends on the api layer', function () {
        // api/ is the transport edge: it may call runtime, never the other way round.
        const bad = edgesFrom(runtime, (from, to) => to.startsWith('api/'));
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('the api layer never depends on the client sources', function () {
        const bad = edgesFrom(api, (from, to) => to.startsWith('client/'));
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('the core never reaches into integrations/ (an integration consumes the core)', function () {
        const bad = [];
        for (const f of all) {
            for (const { spec } of arch.requireSpecifiers(f)) {
                if (/integrations/.test(spec)) { bad.push(arch.rel(f) + '  ->  ' + spec); }
            }
        }
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('the storage plane depends on nothing inside runtime but utils', function () {
        // This is what makes a backend swappable: the storage plane may not know
        // about devices, alarms, project, jobs - it is told, it does not reach.
        const allowed = new Set(['runtime/utils.js']);
        const bad = edgesFrom(
            runtime.filter((f) => arch.rel(f).startsWith('runtime/storage/')),
            (from, to) => to.startsWith('runtime/') && !to.startsWith('runtime/storage/') && !allowed.has(to)
        );
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('the frozen contract planes are dependency-free leaves', function () {
        // Contracts must be the thing everyone else bends to, so they bend to nothing.
        const contracts = arch.listJsFiles(path.join(arch.SERVER_ROOT, 'runtime', 'reporting'))
            .concat([path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'contract.js')]);
        expect(contracts.length).to.be.greaterThan(2);
        const bad = [];
        for (const f of contracts) {
            for (const target of graph.get(f) || []) { bad.push(arch.rel(f) + '  ->  ' + arch.rel(target)); }
        }
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('only runtime/storage may require the sqlite3 package (A-04 closed at D7)', function () {
        const measured = [];
        for (const f of all) {
            if (arch.externalPackages(f).includes('sqlite3')) { measured.push(arch.rel(f)); }
        }
        const inside = measured.filter((p) => p.startsWith('runtime/storage/'));
        const outside = measured.filter((p) => !p.startsWith('runtime/storage/'));

        // the storage plane itself is exactly the two adapters
        expect(inside).to.deep.equal([
            'runtime/storage/databases.js',
            'runtime/storage/sqlite/currentstorage.js',
            'runtime/storage/sqlite/index.js'
        ]);
        // and the known leak, pinned as an exact set
        expect(outside, 'something outside runtime/storage opened its own sqlite3 connection. Ask ' +
            'runtime/storage/databases.js for a handle instead - A-04 was closed at ' +
            debt.LEGACY_SQLITE3_CLOSES_AT + ' and the allowed list is now empty on purpose.')
            .to.deep.equal(debt.LEGACY_SQLITE3_REQUIRERS);
    });

    it('every relative require resolves inside the server tree', function () {
        const strays = [];
        for (const f of all) {
            for (const { spec } of arch.requireSpecifiers(f)) {
                const resolved = arch.resolveRequire(f, spec);
                if (resolved && !resolved.startsWith(arch.SERVER_ROOT)) { strays.push(arch.rel(f) + '  ->  ' + spec); }
            }
        }
        expect(strays, strays.join('\n')).to.deep.equal([]);
    });
});
