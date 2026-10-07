/**
 * D1 / class 3 of 6 - INTERFACE METHOD-SET SNAPSHOT.
 *
 * Freezes what the storage plane promises, and proves every promise is real.
 */

'use strict';

const { expect } = require('chai');
const path = require('path');
const arch = require('./_support/architecture');
const snapshot = require('./_support/storage-snapshot');

describe('architecture: storage interface snapshot', function () {
    it('the frozen surface matches the code, method for method', function () {
        const current = snapshot.capture();
        if (process.env.ARCH_SNAPSHOT_UPDATE === '1') {
            snapshot.write(current);
            throw new Error('snapshot regenerated; re-run the guard and review the diff before committing');
        }
        const frozen = snapshot.read();
        expect(current.modules, 'the storage interface moved. Three backends (D8-D10) will be written ' +
            'against this shape; if the change is intended, regenerate with ARCH_SNAPSHOT_UPDATE=1 and say why.')
            .to.deep.equal(frozen.modules);
    });

    it('every backend adapter provides the common instance contract', function () {
        // create() is only the door. What the facade calls is the object create() returns,
        // and three more backends (D8-D10) have to reproduce that surface exactly.
        const offenders = [];
        for (const relPath of snapshot.BACKEND_ADAPTERS) {
            const methods = arch.instanceMethods(path.join(arch.SERVER_ROOT, relPath));
            const missing = snapshot.ADAPTER_CORE.filter((m) => !methods.includes(m));
            if (missing.length) { offenders.push(relPath + '  missing: ' + missing.join(', ')); }
        }
        expect(offenders, 'an adapter that cannot answer the facade is not an adapter:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('the frozen adapter surface matches the code, method for method', function () {
        const current = snapshot.capture();
        if (process.env.ARCH_SNAPSHOT_UPDATE === '1') {
            snapshot.write(current);
            throw new Error('snapshot regenerated; re-run the guard and review the diff before committing');
        }
        const frozen = snapshot.read();
        expect(current.adapters, 'the adapter instance surface moved; every additional backend ' +
            'must implement the same shape, so a change here is a change to three future deliveries')
            .to.deep.equal(frozen.adapters);
    });

    it('every backend adapter exposes a create() factory', function () {
        for (const relPath of snapshot.BACKEND_ADAPTERS) {
            const abs = path.join(arch.SERVER_ROOT, relPath);
            const shape = arch.exportShape(abs);
            expect(shape.create, relPath + ' must export create()').to.be.a('string');
            expect(shape.create.startsWith('function'), relPath + ' create must be a function').to.equal(true);
        }
    });

    it('every adapter shares one create() signature', function () {
        // (settings, logger, currentStorage, options) - A-05 closed at D5. The node id
        // travels in options because only a per-device backend has one, and the registry
        // is the only thing that supplies it.
        const arities = {};
        for (const relPath of snapshot.BACKEND_ADAPTERS) {
            arities[relPath.replace('runtime/storage/', '')] =
                arch.exportShape(path.join(arch.SERVER_ROOT, relPath)).create;
        }
        expect([...new Set(Object.values(arities))],
            'the adapter signatures drifted apart again: ' + JSON.stringify(arities))
            .to.deep.equal(['function/4']);
    });

    it('no module exports a binding that can only be undefined', function () {
        // An export that resolves to undefined is a call site waiting to explode with
        // 'is not a function', far from the typo that caused it. Late-bound module state
        // (assigned during init) is legitimate; a binding nothing declares is not.
        // Read statically: loading 118 modules to learn this costs ~22s.
        const { all } = arch.serverLayers();
        const broken = [];
        for (const f of all) {
            for (const problem of arch.impossibleExportBindings(f)) {
                broken.push(arch.rel(f) + '  exports  ' + problem);
            }
        }
        expect(broken, 'broken export(s):\n' + broken.join('\n')).to.deep.equal([]);
    });

    it('and the storage plane confirms it at load time, not just on paper', function () {
        // Ground truth for the frozen surface only: cheap, because these modules are
        // already in the require cache by the time this file runs.
        const broken = [];
        for (const relPath of snapshot.STORAGE_MODULES) {
            const abs = path.join(arch.SERVER_ROOT, relPath);
            let loaded;
            try { loaded = require(abs); }
            catch (err) { broken.push(relPath + ' could not be loaded: ' + err.message); continue; }
            for (const key of Object.keys(loaded)) {
                if (loaded[key] === undefined) { broken.push(relPath + '  exports  ' + key + '  = undefined'); }
            }
        }
        expect(broken, broken.join('\n')).to.deep.equal([]);
    });

    it('the query contract surface is exported by name, not by shape', function () {
        const surface = arch.exportShape(path.join(arch.SERVER_ROOT, 'runtime/storage/daqstorage.js'));
        for (const name of ['querySeries', 'describeTag', 'isQueryComplete', 'QUERY_STATUS', 'QUERY_DEFAULTS']) {
            expect(surface, 'daqstorage must export ' + name).to.have.property(name);
        }
        expect(surface.QUERY_STATUS).to.equal('object');
        expect(surface.QUERY_DEFAULTS).to.equal('object');
    });
});
