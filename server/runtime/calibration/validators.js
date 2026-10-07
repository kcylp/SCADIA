/**
 * 'calibration/validators': profile and request validation
 */

'use strict';

const codec = require('./register-codec');

const SAMPLING_DEFAULTS = {
    sampleCount: 8,
    intervalMs: 500,
    maxAgeMs: 5000,
    timeoutMs: 30000,
    filter: 'none',
    madThreshold: 3.5,
    minAcceptedRatio: 0.8
};

const QUALITY_DEFAULTS = {
    minPoints: 2
};

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function checkFinite(v, field) {
    if (!isFiniteNumber(v)) {
        fail('CAL_VALIDATION_ERROR', field + ' must be a finite number');
    }
    return v;
}

function checkIntRange(v, field, min, max) {
    checkFinite(v, field);
    if (!Number.isInteger(v) || v < min || v > max) {
        fail('CAL_VALIDATION_ERROR', field + ' must be an integer in [' + min + ', ' + max + ']');
    }
    return v;
}

/**
 * Normalize and validate a CalibrationProfile. Throws CAL_VALIDATION_ERROR.
 * Returns a normalized copy.
 */
function validateProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        fail('CAL_VALIDATION_ERROR', 'profile is required');
    }
    const p = JSON.parse(JSON.stringify(profile));

    if (!p.name || typeof p.name !== 'string' || p.name.length > 200) {
        fail('CAL_VALIDATION_ERROR', 'profile.name is required (max 200 chars)');
    }
    if (!p.sourceTagId || typeof p.sourceTagId !== 'string') {
        fail('CAL_VALIDATION_ERROR', 'profile.sourceTagId is required');
    }
    if (p.model && p.model !== 'linear') {
        fail('CAL_VALIDATION_ERROR', 'profile.model only supports "linear"');
    }
    p.model = 'linear';

    // sampling
    const s = p.sampling = p.sampling || {};
    for (const k of Object.keys(SAMPLING_DEFAULTS)) {
        if (s[k] === undefined) { s[k] = SAMPLING_DEFAULTS[k]; }
    }
    checkIntRange(s.sampleCount, 'sampling.sampleCount', 2, 1000);
    checkIntRange(s.intervalMs, 'sampling.intervalMs', 100, 60000);
    checkIntRange(s.maxAgeMs, 'sampling.maxAgeMs', 0, 3600000);
    checkIntRange(s.timeoutMs, 'sampling.timeoutMs', 1000, 3600000);
    if (['none', 'mad'].indexOf(s.filter) === -1) {
        fail('CAL_VALIDATION_ERROR', 'sampling.filter must be "none" or "mad"');
    }
    checkFinite(s.madThreshold, 'sampling.madThreshold');
    checkFinite(s.minAcceptedRatio, 'sampling.minAcceptedRatio');
    if (s.minValue !== undefined) { checkFinite(s.minValue, 'sampling.minValue'); }
    if (s.maxValue !== undefined) { checkFinite(s.maxValue, 'sampling.maxValue'); }
    if (s.minValue !== undefined && s.maxValue !== undefined && s.minValue >= s.maxValue) {
        fail('CAL_VALIDATION_ERROR', 'sampling.minValue must be < maxValue');
    }
    if (s.maxStdDev !== undefined) { checkFinite(s.maxStdDev, 'sampling.maxStdDev'); }
    if (s.maxCvPercent !== undefined) { checkFinite(s.maxCvPercent, 'sampling.maxCvPercent'); }

    // quality
    const q = p.quality = p.quality || {};
    for (const k of Object.keys(QUALITY_DEFAULTS)) {
        if (q[k] === undefined) { q[k] = QUALITY_DEFAULTS[k]; }
    }
    checkIntRange(q.minPoints, 'quality.minPoints', 2, 1000);
    if (q.minR2 !== undefined) { checkFinite(q.minR2, 'quality.minR2'); }
    if (q.maxRmse !== undefined) { checkFinite(q.maxRmse, 'quality.maxRmse'); }
    if (q.maxAbsError !== undefined) { checkFinite(q.maxAbsError, 'quality.maxAbsError'); }
    if (q.minRawSpan !== undefined) { checkFinite(q.minRawSpan, 'quality.minRawSpan'); }
    q.forbidExtrapolation = q.forbidExtrapolation !== false;

    // write
    const w = p.write = p.write || {};
    if (!w.mode) {
        w.mode = 'tags';
    }
    if (w.mode === 'tags') {
        if (!w.gainTagId || !w.offsetTagId) {
            fail('CAL_VALIDATION_ERROR', 'write.gainTagId and write.offsetTagId are required for tags mode');
        }
        if (w.gainTagId === w.offsetTagId) {
            fail('CAL_VALIDATION_ERROR', 'write.gainTagId and write.offsetTagId must differ');
        }
        if (w.writeOrder && JSON.stringify(w.writeOrder) !== JSON.stringify(['gain', 'offset']) &&
            JSON.stringify(w.writeOrder) !== JSON.stringify(['offset', 'gain'])) {
            fail('CAL_VALIDATION_ERROR', 'write.writeOrder must be ["gain","offset"] or ["offset","gain"]');
        }
        w.writeOrder = w.writeOrder || ['gain', 'offset'];
        w.verifyDelayMs = w.verifyDelayMs === undefined ? 1000 : w.verifyDelayMs;
        checkIntRange(w.verifyDelayMs, 'write.verifyDelayMs', 0, 60000);
        w.verifyTolerance = w.verifyTolerance === undefined ? 0 : checkFinite(w.verifyTolerance, 'write.verifyTolerance');
        w.rollbackOnFailure = w.rollbackOnFailure !== false;
    } else if (w.mode === 'raw-block') {
        if (!w.deviceId) {
            fail('CAL_VALIDATION_ERROR', 'write.deviceId is required for raw-block mode');
        }
        if (w.addressBase !== 0 && w.addressBase !== 1) {
            fail('CAL_VALIDATION_ERROR', 'write.addressBase must be 0 or 1');
        }
        checkIntRange(w.startAddress, 'write.startAddress', 0, 65535);
        if (w.addressBase === 1) {
            if (w.startAddress < 1) {
                fail('CAL_VALIDATION_ERROR', 'write.startAddress must be >= 1 for addressBase 1');
            }
        }
        if (w.functionCode !== undefined && w.functionCode !== 16) {
            fail('CAL_VALIDATION_ERROR', 'write.functionCode only supports 16');
        }
        w.functionCode = 16;
        if (['coefficients', 'points-interleaved'].indexOf(w.payload || 'coefficients') === -1) {
            fail('CAL_VALIDATION_ERROR', 'write.payload must be "coefficients" or "points-interleaved"');
        }
        w.payload = w.payload || 'coefficients';
        if (!codec.NUMERIC_TYPES[w.numericType]) {
            fail('CAL_VALIDATION_ERROR', 'write.numericType is invalid');
        }
        if (codec.NUMERIC_TYPES[w.numericType].orders.indexOf(w.wordOrder) === -1) {
            fail('CAL_VALIDATION_ERROR', 'write.wordOrder is invalid for ' + w.numericType);
        }
        w.verifyDelayMs = w.verifyDelayMs === undefined ? 1000 : w.verifyDelayMs;
        checkIntRange(w.verifyDelayMs, 'write.verifyDelayMs', 0, 60000);
        if (['bytes', 'numeric'].indexOf(w.verifyMode || 'numeric') === -1) {
            fail('CAL_VALIDATION_ERROR', 'write.verifyMode must be "bytes" or "numeric"');
        }
        w.verifyMode = w.verifyMode || 'numeric';
        w.verifyTolerance = w.verifyTolerance === undefined ? 0 : checkFinite(w.verifyTolerance, 'write.verifyTolerance');
        w.rollbackOnFailure = w.rollbackOnFailure !== false;
    } else {
        fail('CAL_VALIDATION_ERROR', 'write.mode must be "tags" or "raw-block"');
    }

    if (p.permissionRoles !== undefined && typeof p.permissionRoles !== 'object') {
        fail('CAL_VALIDATION_ERROR', 'permissionRoles must be an object');
    }
    return p;
}

/**
 * Validate raw-block address against the configured allowlist.
 * ranges: [{ start, end }] zero-based inclusive
 */
function isAddressAllowed(allowlist, deviceId, start, end) {
    if (!Array.isArray(allowlist)) {
        return false;
    }
    return allowlist.some(range =>
        range && range.deviceId === deviceId &&
        start >= range.start && end <= range.end
    );
}

module.exports = {
    validateProfile: validateProfile,
    isAddressAllowed: isAddressAllowed,
    checkFinite: checkFinite,
    isFiniteNumber: isFiniteNumber,
    SAMPLING_DEFAULTS: SAMPLING_DEFAULTS,
    QUALITY_DEFAULTS: QUALITY_DEFAULTS
};
