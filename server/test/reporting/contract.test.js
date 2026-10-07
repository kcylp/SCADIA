'use strict';

/**
 * The client and the server must agree on the report wire format.
 *
 * This is not a style preference. The two sides exchange bare identifiers that end up in a
 * saved report and decide which period the PDF covers. When they drifted, the server treated
 * the unrecognised range as as-of-now, so the customer received a well formed report of the
 * wrong period with no error anywhere. Failing the build is the only reliable way to stop
 * that happening again.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const contract = require(path.join(SERVER_ROOT, 'runtime', 'reporting', 'contract'));

const clientReportModel = () => fs.readFileSync(path.join(CLIENT_SRC, 'app', '_models', 'report.ts'), 'utf8');
const serverReport = () => fs.readFileSync(path.join(SERVER_ROOT, 'runtime', 'jobs', 'report.js'), 'utf8');

/** Keys of a TypeScript enum - the identifier that travels on the wire. */
function clientEnumKeys(source, name) {
    const match = new RegExp('export enum ' + name + ' \\{([\\s\\S]*?)\\}').exec(source);
    if (!match) { return null; }
    const keys = [];
    const re = /(\w+)\s*=/g;
    let m;
    while ((m = re.exec(match[1]))) { keys.push(m[1]); }
    return keys;
}

describe('report contract (client and server must agree)', () => {

    it('declares every contract the report editor and generator share', () => {
        expect(Object.keys(contract.CONTRACTS)).to.have.members([
            'ReportItemType', 'ReportDateRangeType', 'ReportIntervalType',
            'ReportFunctionType', 'ReportSchedulingType', 'ReportTableColumnType'
        ]);
    });

    it('the client can express every value of every contract', () => {
        // The failure this prevents: the server learns a new range and the editor never
        // offers it, so the capability exists but no customer can reach it.
        const source = clientReportModel();
        const problems = [];
        for (const name of Object.keys(contract.CONTRACTS)) {
            const clientKeys = clientEnumKeys(source, name);
            if (!clientKeys) { problems.push(name + ': no client enum'); continue; }
            const missing = Object.keys(contract.CONTRACTS[name]).filter(k => clientKeys.indexOf(k) < 0);
            if (missing.length) { problems.push(name + ': client cannot express ' + missing.join(', ')); }
        }
        expect(problems, problems.join(' | ')).to.deep.equal([]);
    });

    it('the client does not invent values the server cannot handle', () => {
        const source = clientReportModel();
        const problems = [];
        for (const name of Object.keys(contract.CONTRACTS)) {
            const clientKeys = clientEnumKeys(source, name);
            if (!clientKeys) { continue; }
            const accepted = contract.acceptedValues(name);
            const unknown = clientKeys.filter(k => accepted.indexOf(k) < 0);
            if (unknown.length) { problems.push(name + ': client sends ' + unknown.join(', ')); }
        }
        expect(problems, problems.join(' | ')).to.deep.equal([]);
    });

    it('the alias for the legacy as-of-now value resolves onto the canonical one', () => {
        expect(contract.canonicalValue('ReportDateRangeType', 'one')).to.equal('none');
        expect(contract.canonicalValue('ReportDateRangeType', 'none')).to.equal('none');
    });

    it('refuses a value outside the contract instead of guessing', () => {
        // Returning null is what lets the generator raise an error rather than silently
        // producing a report of the wrong period.
        expect(contract.canonicalValue('ReportDateRangeType', 'fortnight')).to.equal(null);
        expect(contract.canonicalValue('ReportItemType', 'pivot')).to.equal(null);
        expect(contract.canonicalValue('ReportIntervalType', undefined)).to.equal(null);
    });

    it('the generator no longer spells the contract out as loose string literals', () => {
        const source = serverReport();
        const literals = source.match(/item\.type === '[a-z]+'/g) || [];
        expect(literals, 'item types must be compared through the contract: ' + literals.join(', '))
            .to.deep.equal([]);
    });
});
