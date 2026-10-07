/**
 * 'calibration/write-coordinator': snapshot -> write -> readback -> rollback
 *
 * Mode A (tags): uses SCADIA devices.getTagValue/setTagValue. Two separate tags are
 * two bus operations; never claim atomicity.
 * Mode B (raw-block): uses the restricted raw holding-register API exposed by
 * runtime.devices; caller must already enforce settings + allowlist.
 *
 * The caller (calibration-service) owns persistence of audit records and must
 * persist the before/intended snapshot BEFORE the first write command is sent.
 */

'use strict';

const codec = require('./register-codec');

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toleranceOk(expected, actual, tolerance) {
    if (typeof expected !== 'number' || typeof actual !== 'number' || !Number.isFinite(expected) || !Number.isFinite(actual)) {
        return false;
    }
    return Math.abs(expected - actual) <= (tolerance || 0);
}

/**
 * Execute a tags-mode write plan.
 * @param {*} runtime SCADIA runtime
 * @param {*} plan from write-planner.planTagWrite
 * @param {*} notify progress callback (event, payload) or null
 * @returns {result} { status: 'applied'|'failed'|'uncertain', before, intended, readback, rollback, verified, error }
 */
async function executeTagWrite(runtime, plan, notify) {
    const devices = runtime.devices;
    const notifyFn = typeof notify === 'function' ? notify : () => {};

    // 1. snapshot before values
    const before = {};
    for (const step of plan.steps) {
        const val = devices.getTagValue(step.tagId, true);
        before[step.tagId] = val && typeof val === 'object' ? val.value : (val === undefined ? null : val);
    }
    // before-snapshot notification is awaited: the caller must persist the
    // snapshot before the first write command leaves this process.
    await notifyFn('before-snapshot', { before: before });

    const intended = {};
    for (const step of plan.steps) {
        intended[step.tagId] = step.value;
    }

    // 2. write in configured order
    const written = [];
    try {
        for (const step of plan.steps) {
            notifyFn('write-progress', { phase: 'write', tagId: step.tagId, name: step.name, value: step.value });
            const ok = await devices.setTagValue(step.tagId, step.value);
            if (ok === null || ok === false) {
                fail('CAL_DEVICE_WRITE_FAILED', `setTagValue failed for tag ${step.tagId}`);
            }
            written.push(step);
        }
    } catch (err) {
        // write step failed: try rollback of already-written steps
        const rollback = await _rollbackTags(runtime, plan, written, before, notifyFn);
        return {
            status: rollback.verified ? 'failed' : 'uncertain',
            before: before,
            intended: intended,
            readback: null,
            rollback: rollback,
            verified: false,
            error: { code: err.code || 'CAL_DEVICE_WRITE_FAILED', message: err.message }
        };
    }

    // 3. wait at least one polling cycle / configured delay
    if (plan.verifyDelayMs > 0) {
        await delay(plan.verifyDelayMs);
    }

    // 4. readback and verify
    const readback = {};
    let verified = true;
    for (const step of plan.steps) {
        const val = devices.getTagValue(step.tagId, true);
        const rv = val && typeof val === 'object' ? val.value : (val === undefined ? null : val);
        readback[step.tagId] = rv;
        if (!toleranceOk(step.value, rv, plan.verifyTolerance)) {
            verified = false;
        }
    }
    notifyFn('write-progress', { phase: 'verify', readback: readback, verified: verified });

    if (verified) {
        return {
            status: 'applied',
            before: before,
            intended: intended,
            readback: readback,
            rollback: null,
            verified: true,
            error: null
        };
    }

    // 5. verification mismatch -> optional rollback
    if (plan.rollbackOnFailure) {
        const rollback = await _rollbackTags(runtime, plan, plan.steps, before, notifyFn);
        return {
            status: rollback.verified ? 'failed' : 'uncertain',
            before: before,
            intended: intended,
            readback: readback,
            rollback: rollback,
            verified: false,
            error: { code: 'CAL_VERIFY_FAILED', message: 'readback does not match intended values' }
        };
    }
    return {
        status: 'failed',
        before: before,
        intended: intended,
        readback: readback,
        rollback: null,
        verified: false,
        error: { code: 'CAL_VERIFY_FAILED', message: 'readback does not match intended values' }
    };
}

async function _rollbackTags(runtime, plan, stepsToUndo, before, notifyFn) {
    const devices = runtime.devices;
    const undone = [];
    for (const step of [...stepsToUndo].reverse()) {
        try {
            notifyFn('write-progress', { phase: 'rollback', tagId: step.tagId, value: before[step.tagId] });
            const bv = before[step.tagId];
            if (bv === null || bv === undefined) {
                continue;
            }
            const ok = await devices.setTagValue(step.tagId, bv);
            if (ok === null || ok === false) {
                throw new Error('setTagValue rollback failed for ' + step.tagId);
            }
            undone.push(step.tagId);
        } catch (err) {
            runtime.logger && runtime.logger.error('calibration rollback error: ' + err.message);
            return { undone: undone, verified: false, error: { code: 'CAL_ROLLBACK_FAILED', message: err.message } };
        }
    }
    // verify rollback restored before values
    let verified = true;
    const rollbackReadback = {};
    if (plan.verifyDelayMs > 0) {
        await delay(plan.verifyDelayMs);
    }
    for (const step of stepsToUndo) {
        const bv = before[step.tagId];
        if (bv === null || bv === undefined) { continue; }
        const val = devices.getTagValue(step.tagId, true);
        const rv = val && typeof val === 'object' ? val.value : (val === undefined ? null : val);
        rollbackReadback[step.tagId] = rv;
        if (!toleranceOk(bv, rv, plan.verifyTolerance)) {
            verified = false;
        }
    }
    return { undone: undone, verified: verified, readback: rollbackReadback, error: null };
}

