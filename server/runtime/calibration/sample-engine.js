/**
 * 'calibration/sample-engine': timed sampling with validity filtering and stability stats
 *
 * Per design doc section 10:
 * - validity checks in strict order (exists/null/non-finite/stale/duplicate/range)
 * - MAD/Hampel outlier rejection with fallback when MAD == 0
 * - stability by sample standard deviation and optional CV percent
 * - timeout and cancellation without leaking timers
 */

'use strict';

const fitEngine = require('./fit-engine');

const DEFAULT_SAMPLE_COUNT = 8;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_AGE_MS = 5000;
const DEFAULT_MAD_THRESHOLD = 3.5;
const MIN_INTERVAL_MS = 100;

function median(values) {
    if (!values.length) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * MAD z-score of x relative to sample set. Returns null when MAD == 0 (cannot judge).
 */
function madZScore(x, values) {
    const m = median(values);
    const mad = median(values.map(v => Math.abs(v - m)));
    if (mad <= 0) {
        return { z: null, median: m, mad: mad };
    }
    return { z: (0.6745 * (x - m)) / mad, median: m, mad: mad };
}

function mean(values) {
    return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values) {
    if (values.length < 2) {
        return 0;
    }
    const m = mean(values);
    return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Statistics over accepted sample values
 */
function computeStats(acceptedValues) {
    const count = acceptedValues.length;
    if (count === 0) {
        return { mean: null, median: null, stdDev: null, min: null, max: null, cvPercent: null };
    }
    const m = mean(acceptedValues);
    const s = stdDev(acceptedValues);
    const min = Math.min(...acceptedValues);
    const max = Math.max(...acceptedValues);
    return {
        mean: m,
        median: median(acceptedValues),
        stdDev: s,
        min: min,
        max: max,
        cvPercent: Math.abs(m) > 1e-12 ? (s / Math.abs(m)) * 100 : null
    };
}

function normalizeSamplingConfig(sampling) {
    const cfg = sampling || {};
    return {
        sampleCount: Math.min(1000, Math.max(2, parseInt(cfg.sampleCount) || DEFAULT_SAMPLE_COUNT)),
        intervalMs: Math.max(MIN_INTERVAL_MS, parseInt(cfg.intervalMs) || DEFAULT_INTERVAL_MS),
        maxAgeMs: isPos(cfg.maxAgeMs) ? cfg.maxAgeMs : DEFAULT_MAX_AGE_MS,
        timeoutMs: isPos(cfg.timeoutMs) ? cfg.timeoutMs : Math.max(60000, DEFAULT_SAMPLE_COUNT * DEFAULT_INTERVAL_MS * 12),
        filter: cfg.filter === 'mad' ? 'mad' : 'none',
        madThreshold: isPos(cfg.madThreshold) ? cfg.madThreshold : DEFAULT_MAD_THRESHOLD,
        minAcceptedRatio: cfg.minAcceptedRatio > 0 && cfg.minAcceptedRatio <= 1 ? cfg.minAcceptedRatio : 0.8,
        maxStdDev: fitEngine.isFiniteNumber(cfg.maxStdDev) ? cfg.maxStdDev : null,
        maxCvPercent: fitEngine.isFiniteNumber(cfg.maxCvPercent) ? cfg.maxCvPercent : null,
        minValue: fitEngine.isFiniteNumber(cfg.minValue) ? cfg.minValue : null,
        maxValue: fitEngine.isFiniteNumber(cfg.maxValue) ? cfg.maxValue : null
    };
}

function isPos(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Validate one raw reading, return { value, rejectReason } per doc 10.1 order.
 * @param {*} reading { value, timestamp } from getTagValue(tagId, true)
 * @param {number} now
 * @param {Object} cfg normalized sampling config
 * @param {Set} seenTimestamps
 */
function checkReading(reading, now, cfg, seenTimestamps) {
    if (!reading || (reading.value === undefined)) {
        return { rejectReason: 'null' };
    }
    let value = reading.value;
    if (value === null) {
        return { rejectReason: 'null' };
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') {
            return { rejectReason: 'null' };
        }
        value = Number(trimmed);
    } else if (typeof value === 'boolean') {
        return { rejectReason: 'non-finite' };
    }
    if (!fitEngine.isFiniteNumber(value)) {
        return { rejectReason: 'non-finite' };
    }
    const sourceTimestamp = typeof reading.timestamp === 'number' ? reading.timestamp : Date.parse(reading.timestamp);
    if (cfg.maxAgeMs && fitEngine.isFiniteNumber(sourceTimestamp) && (now - sourceTimestamp) > cfg.maxAgeMs) {
        return { rejectReason: 'stale' };
    }
    if (seenTimestamps.has(sourceTimestamp)) {
        return { rejectReason: 'duplicate' };
    }
    if (cfg.minValue !== null && value < cfg.minValue) {
        return { rejectReason: 'outlier' };
    }
    if (cfg.maxValue !== null && value > cfg.maxValue) {
        return { rejectReason: 'outlier' };
    }
    seenTimestamps.add(sourceTimestamp);
    return { value: value, sourceTimestamp: sourceTimestamp };
}

/**
 * SampleRun: one sampling round for one calibration point.
 *
 * getter: async () => ({ value, timestamp }) | null
 * events: onProgress({ accepted, rejected, target, latestValue, status })
 * resolve: { samples: CalibrationSample[], stats, stable, stableViolations, acceptedCount, rejectedCount }
 */
class SampleRun {
    constructor(tagId, sampling, getter) {
        this.tagId = tagId;
        this.getter = getter;
        this.cfg = normalizeSamplingConfig(sampling);
        this.samples = [];              // CalibrationSample entries
        this.rawValues = [];            // values candidate for MAD computation
        this.acceptedIdx = new Set();   // indices currently accepted
        this.seenTimestamps = new Set();
        this.canceled = false;
        this.finished = false;
        this.timer = null;
        this.timeoutTimer = null;
        this._listeners = { progress: [], error: [] };
    }

    on(event, fn) {
        this._listeners[event].push(fn);
    }

    emit(event, payload) {
        this._listeners[event].forEach(fn => {
            try { fn(payload); } catch (e) { /* listener error must not break sampling */ }
        });
    }

    cancel() {
        this.canceled = true;
        if (this._finish && !this.finished) {
            this._finish(new Error('CAL_SAMPLE_CANCELED'));
        }
    }

    _cleanup() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    }

    _recomputeMad() {
        if (this.cfg.filter !== 'mad' || this.rawValues.length < 3) {
            return;
        }
        // Re-evaluate all raw samples against MAD of current raw set
        this.rawValues.forEach((v, idx) => {
            const { z, mad } = madZScore(v, this.rawValues);
            if (z !== null && Math.abs(z) > this.cfg.madThreshold) {
                const sample = this.samples[idx];
                if (sample && sample.accepted) {
                    sample.accepted = false;
                    sample.rejectReason = 'outlier';
                    this.acceptedIdx.delete(idx);
                }
            }
            // No else branch: a value that is not an outlier keeps whatever verdict it already has,
            // which is exactly what the removed `else if (... && sample) { // keep accepted }` did -
            // it had an empty body, and its `sample` belonged to the block ABOVE, so it was a
            // ReferenceError waiting for the first clustered sample set. Measured before the fix: it
            // threw on every tick once three raw values existed with MAD > 0, and that rejection
            // (from an async tick nobody awaits) was measured to abort the node process.
        });
    }

    _acceptedValues() {
        return this.acceptedIdx.size ? [...this.acceptedIdx].map(i => this.samples[i].value) : [];
    }

    _evaluateStability(stats) {
        const violations = [];
        if (this.cfg.maxStdDev !== null && stats.stdDev > this.cfg.maxStdDev) {
            violations.push('CAL_SAMPLE_STDDEV_HIGH');
        }
        if (this.cfg.maxCvPercent !== null && stats.cvPercent !== null && stats.cvPercent > this.cfg.maxCvPercent) {
            violations.push('CAL_SAMPLE_CV_HIGH');
        }
        return violations;
    }

    async run() {
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            const finish = (err, result) => {
                if (this.finished) { return; }
                this.finished = true;
                this._cleanup();
                this._finish = null;
                if (err) { reject(err); } else { resolve(result); }
            };
            this._finish = finish;

            this.timeoutTimer = setTimeout(() => {
                finish(new Error('CAL_SAMPLE_TIMEOUT'));
            }, this.cfg.timeoutMs);

            const tick = async () => {
                if (this.canceled || this.finished) {
                    return;
                }
                const now = Date.now();
                let reading = null;
                try {
                    reading = await this.getter();
                } catch (err) {
                    reading = null;
                }
                if (this.canceled || this.finished) {
                    return;
                }
                const check = checkReading(reading, now, this.cfg, this.seenTimestamps);
                const sample = {
                    timestamp: now,
                    value: check.value !== undefined ? check.value : null,
                    sourceTimestamp: check.sourceTimestamp,
                    accepted: false,
                    rejectReason: check.rejectReason
                };
                this.samples.push(sample);
                if (check.rejectReason === undefined) {
                    sample.accepted = true;
                    sample.rejectReason = undefined;
                    this.acceptedIdx.add(this.samples.length - 1);
                    this.rawValues.push(sample.value);
                    this._recomputeMad();
                }
                const acceptedCount = this.acceptedIdx.size;
                const rejectedCount = this.samples.length - acceptedCount;
                this.emit('progress', {
                    accepted: acceptedCount,
                    rejected: rejectedCount,
                    target: this.cfg.sampleCount,
                    latestValue: sample.accepted ? sample.value : null,
                    status: 'sampling'
                });

                if (acceptedCount >= this.cfg.sampleCount) {
                    const acceptedValues = this._acceptedValues();
                    const stats = computeStats(acceptedValues);
                    const stableViolations = this._evaluateStability(stats);
                    // minAcceptedRatio: rejected raw readings must stay within ratio
                    if (this.samples.length > 0 &&
                        acceptedCount / this.samples.length < this.cfg.minAcceptedRatio) {
                        stableViolations.push('CAL_SAMPLE_ACCEPT_RATIO_LOW');
                    }
                    finish(null, {
                        samples: this.samples,
                        stats: stats,
                        stable: stableViolations.length === 0,
                        stableViolations: stableViolations,
                        acceptedCount: acceptedCount,
                        rejectedCount: rejectedCount
                    });
                } else if (now - startedAt > this.cfg.timeoutMs) {
                    finish(new Error('CAL_SAMPLE_TIMEOUT'));
                }
            };

            this.timer = setInterval(tick, this.cfg.intervalMs);
            // first sample immediately
            tick();
        });
    }
}

module.exports = {
    SampleRun: SampleRun,
    normalizeSamplingConfig: normalizeSamplingConfig,
    checkReading: checkReading,
    computeStats: computeStats,
    median: median,
    mean: mean,
    stdDev: stdDev,
    madZScore: madZScore
};