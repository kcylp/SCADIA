'use strict';

/**
 * Data domains (2026-09-29, contract 11 section 3 / ledger L-13).
 *
 * The point of these rules: AI analysis writes its output back as tags, and a written
 * tag re-enters the normal pipeline. Without a domain marker a model output is
 * indistinguishable from a field measurement, and the next analysis round feeds on
 * its own result.
 */

const { expect } = require('chai');
const domain = require('../../runtime/devices/tag-domain');

describe('tag data domains', () => {
    it('treats a tag with no marker as measured (legacy projects unchanged)', () => {
        expect(domain.domainOf({ id: 't' })).to.equal('measured');
        expect(domain.domainOf({ id: 't', dataDomain: undefined })).to.equal('measured');
        expect(domain.domainOf(null)).to.equal('measured');
    });

    it('reads a declared domain', () => {
        expect(domain.domainOf({ dataDomain: 'derived' })).to.equal('derived');
        expect(domain.domainOf({ dataDomain: 'predicted' })).to.equal('predicted');
        expect(domain.domainOf({ dataDomain: 'measured' })).to.equal('measured');
    });

    it('falls back to measured for an unrecognised marker rather than trusting it', () => {
        expect(domain.domainOf({ dataDomain: 'whatever' })).to.equal('measured');
    });

    it('classifies software-produced values', () => {
        expect(domain.isSoftwareDomain({ dataDomain: 'derived' })).to.equal(true);
        expect(domain.isSoftwareDomain({ dataDomain: 'predicted' })).to.equal(true);
        expect(domain.isSoftwareDomain({})).to.equal(false);
        expect(domain.isPredicted({ dataDomain: 'predicted' })).to.equal(true);
        expect(domain.isPredicted({ dataDomain: 'derived' })).to.equal(false);
    });

    it('only a PREDICTED tag may receive a model output', () => {
        expect(domain.canReceivePredictedWrite({ dataDomain: 'predicted' })).to.equal(true);
        expect(domain.canReceivePredictedWrite({ dataDomain: 'derived' })).to.equal(false);
        expect(domain.canReceivePredictedWrite({})).to.equal(false);
    });

    it('refuses a write to an unknown tag', () => {
        const verdict = domain.checkSoftwareWrite(null, 'predicted');
        expect(verdict.ok).to.equal(false);
        expect(verdict.reason).to.equal('unknown-tag');
    });

    it('refuses ANY software write that claims to be a measurement', () => {
        // Nothing but the acquisition chain may claim to have measured something.
        const verdict = domain.checkSoftwareWrite({ dataDomain: 'derived' }, 'measured');
        expect(verdict.ok).to.equal(false);
        expect(verdict.reason).to.equal('domain-immutable');
    });

    it('refuses a software write into a measured tag', () => {
        const legacy = domain.checkSoftwareWrite({}, 'derived');
        expect(legacy.ok).to.equal(false);
        expect(legacy.reason).to.equal('would-overwrite-measured');

        const explicit = domain.checkSoftwareWrite({ dataDomain: 'measured' }, 'predicted');
        expect(explicit.ok).to.equal(false);
        expect(explicit.reason).to.equal('would-overwrite-measured');
    });

    it('refuses a predicted write into a merely derived tag', () => {
        // derived is still not a model output slot.
        const verdict = domain.checkSoftwareWrite({ dataDomain: 'derived' }, 'predicted');
        expect(verdict.ok).to.equal(false);
        expect(verdict.reason).to.equal('would-overwrite-measured');
    });

    it('allows the matching software writes', () => {
        expect(domain.checkSoftwareWrite({ dataDomain: 'derived' }, 'derived').ok).to.equal(true);
        expect(domain.checkSoftwareWrite({ dataDomain: 'predicted' }, 'predicted').ok).to.equal(true);
        expect(domain.checkSoftwareWrite({ dataDomain: 'predicted' }, 'derived').ok).to.equal(true);
    });

    it('refuses an unsupported domain value', () => {
        const verdict = domain.checkSoftwareWrite({ dataDomain: 'derived' }, 'imaginary');
        expect(verdict.ok).to.equal(false);
        expect(verdict.reason).to.equal('unsupported-domain');
    });

    it('validates a domain marker for import paths', () => {
        expect(domain.validateTagDomain({}).ok).to.equal(true);
        expect(domain.validateTagDomain({ dataDomain: '' }).ok).to.equal(true);
        expect(domain.validateTagDomain({ dataDomain: 'derived' }).ok).to.equal(true);
        expect(domain.validateTagDomain({ dataDomain: 'nope' }).ok).to.equal(false);
    });

    it('exposes stable reason codes so callers can branch on them', () => {
        expect(domain.REFUSAL.UNKNOWN_TAG).to.equal('unknown-tag');
        expect(domain.REFUSAL.DOMAIN_IMMUTABLE).to.equal('domain-immutable');
        expect(domain.REFUSAL.OVER_MEASURED).to.equal('would-overwrite-measured');
        expect(domain.DOMAIN_FIELD).to.equal('dataDomain');
    });
});
