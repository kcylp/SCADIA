/**
 * D4 - THE FROZEN STORAGE DOMAIN CONTRACT.
 *
 * A frozen contract is only frozen if something fails when it is contradicted. These checks
 * make the contract answer to the capability matrix instead of to prose:
 *
 *   - a domain may only require a capability the matrix knows about;
 *   - a delivery backend proven unable to provide a required capability MUST be declared
 *     out of that domain, with a reason. That is the equation that turns "TDengine has no
 *     business-data transactions" into a structural fact rather than a comment;
 *   - a store belongs to exactly one domain, or the boundary - never to two;
 *   - the adapter contract must stay free of realtime vocabulary;
 *   - the honest size of what the freeze still rests on is enumerated and cannot grow.
 */

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const arch = require('./_support/architecture');
const matrix = require('./_support/capability-matrix');
const snapshot = require('./_support/storage-snapshot');
const contract = require('./_support/storage-contract');

/**
 * PINNED: the (backend, capability) pairs some domain REQUIRES and that are still
 * unverified. D4 writes the requirement; D8-D10 prove it on real instances. As each is
 * proven the set shrinks and this pin must be edited - so the freeze cannot quietly widen,
 * and cannot quietly pretend to be proven either.
 */
const PINNED_FREEZE_BLOCKERS = [
    'dameng/binary-object',
    'dameng/durability',
    'dameng/ts-range',
    'mysql/atomic-batch',
    'mysql/binary-object',
    'mysql/durability',
    'mysql/ts-range',
    'tdengine/ts-range'
    // The four postgresql/* entries left this list at D8, when a live PostgreSQL was
    // measured on every axis the domains require. That is what shrinking this list looks
    // like: a proof, not a reclassification.
];

/** The stores that belong to the realtime boundary, not to any domain. */
const REALTIME_STORES = ['runtime/storage/sqlite/currentstorage.js'];

