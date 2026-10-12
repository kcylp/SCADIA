/**
 * D1 class 5 / D5 - REGISTRY COMPLETENESS.
 *
 * Until D5 there was no registry: the backend vocabulary lived inside daqstorage.js as an
 * if/else chain, and the client kept its own copy that disagreed on one value. These checks
 * now guard the real thing - runtime/storage/registry.js - and they guard it against the two
 * artefacts that must agree with it: the capability matrix and the frozen domain contract.
 *
 * The check that matters most is not "the two enums look alike". It is: EVERY SPELLING THE
 * CLIENT CAN ACTUALLY SEND must resolve. The UI binds the enum member NAME (the template
 * uses type.key, and EnumToArrayPipe maps key to Object.keys), so names are what the live
 * path sends; the values are labels, and older settings files may hold them. Both resolve.
 */

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const arch = require('./_support/architecture');
const matrix = require('./_support/capability-matrix');
const contractSupport = require('./_support/storage-contract');
const debt = require('./_support/known-debt');

const CLIENT_SETTINGS = path.join(arch.CLIENT_ROOT, 'src', 'app', '_models', 'settings.ts');
const DAQSTORAGE = path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'daqstorage.js');
const REGISTRY = path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'registry.js');

/** The client enum, as { memberName: enumValue }. */
function readClientEnum() {
    const src = fs.readFileSync(CLIENT_SETTINGS, 'utf8');
    const block = src.match(/export enum DaqStoreType\s*\{([\s\S]*?)\}/);
    expect(block, 'the client must declare DaqStoreType').to.not.equal(null);
    const members = {};
    for (const line of block[1].split('\n')) {
        const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'\s*,?\s*$/);
        if (m) { members[m[1]] = m[2]; }
    }
    return members;
}

