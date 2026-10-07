/**
 * 'calibration/audit': append-only write audit with hash chaining
 *
 * record_hash = sha256(previous_hash + canonical(record))
 * Chain gives tamper evidence only (doc section 20); not a substitute for an
 * external write-only log.
 */

'use strict';

const crypto = require('crypto');
const fitEngine = require('./fit-engine');

const ALGORITHM = 'sha256';

function hashRecord(previousHash, record) {
    const payload = {
        previousHash: previousHash || '',
        id: record.id,
        sessionId: record.sessionId,
        idempotencyKey: record.idempotencyKey,
        operatorId: record.operatorId,
        approverId: record.approverId || null,
        request: record.request || null,
        beforeHex: record.beforeHex || null,
        intendedHex: record.intendedHex || null,
        readbackHex: record.readbackHex || null,
        rollbackHex: record.rollbackHex || null,
        status: record.status,
        errorCode: record.errorCode || null,
        errorMessage: record.errorMessage || null,
        createdAt: record.createdAt
    };
    return ALGORITHM + ':' + crypto.createHash(ALGORITHM).update(fitEngine.canonicalStringify(payload)).digest('hex');
}

module.exports = {
    hashRecord: hashRecord,
    ALGORITHM: ALGORITHM
};
