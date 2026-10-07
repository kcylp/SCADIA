/**
 * 'calibration/write-planner': build the write plan from profile.write and fit result
 *
 * Two modes per design doc 12:
 *  - tags: write gain/offset via SCADIA Tag API (setTagValue)
 *  - raw-block: encode a continuous holding-register block (FC16) with explicit
 *    byte/word order. Address base conversion happens exactly ONCE here.
 */

'use strict';

const codec = require('./register-codec');
const validators = require('./validators');

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

/**
 * Build a tags-mode write plan.
 * @returns {plan} { mode, steps: [{tagId, value}], summary }
 */
function planTagWrite(profile, fit) {
    const w = profile.write;
    if (!w || w.mode !== 'tags') {
        fail('CAL_VALIDATION_ERROR', 'profile.write is not tags mode');
    }
    const values = { gain: fit.gain, offset: fit.offset };
    const steps = w.writeOrder.map(name => ({
        tagId: name === 'gain' ? w.gainTagId : w.offsetTagId,
        name: name,
        value: values[name]
    }));
    return {
        mode: 'tags',
        steps: steps,
        verifyDelayMs: w.verifyDelayMs,
        verifyTolerance: w.verifyTolerance,
        rollbackOnFailure: w.rollbackOnFailure,
        summary: steps.map(s => `${s.name}=${s.value}`).join(', ')
    };
}

/**
 * Convert a UI address to a zero-based wire address exactly once.
 */
function toZeroBasedAddress(startAddress, addressBase) {
    return addressBase === 1 ? startAddress - 1 : startAddress;
}

/**
 * Build a raw-block write plan (holding registers, FC16).
 * @param profile with write.mode === 'raw-block'
 * @param fit LinearFitResult
 * @param points optional calibration points for points-interleaved payload
 */
function planRawBlockWrite(profile, fit, points) {
    const w = profile.write;
    if (!w || w.mode !== 'raw-block') {
        fail('CAL_VALIDATION_ERROR', 'profile.write is not raw-block mode');
    }

    const start = toZeroBasedAddress(w.startAddress, w.addressBase);
    const def = codec.NUMERIC_TYPES[w.numericType];

    let values; // array of numbers in logical order
    let labels; // per-value label
    if ((w.payload || 'coefficients') === 'coefficients') {
        const order = w.coefficientOrder || ['gain', 'offset'];
        const map = { gain: fit.gain, offset: fit.offset };
        values = order.map(name => map[name]);
        labels = order.slice();
    } else {
        if (!Array.isArray(points) || points.length === 0) {
            fail('CAL_VALIDATION_ERROR', 'points-interleaved payload requires calibration points');
        }
        const order = w.pointOrder || ['raw', 'reference'];
        values = [];
        labels = [];
        for (const p of points) {
            for (const name of order) {
                values.push(name === 'raw' ? p.mean : p.referenceValue);
                labels.push(name + '@' + p.sequence);
            }
        }
    }

    if (values.some(v => !codec.isFiniteNumber(v))) {
        fail('CAL_CODEC_NON_FINITE', 'write values must be finite');
    }

    const words = [];
    const perValueWords = [];
    for (const v of values) {
        const ws = codec.encode(v, w.numericType, w.wordOrder);
        perValueWords.push(ws.length);
        words.push(...ws);
    }

    if (words.length > 123) {
        fail('CAL_VALIDATION_ERROR', 'raw block exceeds 123 registers per FC16 frame');
    }
    const end = start + words.length - 1;
    if (start < 0 || end > 65535) {
        fail('CAL_ADDRESS_NOT_ALLOWED', 'address range out of Modbus bounds');
    }

    const hex = words.map(x => x.toString(16).padStart(4, '0')).join('');
    return {
        mode: 'raw-block',
        deviceId: w.deviceId,
        start: start,
        wordCount: words.length,
        words: words,
        hex: hex,
        labels: labels,
        perValueWords: perValueWords,
        numericType: w.numericType,
        wordOrder: w.wordOrder,
        verifyDelayMs: w.verifyDelayMs,
        verifyMode: w.verifyMode || 'numeric',
        verifyTolerance: w.verifyTolerance,
        rollbackOnFailure: w.rollbackOnFailure,
        summary: `${w.numericType} ${w.wordOrder} @${start}(${words.length} regs): ${hex}`
    };
}

/**
 * Check plan against allowlist (zero-based inclusive ranges)
 */
function checkAllowlist(settings, plan) {
    const cal = (settings && settings.calibration) || {};
    if (!cal.rawWriteEnabled) {
        fail('CAL_FORBIDDEN', 'raw write is disabled by settings');
    }
    const allowlist = cal.rawWriteAllowlist || [];
    const end = plan.start + plan.wordCount - 1;
    if (!validators.isAddressAllowed(allowlist, plan.deviceId, plan.start, end)) {
        fail('CAL_ADDRESS_NOT_ALLOWED', `address range [${plan.start}, ${end}] not allowed for device ${plan.deviceId}`);
    }
    if (plan.wordCount > (cal.maxRawWriteRegisters || 123)) {
        fail('CAL_VALIDATION_ERROR', 'register count exceeds maxRawWriteRegisters');
    }
}

module.exports = {
    planTagWrite: planTagWrite,
    planRawBlockWrite: planRawBlockWrite,
    toZeroBasedAddress: toZeroBasedAddress,
    checkAllowlist: checkAllowlist
};