describe('architecture: registry completeness', function () {
    const registry = require(REGISTRY);
    const client = readClientEnum();
    const rows = matrix.materialize(matrix.load());
    const contract = contractSupport.load();

    it('the client still offers exactly the backends the registry knows', function () {
        const canonicalValues = registry.SELECTION_TYPES.filter((s) => s.canonical).map((s) => s.value).sort();
        // member names are what the UI sends
        expect(Object.keys(client).sort()).to.deep.equal(canonicalValues);
        expect(registry.BACKENDS.length).to.be.greaterThan(3);
    });

    it('every spelling the client can send resolves to a backend', function () {
        // Both spellings, deliberately: NAMES are the live path, VALUES are labels that old
        // settings files may still hold. Neither may be unknown to the server.
        const unresolved = [];
        for (const name of Object.keys(client)) {
            if (!registry.selectionFor(name)) { unresolved.push('member name ' + name); }
        }
        for (const value of Object.values(client)) {
            if (!registry.selectionFor(value)) { unresolved.push('enum value ' + JSON.stringify(value)); }
        }
        expect(unresolved, 'the client can send a spelling the server does not know:\n' +
            unresolved.join('\n')).to.deep.equal([]);
    });

    it('the client keeps its lane: no other backend spellings are offered', function () {
        // A-02 was reported as "the UI silently stores to SQLite" and that was wrong - the UI
        // sends the member name. What is still true is that the enum VALUE for influxDB18 is a
        // label, not an identifier. This records the trap rather than pretending it is gone.
        const labels = Object.keys(client).filter((name) => client[name] !== name);
        expect(labels, 'a member whose value is not its own name is a label; it must be a ' +
            'documented alias in the registry, and it must resolve (checked above)').to.deep.equal(['influxDB18']);
        expect(client.influxDB18).to.equal('influxDB 1.8');
    });

    it('every selection value resolves to a declared backend', function () {
        const ids = registry.BACKENDS.map((b) => b.id);
        const broken = registry.SELECTION_TYPES
            .filter((s) => !ids.includes(s.backend))
            .map((s) => s.value + ' -> ' + s.backend);
        expect(broken, broken.join('\n')).to.deep.equal([]);

        const aliases = registry.SELECTION_TYPES.filter((s) => !s.canonical);
        const badAlias = aliases
            .filter((s) => !registry.SELECTION_TYPES.some((t) => t.canonical && t.value === s.aliasOf))
            .map((s) => s.value + ' -> ' + s.aliasOf);
        expect(badAlias, 'an alias must point at a canonical value:\n' + badAlias.join('\n'))
            .to.deep.equal([]);
    });

    it('the routing vocabulary lives in the registry, not in the facade', function () {
        // The facade must not compare the setting against a bare literal any more - that is
        // how the dead 'QuestDB' branch survived so long (A-06a).
        const src = arch.readSource(DAQSTORAGE);
        const literals = [];
        const re = /daqstore\.type\s*===\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(src))) { literals.push(m[1]); }
        expect(literals, 'the facade compares the setting itself again; ask the registry instead')
            .to.deep.equal([]);

        // and every literal compared anywhere must be a known spelling
        const known = registry.SELECTION_TYPES.map((s) => s.value);
        const stray = [];
        for (const f of arch.serverTreeFiles()) {
            const text = arch.readSource(f);
            const re2 = /daqstore\.type\s*===\s*'([^']+)'/g;
            let mm;
            while ((mm = re2.exec(text))) {
                if (!known.includes(mm[1])) { stray.push(arch.rel(f) + "  === '" + mm[1] + "'"); }
            }
        }
        expect(stray, 'a comparison against a spelling no selection value uses:\n' + stray.join('\n'))
            .to.deep.equal([]);
    });

    it('every backend directory on disk is declared by the registry', function () {
        const onDisk = matrix.adapterDirectories();
        const declared = registry.BACKENDS
            .filter((b) => b.adapter)
            .map((b) => b.adapter.replace('./', ''))
            .sort();
        expect(declared, 'an adapter ships without a registry entry').to.deep.equal(onDisk);

        const unloadable = registry.BACKENDS
            .filter((b) => b.adapter && !fs.existsSync(path.join(arch.SERVER_ROOT, 'runtime', 'storage', b.adapter.replace('./', '') + (b.adapter.endsWith('.js') ? '' : '/index.js'))))
            .map((b) => b.id + ' -> ' + b.adapter);
        expect(unloadable, unloadable.join('\n')).to.deep.equal([]);
    });

    it('reserved backends have no adapter, delivered ones do', function () {
        const wrong = registry.BACKENDS
            .filter((b) => (b.status === 'reserved') !== (b.adapter === null))
            .map((b) => b.id + ' status=' + b.status + ' adapter=' + b.adapter);
        expect(wrong, 'a reserved backend cannot ship an adapter, and a delivered one cannot ' +
            'live at a null path:\n' + wrong.join('\n')).to.deep.equal([]);
        expect(registry.BACKENDS.filter((b) => b.status === 'reserved').length,
            'ruling 14 reserves space; if nothing is reserved this check proves nothing')
            .to.be.greaterThan(0);
    });

    it('the registry, the matrix and the frozen contract describe the same world', function () {
        const ids = registry.BACKENDS.map((b) => b.id).sort();
        expect(ids, 'every registry backend needs a capability row').to.deep.equal(rows.map((r) => r.id).sort());

        const delivered = registry.BACKENDS.filter((b) => b.delivery).map((b) => b.id).sort();
        expect(delivered, 'the registry delivery list and the D4 contract must agree')
            .to.deep.equal(contract.DELIVERY_BACKENDS.slice().sort());
    });

    it('an unknown backend type is refused by name', function () {
        expect(() => registry.normalise({ daqstore: { type: 'MySQL' } }, null))
            .to.throw(/MySQL/);
        expect(() => registry.normalise({ daqstore: { type: '' } }, null)).to.not.throw();
        expect(registry.normalise({ daqstore: { type: '' } }, null).backendId).to.equal('sqlite');
    });

    it('no adapter depends on another adapter', function () {
        // Adapters are alternatives, not layers: if one requires another, "swap the
        // backend" turns into "install all of them".
        const graph = arch.buildGraph(arch.serverTreeFiles());
        const bad = [];
        for (const [from, targets] of graph) {
            const fromRel = arch.rel(from);
            if (!fromRel.startsWith('runtime/storage/')) { continue; }
            const fromBackend = fromRel.split('/')[2];
            if (!['influxdb', 'questdb', 'sqlite', 'tdengine'].includes(fromBackend)) { continue; }
            for (const t of targets) {
                const toRel = arch.rel(t);
                const toBackend = toRel.split('/')[2];
                if (['influxdb', 'questdb', 'sqlite', 'tdengine'].includes(toBackend) && toBackend !== fromBackend) {
                    bad.push(fromRel + '  ->  ' + toRel);
                }
            }
        }
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('every module under runtime/ is reachable, and the orphan register is honest', function () {
        const graph = arch.buildGraph(arch.serverTreeFiles());
        const reached = new Set();
        const queue = [path.join(arch.SERVER_ROOT, 'main.js')];
        while (queue.length) {
            const n = queue.pop();
            if (reached.has(n)) { continue; }
            reached.add(n);
            for (const t of graph.get(n) || []) { queue.push(t); }
        }
        const orphans = arch.listJsFiles(path.join(arch.SERVER_ROOT, 'runtime'))
            .map(arch.rel)
            .filter((r) => !reached.has(path.join(arch.SERVER_ROOT, r)))
            .filter((r) => !(r in debt.ALLOWED_ORPHANS));
        expect(orphans, 'unregistered orphan(s):\n' + orphans.join('\n')).to.deep.equal([]);

        const stillOrphans = Object.keys(debt.ALLOWED_ORPHANS)
            .filter((r) => reached.has(path.join(arch.SERVER_ROOT, r)));
        expect(stillOrphans, 'registered as dead but now reachable; remove from ALLOWED_ORPHANS:\n' +
            stillOrphans.join('\n')).to.deep.equal([]);

        // hygiene: an entry for a file that no longer exists would linger forever
        const ghosts = Object.keys(debt.ALLOWED_ORPHANS)
            .filter((r) => !fs.existsSync(path.join(arch.SERVER_ROOT, r)));
        expect(ghosts, 'the orphan register names a file that is gone:\n' + ghosts.join('\n'))
            .to.deep.equal([]);
    });
});
