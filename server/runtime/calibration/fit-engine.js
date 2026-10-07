/**
 * 'calibration/fit-engine': linear least squares fit engine
 *
 * Fixed direction: raw x -> reference y, model y = k*x + b (k = gain, b = offset).
 * Pure computation module: no I/O, no state.
 */

'use strict';

const crypto = require('crypto');

const MIN_POINTS = 2;

/**
 * Validate a numeric value is a finite number
 */
function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Deterministic canonical JSON stringify (stable key order)
 */
function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/**
 * Compute linear fit over calibration points.
 * Each point: { id, mean (observed raw value), referenceValue (standard value) }
 *
 * @param {Array} points
 * @param {Object} options { minPoints, minR2, maxRmse, maxAbsError, minRawSpan }
 * @returns {LinearFitResult}
 */
function fitLinear(points, options) {
    options = options || {};
    if (!Array.isArray(points) || points.length < MIN_POINTS) {
        const err = new Error('CAL_FIT_MIN_POINTS');
        err.code = 'CAL_FIT_MIN_POINTS';
        throw err;
    }

    const rows = points.map(p => ({
        id: p.id,
        x: Number(p.mean),
        y: Number(p.referenceValue)
    }));
    if (rows.some(p => !isFiniteNumber(p.x) || !isFiniteNumber(p.y))) {
        const err = new Error('CAL_FIT_NON_FINITE');
        err.code = 'CAL_FIT_NON_FINITE';
        throw err;
    }

    const n = rows.length;
    const xMean = rows.reduce((s, p) => s + p.x, 0) / n;
    const yMean = rows.reduce((s, p) => s + p.y, 0) / n;
    const sxx = rows.reduce((s, p) => s + (p.x - xMean) ** 2, 0);

    // Scale-aware near-zero threshold: reject degenerate raw span
    const xScale = Math.max(1, Math.abs(xMean), ...rows.map(p => Math.abs(p.x)));
    const minRawSpan = isFiniteNumber(options.minRawSpan) ? options.minRawSpan : Number.EPSILON * xScale * xScale * 8;
    const rawSpan = Math.max(...rows.map(p => p.x)) - Math.min(...rows.map(p => p.x));
    if (sxx <= Number.EPSILON * xScale * xScale * 8 || rawSpan <= 0) {
        const err = new Error('CAL_FIT_ZERO_RAW_SPAN');
        err.code = 'CAL_FIT_ZERO_RAW_SPAN';
        throw err;
    }

    const sxy = rows.reduce((s, p) => s + (p.x - xMean) * (p.y - yMean), 0);
    const gain = sxy / sxx;
    const offset = yMean - gain * xMean;

    const residuals = rows.map(p => {
        const predicted = gain * p.x + offset;
        return {
            pointId: p.id,
            raw: p.x,
            reference: p.y,
            predicted: predicted,
            residual: p.y - predicted
        };
    });

    const sse = residuals.reduce((s, p) => s + p.residual ** 2, 0);
    const sst = rows.reduce((s, p) => s + (p.y - yMean) ** 2, 0);
    // Two identical reference values: R2 is not discriminative, treat perfect fit as 1 else 0
    const r2 = sst === 0 ? (sse === 0 ? 1 : 0) : 1 - sse / sst;
    const rmse = Math.sqrt(sse / n);
    const maxAbsError = residuals.reduce((m, p) => Math.max(m, Math.abs(p.residual)), 0);

    if (![gain, offset, r2, rmse, maxAbsError].every(isFiniteNumber)) {
        const err = new Error('CAL_FIT_NON_FINITE_RESULT');
        err.code = 'CAL_FIT_NON_FINITE_RESULT';
        throw err;
    }

    const violations = [];
    if (n < (options.minPoints || MIN_POINTS)) {
        violations.push('CAL_FIT_MIN_POINTS');
    }
    // R2 has no discriminative power for a 2-point fit; only gate with >= 3 points
    if (n >= 3 && isFiniteNumber(options.minR2) && r2 < options.minR2) {
        violations.push('CAL_FIT_R2_LOW');
    }
    if (isFiniteNumber(options.maxRmse) && rmse > options.maxRmse) {
        violations.push('CAL_FIT_RMSE_HIGH');
    }
    if (isFiniteNumber(options.maxAbsError) && maxAbsError > options.maxAbsError) {
        violations.push('CAL_FIT_MAX_ABS_ERROR_HIGH');
    }
    if (isFiniteNumber(options.minRawSpan) && rawSpan < options.minRawSpan) {
        violations.push('CAL_FIT_RAW_SPAN_TOO_SMALL');
    }

    return {
        model: 'linear',
        direction: 'raw-to-reference',
        gain: gain,
        offset: offset,
        r2: r2,
        rmse: rmse,
        maxAbsError: maxAbsError,
        rawMin: Math.min(...rows.map(p => p.x)),
        rawMax: Math.max(...rows.map(p => p.x)),
        residuals: residuals,
        qualityPassed: violations.length === 0,
        violations: violations,
        calculatedAt: new Date().toISOString()
    };
}

/**
 * Stable fit hash used to bind approval to the exact fitted data
 */
function computeFitHash(fit) {
    const payload = {
        model: fit.model,
        direction: fit.direction,
        gain: fit.gain,
        offset: fit.offset,
        r2: fit.r2,
        rmse: fit.rmse,
        residuals: fit.residuals
    };
    return 'sha256:' + crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

module.exports = {
    fitLinear: fitLinear,
    computeFitHash: computeFitHash,
    canonicalStringify: canonicalStringify,
    isFiniteNumber: isFiniteNumber,
    MIN_POINTS: MIN_POINTS
};