describe('architecture: storage domain contract (D4)', function () {
    const doc = contract.load();
    const rows = matrix.materialize(matrix.load());
    const axes = matrix.load().axes.map((a) => a.id);

    it('declares four domains and one boundary, with unique ids', function () {
        expect(doc.DOMAINS.length, 'the plan freezes four domains').to.equal(4);
        const ids = doc.DOMAINS.map((d) => d.id);
        expect(new Set(ids).size).to.equal(ids.length);
        expect(ids.sort()).to.deep.equal(['config', 'event', 'object', 'timeseries']);
        expect(doc.REALTIME_BOUNDARY.id).to.equal('realtime-not-abstracted');
    });

    it('every domain states responsibility, key, requirements, degradation and invariants', function () {
        const missing = [];
        for (const d of doc.DOMAINS) {
            const fields = ['id', 'label', 'responsibility', 'owner', 'key', 'requires', 'optional',
                'notOn', 'degradation', 'invariants'];
            for (const f of fields) {
                if (d[f] === undefined || d[f] === null) { missing.push(d.id + '.' + f); }
            }
            if (!d.requires.length) { missing.push(d.id + '.requires is empty'); }
            if (!d.invariants.length) { missing.push(d.id + '.invariants is empty'); }
        }
        expect(missing, 'a domain without a full contract is a wish:\n' + missing.join('\n')).to.deep.equal([]);
    });

    it('may only require capabilities the matrix actually names', function () {
        const bad = [];
        for (const d of doc.DOMAINS) {
            for (const cap of d.requires.concat(d.optional)) {
                if (!axes.includes(cap)) { bad.push(d.id + ' names capability ' + cap + ', which is not a matrix axis'); }
            }
        }
        expect(bad, bad.join('\n')).to.deep.equal([]);
    });

    it('every claimed store exists, and no store is claimed by two domains', function () {
        const seen = new Map();
        const missing = [];
        const clashes = [];
        for (const d of doc.DOMAINS) {
            for (const owner of d.owner) {
                if (!fs.existsSync(path.join(arch.SERVER_ROOT, owner))) { missing.push(d.id + ' -> ' + owner); }
                if (seen.has(owner)) { clashes.push(owner + ' claimed by ' + seen.get(owner) + ' and ' + d.id); }
                seen.set(owner, d.id);
            }
        }
        expect(missing, 'a domain names a store that does not exist:\n' + missing.join('\n')).to.deep.equal([]);
        expect(clashes, 'a store belongs to exactly one domain:\n' + clashes.join('\n')).to.deep.equal([]);
    });

    it('the realtime store is claimed by no domain', function () {
        // currentstorage is the one storage-side artefact of the realtime path. If a domain
        // quietly adopted it, "realtime is not abstracted" would stop being true.
        const claimed = [];
        for (const d of doc.DOMAINS) {
            for (const s of REALTIME_STORES) {
                if (d.owner.includes(s)) { claimed.push(d.id + ' claims ' + s); }
            }
        }
        expect(claimed, claimed.join('\n')).to.deep.equal([]);
    });

    it('a required capability a delivery backend cannot provide forces a declared exclusion', function () {
        // THE equation. Config requires atomic-batch; TDengine is proven to have no
        // business-data transactions; therefore Config must declare that it does not run on
        // TDengine, with a reason. Prose alone would let this rot the moment TDengine is
        // switched on.
        const offenders = [];
        for (const d of doc.DOMAINS) {
            const implied = contract.impliedExclusions(d, rows);
            for (const backend of Object.keys(implied)) {
                const declared = d.notOn[backend];
                if (!declared || declared.length < 20) {
                    offenders.push(d.id + ' requires ' + implied[backend].join(', ') +
                        ' but does not declare itself out of ' + backend);
                }
            }
        }
        expect(offenders, 'contract contradicts the measured capability matrix:\n' + offenders.join('\n'))
            .to.deep.equal([]);

        // and the equation must actually be doing work, not passing vacuously
        const total = doc.DOMAINS.reduce((n, d) => n + Object.keys(contract.impliedExclusions(d, rows)).length, 0);
        expect(total, 'if no backend is ever excluded, this check proves nothing').to.be.greaterThan(0);
    });

    it('the delivery backend list matches the ruling and the matrix', function () {
        const known = rows.map((r) => r.id);
        for (const b of doc.DELIVERY_BACKENDS) {
            expect(known, 'delivery backend ' + b + ' is not in the capability matrix').to.include(b);
        }
        const notDelivered = known.filter((b) => !doc.DELIVERY_BACKENDS.includes(b)).sort();
        expect(notDelivered, 'the non-delivered adapters are exactly the two decided in D-2')
            .to.deep.equal(['influxdb', 'questdb']);
    });

    it('the object domain is a declared seam, not an implementation', function () {
        const object = doc.DOMAINS.filter((d) => d.id === 'object')[0];
        expect(object.owner, 'nothing may claim to implement the object domain yet')
            .to.deep.equal([]);
        expect(object.status).to.equal('reserved-seam');
        expect(object.noConsumerToday, 'a seam must say why it is empty, not leave a TODO')
            .to.be.a('string');
        expect(object.noConsumerToday.length).to.be.greaterThan(40);
    });

    it('the adapter contract stays free of realtime vocabulary', function () {
        // Checked against the REAL adapters as well as the frozen core: if a backend grows a
        // subscribe(), the boundary just broke, whether or not anyone updated the snapshot.
        const forbidden = doc.REALTIME_BOUNDARY.forbiddenInAdapterContract;
        const surfaces = snapshot.ADAPTER_CORE.slice();
        for (const relPath of snapshot.BACKEND_ADAPTERS) {
            for (const method of arch.instanceMethods(path.join(arch.SERVER_ROOT, relPath))) {
                surfaces.push(relPath.split('/')[2] + '.' + method);
            }
        }
        const offending = surfaces.filter(
            (m) => forbidden.some((word) => m.toLowerCase().indexOf(word.toLowerCase()) !== -1));
        expect(offending, 'a realtime verb appeared on the adapter surface, which the boundary forbids:\n' +
            offending.join('\n')).to.deep.equal([]);
        expect(snapshot.ADAPTER_CORE.length, 'the frozen core is not empty').to.be.greaterThan(3);
    });

    it('the freeze still rests on exactly the enumerated unproven cells', function () {
        const measured = contract.freezeBlockers(doc, rows);
        expect(measured, 'the set of required-but-unproven cells changed. If a cell was proven, ' +
            'delete it from PINNED_FREEZE_BLOCKERS; if a requirement was added, that is a ' +
            'deliberate widening of the freeze and must be said out loud.')
            .to.deep.equal(PINNED_FREEZE_BLOCKERS);
        expect(measured.length, 'a freeze with nothing left to prove is suspicious').to.be.greaterThan(0);
    });

    it('the human document is generated, not written', function () {
        if (process.env.ARCH_CONTRACT_UPDATE === '1') {
            contract.writeMarkdown();
            throw new Error('contract document regenerated; re-run the guard and review the diff before committing');
        }
        expect(fs.existsSync(contract.CONTRACT_MD), 'the human document must exist').to.equal(true);
        expect(fs.readFileSync(contract.CONTRACT_MD, 'utf8'),
            'the human document drifted from the machine contract. Regenerate with ' +
            'ARCH_CONTRACT_UPDATE=1 instead of editing it.').to.equal(contract.renderMarkdown());
    });
});
