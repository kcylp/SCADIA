/**
 * 'devices/tag-domain': which KIND of data a tag carries (contract 11 section 3).
 *
 * Three domains, kept apart on purpose:
 *
 *   measured   a real reading from the field. Only the acquisition chain writes it.
 *   derived    computed by the platform itself (scripts, aggregation, status).
 *   predicted  produced by a model. Must never be mistaken for a measurement.
 *
 * Why this exists: AI analysis writes its results back as tags, and a written tag
 * re-enters the ordinary pipeline (scheduler, OPC UA, trends, DAQ). Without a domain
 * marker a predicted value becomes indistinguishable from a real measurement, and the
 * next analysis round would feed on its own output.
 *
 * Backward compatibility: a tag with no marker is MEASURED, so existing projects keep
 * working untouched and keep their current write behaviour.
 *
 * Pure functions only (no I/O, no runtime state) so the rules are testable on their
 * own; the caller performs the actual write.
 */

'use strict';

/** Field on a tag definition that carries the domain marker. */
const DOMAIN_FIELD = 'dataDomain';

const DOMAINS = {
    MEASURED: 'measured',
    DERIVED: 'derived',
    PREDICTED: 'predicted'
};

/** Domains that software (not a device) is allowed to produce. */
const SOFTWARE_DOMAINS = [DOMAINS.DERIVED, DOMAINS.PREDICTED];

/** Reason codes for a refused write. Stable strings so callers can branch on them. */
const REFUSAL = {
    UNKNOWN_TAG: 'unknown-tag',
    DOMAIN_IMMUTABLE: 'domain-immutable',
    OVER_MEASURED: 'would-overwrite-measured',
    UNSUPPORTED_DOMAIN: 'unsupported-domain'
};

function isKnownDomain(value) {
    return value === DOMAINS.MEASURED || value === DOMAINS.DERIVED || value === DOMAINS.PREDICTED;
}

/**
 * The declared domain of a tag definition.
 * An absent or unrecognised marker means MEASURED, which is exactly how projects
 * written before this feature behaved.
 */
function domainOf(tag) {
    const declared = tag && tag[DOMAIN_FIELD];
    return isKnownDomain(declared) ? declared : DOMAINS.MEASURED;
}

/** True when the tag was declared as a software-produced value. */
function isSoftwareDomain(tag) {
    return SOFTWARE_DOMAINS.indexOf(domainOf(tag)) >= 0;
}

/** True when the tag carries a value that a model produced. */
function isPredicted(tag) {
    return domainOf(tag) === DOMAINS.PREDICTED;
}

/**
 * A tag may only be a model-output target when it is explicitly declared PREDICTED.
 * This is the rule that stops a prediction from overwriting a real measurement.
 */
function canReceivePredictedWrite(tag) {
    return domainOf(tag) === DOMAINS.PREDICTED;
}

/**
 * Check a software-originated write before it happens.
 *
 * `param {object|null} tag  the tag DEFINITION from the project, or null when the
 *                           tagId is unknown to the project
 * `param {string} domain    the domain of the value being written
 * `returns {{ok:boolean, domain:string, reason:(string|undefined)}}
 */
function checkSoftwareWrite(tag, domain) {
    if (!tag) {
        return { ok: false, domain: domain, reason: REFUSAL.UNKNOWN_TAG };
    }
    if (!isKnownDomain(domain)) {
        return { ok: false, domain: domain, reason: REFUSAL.UNSUPPORTED_DOMAIN };
    }
    if (domain === DOMAINS.MEASURED) {
        // Nothing but the acquisition chain may claim to have measured something.
        return { ok: false, domain: domain, reason: REFUSAL.DOMAIN_IMMUTABLE };
    }
    const declared = domainOf(tag);
    if (declared === DOMAINS.MEASURED) {
        // Writing software data into a measured tag would rewrite what the device
        // reported. Both derived and predicted writes are refused here.
        return { ok: false, domain: domain, reason: REFUSAL.OVER_MEASURED };
    }
    if (domain === DOMAINS.PREDICTED && declared !== DOMAINS.PREDICTED) {
        return { ok: false, domain: domain, reason: REFUSAL.OVER_MEASURED };
    }
    return { ok: true, domain: domain };
}

/**
 * Validate a tag definition domain marker (used by import / validation paths).
 * `returns {{ok:boolean, reason:(string|undefined)}}
 */
function validateTagDomain(tag) {
    const declared = tag && tag[DOMAIN_FIELD];
    if (declared === undefined || declared === null || declared === '') { return { ok: true }; }
    if (!isKnownDomain(declared)) { return { ok: false, reason: REFUSAL.UNSUPPORTED_DOMAIN }; }
    return { ok: true };
}

module.exports = {
    DOMAIN_FIELD: DOMAIN_FIELD,
    DOMAINS: DOMAINS,
    SOFTWARE_DOMAINS: SOFTWARE_DOMAINS,
    REFUSAL: REFUSAL,
    isKnownDomain: isKnownDomain,
    domainOf: domainOf,
    isSoftwareDomain: isSoftwareDomain,
    isPredicted: isPredicted,
    canReceivePredictedWrite: canReceivePredictedWrite,
    checkSoftwareWrite: checkSoftwareWrite,
    validateTagDomain: validateTagDomain
};
