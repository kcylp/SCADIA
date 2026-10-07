/**
 * D2 - CAPABILITY MATRIX.
 *
 * The matrix decides what the domain contracts are allowed to require, so it is the one
 * document that must not contain a guess dressed as a fact. These checks make that
 * structural instead of aspirational:
 *
 *   - no cell without a verdict from the closed vocabulary;
 *   - no verdict other than "unverified" without evidence;
 *   - the driver column is measured, not typed;
 *   - every shipped adapter has a row, and every row that names an adapter names a file
 *     that exists;
 *   - the default backend is re-probed live, so its measured cells cannot drift;
 *   - the human document is a pure function of the machine document.
 */

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const arch = require('./_support/architecture');
const matrix = require('./_support/capability-matrix');
const { runProbe } = require('./_support/child-probe');

describe('architecture: storage capability matrix (D2)', function () {
    const doc = matrix.load();
    const rows = matrix.materialize(doc);

    it('every backend answers every capability axis', function () {
        expect(doc.axes.length, 'a matrix with no axes decides nothing').to.be.greaterThan(0);
        expect(rows.length, 'a matrix with no backends decides nothing').to.be.greaterThan(0);

        const offenders = [];
        for (const r of rows) {
            const keys = Object.keys(r.cells).sort();
            const axes = doc.axes.map((a) => a.id).sort();
            if (JSON.stringify(keys) !== JSON.stringify(axes)) {
                offenders.push(r.id + ' covers ' + keys.length + ' of ' + axes.length + ' axes');
            }
        }
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });

    it('every axis says why it is asked and where it comes from', function () {
        const offenders = [];
        for (const a of doc.axes) {
            if (!a.id || !a.question || !a.why || !a.origin) { offenders.push(a.id || '(no id)'); }
        }
        const ids = doc.axes.map((a) => a.id);
        expect(new Set(ids).size, 'duplicate axis id').to.equal(ids.length);
        expect(offenders, 'an axis nobody can justify is an axis nobody needs:\n' + offenders.join('\n'))
            .to.deep.equal([]);
    });

    it('a verdict is always from the closed vocabulary', function () {
        const offenders = [];
        for (const r of rows) {
            for (const a of doc.axes) {
                if (!matrix.VERDICTS.includes(r.cells[a.id].verdict)) {
                    offenders.push(r.id + '.' + a.id + ' = ' + JSON.stringify(r.cells[a.id].verdict));
                }
            }
        }
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });

    it('no claim without evidence', function () {
        // The whole point of D2 is to separate what is known from what is assumed. A cell
        // that is not "unverified" is a claim, and a claim must point at something a
        // reviewer can open: a measurement in this repo, or a document on the web.
        const offenders = [];
        for (const r of rows) {
            for (const a of doc.axes) {
                const cell = r.cells[a.id];
                if (cell.verdict === 'unverified') { continue; }
                const e = cell.evidence;
                if (!e) { offenders.push(r.id + '.' + a.id + ' = ' + cell.verdict + ' without evidence'); continue; }
                const measured = /^measured:\s*([^\s#]+)/.exec(e);
                if (measured) {
                    if (!fs.existsSync(path.join(arch.SERVER_ROOT, measured[1]))) {
                        offenders.push(r.id + '.' + a.id + ' cites a missing measurement file: ' + measured[1]);
                    }
                    continue;
                }
                if (!/^https?:\/\//.test(e)) {
                    offenders.push(r.id + '.' + a.id + ' evidence is neither a measurement nor a document: ' + e);
                }
            }
        }
        expect(offenders, 'unfounded claim(s) in the capability matrix:\n' + offenders.join('\n')).to.deep.equal([]);
    });

    it('the driver column is measured, not typed', function () {
        const facts = matrix.driverFacts();
        const offenders = [];
        for (const r of rows) {
            if (!r.driver) { continue; }
            if (facts.declared(r.driver) === null) {
                offenders.push(r.id + ' names ' + r.driver + ', which package.json does not declare');
            }
        }
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });

    it('every adapter on disk has a row, and every row that names one points at a real file', function () {
        const onDisk = matrix.adapterDirectories();
        const named = rows
            .filter((r) => r.adapterFile)
            .map((r) => r.adapterFile.split('/')[2])
            .sort();

        expect(named, 'a backend directory ships without a capability row').to.deep.equal(onDisk);

        const offenders = rows
            .filter((r) => r.adapterFile && !fs.existsSync(path.join(arch.SERVER_ROOT, r.adapterFile)))
            .map((r) => r.id + ' -> ' + r.adapterFile);
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });

    it('the measured cells still match a live probe of the default backend', function () {
        // This is what stops the matrix from becoming folklore. The default backend is
        // embedded and installed, so its verdicts are re-derived on every run.
        const measured = runProbe('capability-probe.js');
        expect(measured.fatal, 'the probe itself failed: ' + JSON.stringify(measured.fatal)).to.equal(undefined);

        const row = rows.filter((r) => r.id === matrix.PROBED_BACKEND)[0];
        expect(row, 'the probed backend must have a row').to.be.an('object');

        const offenders = [];
        for (const a of doc.axes) {
            const cell = row.cells[a.id];
            if (!cell.evidence || cell.evidence.indexOf('capability-probe.js') === -1) { continue; }
            const live = measured[a.id];
            if (!live) { offenders.push(a.id + ' is claimed from the probe but the probe does not measure it'); continue; }
            const derived = live.ok ? 'yes' : 'no';
            if (derived !== cell.verdict) {
                offenders.push(row.id + '.' + a.id + ': matrix says ' + cell.verdict +
                    ', the live probe says ' + derived + ' (' + live.detail + ')');
            }
        }
        expect(offenders, 'the matrix disagrees with reality:\n' + offenders.join('\n')).to.deep.equal([]);
        expect(Object.keys(measured).length).to.be.greaterThan(5);
    });

    it('the human document is generated, not written', function () {
        if (process.env.ARCH_MATRIX_UPDATE === '1') {
            matrix.writeMarkdown(doc);
            throw new Error('matrix document regenerated; re-run the guard and review the diff before committing');
        }
        expect(fs.existsSync(matrix.MATRIX_MD), 'the human document must exist').to.equal(true);
        const committed = fs.readFileSync(matrix.MATRIX_MD, 'utf8');
        const rendered = matrix.renderMarkdown(doc);
        expect(committed,
            'the human document drifted from the machine document. Regenerate with ' +
            'ARCH_MATRIX_UPDATE=1 instead of editing it.').to.equal(rendered);
    });

    it('every undecided question is registered with an owner', function () {
        const offenders = doc.openItems
            .filter((o) => !o.id || !o.what || !o.closesAt || !o.decidedBy)
            .map((o) => o.id || '(no id)');
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });

    it('every decision states what was decided, why, and whether it can be undone', function () {
        // The point of separating decisions from open items is that a reader can tell
        // "this is settled" from "this is still moving". A decision without a reason is
        // just an assertion, and an assertion cannot be reviewed.
        expect(doc.decisions.length, 'this window decided things; they must be recorded').to.be.greaterThan(0);

        const missing = doc.decisions
            .filter((d) => !d.id || !d.what || !d.decision || !d.why || !d.evidence || !d.reversible)
            .map((d) => d.id || '(no id)');
        expect(missing, 'decision(s) without a full record:\n' + missing.join('\n')).to.deep.equal([]);

        const ids = doc.decisions.map((d) => d.id).concat(doc.openItems.map((o) => o.id));
        expect(new Set(ids).size, 'a decision and an open item share an id, or an id repeats')
            .to.equal(ids.length);

        const unnamed = doc.decisions.filter((d) => !/^D-/.test(d.id)).map((d) => d.id);
        expect(unnamed, 'decisions are numbered D-n, open items O-n:\n' + unnamed.join('\n')).to.deep.equal([]);
    });
});
