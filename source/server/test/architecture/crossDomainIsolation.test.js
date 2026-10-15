/**
 * D1 / class 6 of 6 - CROSS-DOMAIN ISOLATION.
 *
 * Each domain owns its data. The storage plane can only be extracted one domain at a
 * time if no domain is holding another domain's handle, and the extraction cannot
 * quietly re-couple two domains along the way.
 */

'use strict';

const { expect } = require('chai');
const path = require('path');
const arch = require('./_support/architecture');
const debt = require('./_support/known-debt');

/** The runtime domain a file belongs to: 'utils.js' / 'index.js' collapse to '(root)'. */
function domainOf(relPath) {
    if (!relPath.startsWith('runtime/')) { return null; }
    const parts = relPath.split('/');
    return parts.length === 2 ? '(root)' : parts[1];
}

/** Modules that own a private data store: a domain's own store, or a DAQ backend adapter. */
const PRIVATE_STORES = /(-storage\.js$)|(^runtime\/storage\/)/;

/**
 * The shared storage plane. Every domain is MEANT to reach these - that is what closing
 * D7 means - so they are not anybody's private store.
 */
const SHARED_PLANE = [
    'runtime/storage/contract.js',
    'runtime/storage/registry.js',
    'runtime/storage/databases.js'
];

describe('architecture: cross-domain isolation', function () {
    const { all } = arch.serverLayers();
    const graph = arch.buildGraph(all);

    const domainEdges = new Set();
    for (const [from, targets] of graph) {
        const fromDomain = domainOf(arch.rel(from));
        if (fromDomain === null) { continue; }
        for (const t of targets) {
            const toDomain = domainOf(arch.rel(t));
            if (toDomain === null || toDomain === fromDomain) { continue; }
            domainEdges.add(fromDomain + ' -> ' + toDomain);
        }
    }

    it('the set of cross-domain dependencies is exactly the frozen baseline', function () {
        const measured = [...domainEdges].sort();
        const frozen = [...debt.CROSS_DOMAIN_BASELINE].sort();
        // A new edge means two domains just became each other's problem. Removing an edge
        // fails too, so the baseline is edited deliberately rather than left to drift.
        expect(measured, 'cross-domain edges changed. New coupling must be justified, and ' +
            'removed coupling must be recorded by editing CROSS_DOMAIN_BASELINE.').to.deep.equal(frozen);
    });

    it('no domain reaches into another domain private store (the shared plane is fair game)', function () {
        const bad = [];
        for (const [from, targets] of graph) {
            const fromRel = arch.rel(from);
            const fromDomain = domainOf(fromRel);
            if (fromDomain === null || fromRel === debt.RUNTIME_ASSEMBLER) { continue; }
            for (const t of targets) {
                const toRel = arch.rel(t);
                const toDomain = domainOf(toRel);
                if (toDomain === null || toDomain === fromDomain) { continue; }
                if (SHARED_PLANE.indexOf(toRel) !== -1) { continue; }
                if (PRIVATE_STORES.test(toRel)) { bad.push(fromRel + '  ->  ' + toRel); }
            }
        }
        expect(bad, 'a domain holding another domain private store:\n' + bad.join('\n')).to.deep.equal([]);
    });

    it('only the registry may name a specific DAQ backend', function () {
        // If anything else can name influxdb/tdengine/questdb/sqlite, "swap the backend"
        // becomes a search across the codebase instead of a change in one place. Since D5
        // that one place is runtime/storage/registry.js - with literal loaders, so this is
        // still provable without running anything.
        // The adapter ENTRY POINTS, not every file living under a backend directory:
        // sqlite/currentstorage.js is the realtime boundary's last-value store, not a DAQ
        // adapter, and the facade is allowed to own it.
        const adapters = ['influxdb', 'tdengine', 'questdb', 'sqlite']
            .map((name) => 'runtime/storage/' + name + '/index.js');
        const bad = [];
        for (const [from, targets] of graph) {
            const fromRel = arch.rel(from);
            if (fromRel === 'runtime/storage/registry.js') { continue; }
            for (const t of targets) {
                const toRel = arch.rel(t);
                if (adapters.includes(toRel)) { bad.push(fromRel + '  ->  ' + toRel); }
            }
        }
        expect(bad, 'ask the registry instead of naming an adapter:\n' + bad.join('\n')).to.deep.equal([]);
    });

    it('the server never requires anything from the client sources', function () {
        const bad = [];
        for (const f of arch.serverTreeFiles()) {
            for (const { spec } of arch.requireSpecifiers(f)) {
                const resolved = arch.resolveRequire(f, spec);
                if (resolved && resolved.startsWith(path.join(arch.CLIENT_ROOT))) {
                    bad.push(arch.rel(f) + '  ->  ' + spec);
                }
                if (spec.includes('client/')) { bad.push(arch.rel(f) + '  ->  ' + spec); }
            }
        }
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('every frozen cross-domain edge is justified by being listed once', function () {
        // Guards the guard: a baseline with duplicates would hide a real removal.
        expect(new Set(debt.CROSS_DOMAIN_BASELINE).size, 'duplicate entries in the baseline')
            .to.equal(debt.CROSS_DOMAIN_BASELINE.length);
        expect(domainEdges.size, 'the measured edge set is not empty').to.be.greaterThan(0);
    });
});