/**
 * Execute a raw-block write plan via the restricted raw register API.
 * @param {*} runtime SCADIA runtime
 * @param {*} plan from write-planner.planRawBlockWrite
 */
async function executeRawBlockWrite(runtime, plan, notify) {
    const devices = runtime.devices;
    const notifyFn = typeof notify === 'function' ? notify : () => {};

    if (typeof devices.readRawHoldingRegisters !== 'function' || typeof devices.writeRawHoldingRegisters !== 'function') {
        fail('CAL_FORBIDDEN', 'raw register API is not available');
    }

    let beforeWords;
    try {
        beforeWords = await devices.readRawHoldingRegisters(plan.deviceId, plan.start, plan.wordCount);
    } catch (err) {
        fail('CAL_DEVICE_OFFLINE', 'read before snapshot failed: ' + err.message);
    }
    if (!Array.isArray(beforeWords) || beforeWords.length !== plan.wordCount) {
        fail('CAL_DEVICE_WRITE_FAILED', 'before snapshot returned invalid register count');
    }
    const beforeHex = beforeWords.map(w => w.toString(16).padStart(4, '0')).join('');
    // awaited: caller must persist beforeHex before the write command is sent
    await notifyFn('before-snapshot', { beforeHex: beforeHex });

    // write
    try {
        notifyFn('write-progress', { phase: 'write', start: plan.start, wordCount: plan.wordCount, hex: plan.hex });
        await devices.writeRawHoldingRegisters(plan.deviceId, plan.start, plan.words);
    } catch (err) {
        // rollback not possible yet (write failed); snapshot was taken
        return {
            status: 'failed',
            beforeHex: beforeHex,
            intendedHex: plan.hex,
            readbackHex: null,
            rollbackHex: null,
            verified: false,
            error: { code: 'CAL_DEVICE_WRITE_FAILED', message: err.message }
        };
    }

    if (plan.verifyDelayMs > 0) {
        await delay(plan.verifyDelayMs);
    }

    // readback
    let readbackWords;
    try {
        readbackWords = await devices.readRawHoldingRegisters(plan.deviceId, plan.start, plan.wordCount);
    } catch (err) {
        return {
            status: 'uncertain',
            beforeHex: beforeHex,
            intendedHex: plan.hex,
            readbackHex: null,
            rollbackHex: null,
            verified: false,
            error: { code: 'CAL_STATE_UNCERTAIN', message: 'readback failed: ' + err.message }
        };
    }
    const readbackHex = readbackWords.map(w => w.toString(16).padStart(4, '0')).join('');

    let verified;
    if (plan.verifyMode === 'bytes') {
        verified = readbackHex === plan.hex;
    } else {
        // numeric: decode readback with same layout and compare with tolerance per value
        verified = true;
        let offset = 0;
        for (let i = 0; i < plan.labels.length; i++) {
            const wc = plan.perValueWords[i];
            const chunk = readbackWords.slice(offset, offset + wc);
            let actual;
            try {
                actual = codec.decode(chunk, plan.numericType, plan.wordOrder);
            } catch (err) {
                verified = false;
                break;
            }
            // recompute the intended value from plan words to avoid float drift
            const intendedValue = codec.decode(plan.words.slice(offset, offset + wc), plan.numericType, plan.wordOrder);
            if (!toleranceOk(intendedValue, actual, plan.verifyTolerance)) {
                verified = false;
                break;
            }
            offset += wc;
        }
    }
    notifyFn('write-progress', { phase: 'verify', readbackHex: readbackHex, verified: verified });

    if (verified) {
        return {
            status: 'applied',
            beforeHex: beforeHex,
            intendedHex: plan.hex,
            readbackHex: readbackHex,
            rollbackHex: null,
            verified: true,
            error: null
        };
    }

    if (plan.rollbackOnFailure) {
        try {
            notifyFn('write-progress', { phase: 'rollback', hex: beforeHex });
            await devices.writeRawHoldingRegisters(plan.deviceId, plan.start, beforeWords);
            if (plan.verifyDelayMs > 0) {
                await delay(plan.verifyDelayMs);
            }
            const rb = await devices.readRawHoldingRegisters(plan.deviceId, plan.start, plan.wordCount);
            const rollbackHex = rb.map(w => w.toString(16).padStart(4, '0')).join('');
            return {
                status: rollbackHex === beforeHex ? 'failed' : 'uncertain',
                beforeHex: beforeHex,
                intendedHex: plan.hex,
                readbackHex: readbackHex,
                rollbackHex: rollbackHex,
                verified: false,
                error: { code: 'CAL_VERIFY_FAILED', message: 'readback does not match intended bytes' }
            };
        } catch (err) {
            return {
                status: 'uncertain',
                beforeHex: beforeHex,
                intendedHex: plan.hex,
                readbackHex: readbackHex,
                rollbackHex: null,
                verified: false,
                error: { code: 'CAL_STATE_UNCERTAIN', message: 'rollback failed: ' + err.message }
            };
        }
    }
    return {
        status: 'failed',
        beforeHex: beforeHex,
        intendedHex: plan.hex,
        readbackHex: readbackHex,
        rollbackHex: null,
        verified: false,
        error: { code: 'CAL_VERIFY_FAILED', message: 'readback does not match intended bytes' }
    };
}

module.exports = {
    executeTagWrite: executeTagWrite,
    executeRawBlockWrite: executeRawBlockWrite,
    toleranceOk: toleranceOk
};
