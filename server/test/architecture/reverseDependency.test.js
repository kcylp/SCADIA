/**
 * D1 / class 2 of 6 - REVERSE DEPENDENCY.
 *
 * Direction (class 1) forbids specific arrows. This class forbids the structure that
 * makes direction unenforceable: cycles, and back-edges into the assembler.
 */

'use strict';

const { expect } = require('chai');
const path = require('path');
const arch = require('./_support/architecture');
const debt = require('./_support/known-debt');

/** The storage plane every domain is meant to reach. */
const SHARED_PLANE = [
    'runtime/storage/contract.js',
    'runtime/storage/registry.js',
    'runtime/storage/databases.js'
];

describe('architecture: reverse dependency', function () {
    const { all } = arch.serverLayers();
    const graph = arch.buildGraph(all);

    it('the require graph of runtime + api is acyclic', function () {
        const cycles = arch.findCycles(graph);
        const rendered = cycles.map((c) => c.map(arch.rel).join(' -> '));
        expect(rendered, 'a require cycle exists; the storage plane cannot be split while it does:\n' +
            rendered.join('\n')).to.deep.equal([]);
    });

    it('the runtime assembler is a root, never a dependency', function () {
        // runtime/index.js wires every domain together. Anything requiring it back
        // would make the whole tree one node and void every other rule here.
        const assembler = path.join(arch.SERVER_ROOT, debt.RUNTIME_ASSEMBLER);
        const importers = [];
        for (const [from, targets] of graph) {
            if (from === assembler) { continue; }
            if (targets.includes(assembler)) { importers.push(arch.rel(from)); }
        }
        expect(importers, 'nothing inside runtime/ or api/ may require runtime/index.js').to.deep.equal([]);
    });

    it('a domain reaches only the SHARED plane, never another domain private store', function () {
        // The shared plane is what every domain is supposed to reach: the D4 contract, the
        // backend registry, and the one place a connection is opened. What must not happen is
        // one domain reaching into another domain PRIVATE store.
        // The reverse view of D7: whoever holds a private sqlite3 handle must not be
        // reachable from another domain, or moving it behind the plane breaks two places.
        const bad = [];
        for (const [from, targets] of graph) {
            const fromRel = arch.rel(from);
            const fromDomain = fromRel.split('/').slice(0, 2).join('/');
            for (const target of targets) {
                const toRel = arch.rel(target);
                const isStorageModule =
                    toRel.startsWith('runtime/storage/') || /-storage\.js$/.test(toRel);
                if (!isStorageModule) { continue; }
                const toDomain = toRel.split('/').slice(0, 2).join('/');
                if (toDomain === fromDomain) { continue; }
                if (fromRel === debt.RUNTIME_ASSEMBLER) { continue; }   // the assembler wires them
                if (SHARED_PLANE.indexOf(toRel) !== -1) { continue; }   // shared by design
                bad.push(fromRel + '  ->  ' + toRel);
            }
        }
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('nothing under runtime/ is reachable only through a test file', function () {
        // A module the product never loads is not part of the product; it is either
        // wired up or it is dead, and dead code must be named in the debt register.
        // the whole shipped tree (test/ excluded), entered at main.js: a module the
        // product can never load is either wired up or dead.
        const liveGraph = arch.buildGraph(arch.serverTreeFiles());
        const reached = new Set();
        const queue = [path.join(arch.SERVER_ROOT, 'main.js')];
        while (queue.length) {
            const n = queue.pop();
            if (reached.has(n)) { continue; }
            reached.add(n);
            for (const t of liveGraph.get(n) || []) { queue.push(t); }
        }
        const orphans = [];
        for (const f of arch.listJsFiles(path.join(arch.SERVER_ROOT, 'runtime'))) {
            if (reached.has(f)) { continue; }
            const r = arch.rel(f);
            if (r in debt.ALLOWED_ORPHANS) { continue; }
            orphans.push(r);
        }
        expect(orphans, 'unreachable runtime module(s); wire them up or register them in ALLOWED_ORPHANS with a reason:\n' +
            orphans.join('\n')).to.deep.equal([]);
    });
});
