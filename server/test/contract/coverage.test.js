/**
 * D6/D8 - SUITE COVERAGE.
 *
 * A contract suite that silently runs against one backend and says nothing about the other
 * four is worse than no suite: it reads as "all backends verified". These checks make the gap
 * structural, so "not run here" can never be mistaken for "passed".
 *
 * Since D8 the exercised set is DERIVED from the fixture files rather than typed, so adding a
 * backend cannot require remembering to edit a list.
 */

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const arch = require('../architecture/_support/architecture');
const contractSupport = require('../architecture/_support/storage-contract');
const registry = require('../../runtime/storage/registry');
const { fixturesHere, NOT_EXERCISED_HERE } = require('./_support/backends');

describe('storage contract suite coverage (D6/D8)', function () {
    const contract = contractSupport.load();
    const fixtures = fixturesHere();

    it('accounts for every delivery backend', function () {
        // The two sets are NOT exclusive on purpose: PostgreSQL has a fixture AND is recorded
        // as not exercised, because the fixture is waiting for a server rather than for code.
        // What must hold is that between them they cover ruling 12's five backends and invent
        // none.
        const withFixture = fixtures.filter((f) => contract.DELIVERY_BACKENDS.includes(f));
        const accounted = [...new Set(withFixture.concat(Object.keys(NOT_EXERCISED_HERE)))].sort();
        expect(accounted, 'ruling 12 names five delivery backends; the suite must account for all')
            .to.deep.equal(contract.DELIVERY_BACKENDS.slice().sort());

        const unaccounted = Object.keys(NOT_EXERCISED_HERE).filter(
            (b) => !contract.DELIVERY_BACKENDS.includes(b) && !withFixture.includes(b));
        expect(unaccounted, 'recorded as not exercised without even being a delivery backend:\n' +
            unaccounted.join('\n')).to.deep.equal([]);
    });

    it('every fixture present is a declared backend', function () {
        const known = registry.BACKENDS.map((b) => b.id);
        const strays = fixtures.filter((f) => !known.includes(f));
        expect(strays, 'a fixture for a backend the registry does not know:\n' + strays.join('\n'))
            .to.deep.equal([]);
    });

    it('every backend that does not run here says why and who closes it', function () {
        const incomplete = Object.keys(NOT_EXERCISED_HERE).filter((b) => {
            const entry = NOT_EXERCISED_HERE[b];
            return !entry.why || entry.why.length < 40 || !entry.closesAt || !entry.proveWith;
        });
        expect(incomplete, 'an unexercised backend without a reason and a closer is a silent hole:\n' +
            incomplete.join('\n')).to.deep.equal([]);
    });

    it('a recorded fixture actually exists', function () {
        const lying = Object.keys(NOT_EXERCISED_HERE)
            .filter((b) => NOT_EXERCISED_HERE[b].fixture === true)
            .filter((b) => fixtures.indexOf(b) === -1);
        expect(lying, 'recorded as "fixture written, waiting for a server" with no fixture:\n' +
            lying.join('\n')).to.deep.equal([]);
    });

    it('the registry and the fixture files tell the same story', function () {
        // Being proven is an EVENT, recorded on the backend. Whether a database happens to be
        // reachable on this machine is a property of the machine, so the two are kept apart:
        //   unproven  -> adapter + fixture + the command that would prove it + no proof yet;
        //   delivered -> a recorded run that proved it.
        for (const entry of registry.BACKENDS.filter((b) => b.status === 'unproven')) {
            expect(entry.adapter, entry.id + ' is unproven and must still have an adapter').to.be.a('string');
            expect(entry.proveWith, entry.id + ' must name the command that proves it').to.be.a('string');
            expect(entry.provenOn, entry.id + ' is unproven but records a proof').to.equal(undefined);
            const note = NOT_EXERCISED_HERE[entry.id];
            expect(note && note.fixture, entry.id + ' is unproven but has no fixture waiting for a server')
                .to.equal(true);
            expect(entry.proveWith).to.equal(note.proveWith);
        }

        const delivered = registry.BACKENDS.filter((b) => b.status === 'delivered' && b.adapter);
        expect(delivered.length, 'if nothing is delivered this check proves nothing').to.be.greaterThan(0);
        for (const entry of delivered) {
            expect(entry.provenOn, entry.id + ' is called delivered but records no run that proved it')
                .to.be.a('string');
        }

        const overclaimed = Object.keys(NOT_EXERCISED_HERE)
            .filter((id) => NOT_EXERCISED_HERE[id].proven === true)
            .filter((id) => {
                const entry = registry.BACKENDS.filter((b) => b.id === id)[0];
                return !entry || !entry.provenOn;
            });
        expect(overclaimed, 'the test register claims a proof the registry does not have:\n' +
            overclaimed.join('\n')).to.deep.equal([]);
    });

    it('an unproven backend is not offered to users', function () {
        // Selection is the contract with the operator: if a backend can be picked, it works.
        // Two different mistakes, two different rules:
        //   - a backend with no implementation must never be selectable;
        //   - a backend that has never run must not be offered FOR THE FIRST TIME. An option
        //     that already shipped (offered: true) stays: withdrawing it is a regression for
        //     whoever is running on it today.
        const selectable = new Set(registry.SELECTION_TYPES.map((s) => s.backend));
        const chosen = registry.BACKENDS.filter((b) => selectable.has(b.id));

        const unimplemented = chosen.filter((b) => !b.adapter).map((b) => b.id);
        expect(unimplemented, 'a backend with no implementation must not be selectable:\n' +
            unimplemented.join('\n')).to.deep.equal([]);

        const promised = chosen
            .filter((b) => b.status === 'unproven' && !b.offered)
            .map((b) => b.id + ' status=' + b.status);
        expect(promised, 'a backend that has never run must not be offered for the first time:\n' +
            promised.join('\n')).to.deep.equal([]);
    });

    it('every delivery adapter obeys the shape of the contract', function () {
        // The suite can only judge an adapter whose engine is reachable. Structure can be
        // judged without any server at all, so it is judged here for EVERY delivery backend
        // that has an adapter - proven, unproven, or not yet reachable. Scoped to delivery
        // backends because the legacy adapters (InfluxDB, QuestDB) are not SQL in the same
        // sense and are not the shape the contract is about.
        const unproven = registry.BACKENDS.filter((b) => b.delivery && b.adapter);
        expect(unproven.length, 'if nothing is checked this test proves nothing').to.be.greaterThan(0);

        const nonSql = [];
        for (const backend of unproven) {
            const file = path.join(arch.SERVER_ROOT, 'runtime', 'storage', backend.adapter.replace('./', ''), 'index.js');
            expect(fs.existsSync(file), backend.id + ' is unproven with no adapter file').to.equal(true);
            // Comments stripped: the file may well DISCUSS the very defects this checks for
            // (the SQLite adapter explains why it no longer uses BETWEEN), and a guard that
            // cannot tell code from commentary would forbid writing the explanation down.
            const source = arch.stripComments(fs.readFileSync(file, 'utf8'));

            for (const method of ['setCall', 'addDaqValues', 'getDaqValue', 'getDaqMap', 'close']) {
                expect(source, backend.id + ' must define ' + method).to.include('this.' + method + ' =');
            }
            // The range must be half-open IN THE SQL ITSELF. The exact spelling differs per
            // dialect (PostgreSQL binds $2/$3, SQLite binds ?/?, the TDengine REST client
            // pastes escaped literals), so what is asserted is the shape that matters:
            // a lower bound that includes and an upper bound that excludes - and never
            // BETWEEN, which is closed on both ends and is the D6-1 defect.
            expect(source, backend.id + ' must not use BETWEEN: it is closed on both ends')
                .to.not.match(/BETWEEN/i);
            expect(source, backend.id + ' must express an inclusive lower bound').to.match(/>=\s*\S+/);
            expect(source, backend.id + ' must express an exclusive upper bound').to.match(/<\s*\S+/);
            expect(source, backend.id + ' must not paste a value into a query')
                .to.not.match(/query\([\s\S]{0,200}?\$\{/);
            if (!/CREATE\s+(TABLE|STABLE)/i.test(source)) { nonSql.push(backend.id); }
        }
        expect(nonSql, 'an unproven adapter that stores nothing is not a store:\n' + nonSql.join('\n'))
            .to.deep.equal([]);
    });

    it('every fixture drives the SHARED suite, not a private copy of it', function () {
        for (const backend of fixtures) {
            const file = path.join(__dirname, backend + '.test.js');
            const source = fs.readFileSync(file, 'utf8');
            expect(source, backend + ' must drive the shared suite').to.include('storageContractSuite');
            expect(source, backend + ' must actually invoke it').to.include('defineStorageContract(');
        }
    });

    it('the shared suite drives only the frozen instance contract', function () {
        const source = fs.readFileSync(path.join(__dirname, '_support', 'storageContractSuite.js'), 'utf8');

        const specifiers = [];
        const re = /require\(['"]([^'"]+)['"]\)/g;
        let m;
        while ((m = re.exec(source))) { specifiers.push(m[1]); }
        expect(specifiers.filter((s) => s.startsWith('.')),
            'the shared suite must not import anything from the implementation - a fixture brings the adapter in')
            .to.deep.equal([]);

        const used = ['_private', 'settings.daqstore'].filter((f) => source.includes(f));
        expect(used, 'the shared suite must not reach into adapter internals or settings:\n' + used.join('\n'))
            .to.deep.equal([]);
    });

    it('the gate actually runs the contract suite', function () {
        const pkg = JSON.parse(fs.readFileSync(path.join(arch.SERVER_ROOT, 'package.json'), 'utf8'));
        expect(pkg.scripts['test:contract'], 'there must be a way to run it on purpose').to.be.a('string');
        expect(pkg.scripts['test:gate'], 'and the gate must include it, or it will rot')
            .to.include('test/contract');
        expect(pkg.scripts['test:backends:up'], 'and a one-command way to bring a real engine up')
            .to.be.a('string');
    });
});
