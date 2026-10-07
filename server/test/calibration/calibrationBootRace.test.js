/**
 * N-47: calibration-storage must refuse work before the async init() opens calDB.
 *
 * The defect class is the same as camera-storage batch 75: a caller reaches a
 * helper while calDB is still undefined, and the bare dereference throws a
 * TypeError inside a Promise executor. That TypeError bypasses the caller's
 * .catch and Express turns it into a bare 500. The fix is requireConnection()
 * at the entry points; this test proves the guard is actually there.
 */

'use strict';

const { expect } = require('chai');

/**
 * chai-as-promised is NOT a dependency of this repository, so `rejectedWith` does not exist here and
 * these four assertions failed with "Invalid Chai property" - which turned the whole gate red for a
 * reason that had nothing to do with the defect. Assert the domain code by hand instead; that is
 * also the stronger check, because the CODE is what api/calibration/index.js maps to 503.
 */
async function expectRejectsWithCode(promise, code) {
    try {
        await promise;
    } catch (err) {
        expect(err.code, 'the rejection must carry the domain code').to.equal(code);
        return;
    }
    throw new Error('expected a rejection with code ' + code + ', but the call resolved');
}

// Import the module WITHOUT calling init() — calDB stays undefined.
const storage = require('../../runtime/calibration/calibration-storage');

describe('N-47 calibration storage race guard', () => {
    it('run() rejects with CAL_NOT_READY when calDB is not opened', async () => {
        await expectRejectsWithCode(storage.run('SELECT 1'), 'CAL_NOT_READY');
    });

    it('get() rejects with CAL_NOT_READY when calDB is not opened', async () => {
        await expectRejectsWithCode(storage.get('SELECT 1'), 'CAL_NOT_READY');
    });

    it('all() rejects with CAL_NOT_READY when calDB is not opened', async () => {
        await expectRejectsWithCode(storage.all('SELECT 1'), 'CAL_NOT_READY');
    });

    it('tx() rejects with CAL_NOT_READY when calDB is not opened', async () => {
        await expectRejectsWithCode(storage.tx(() => Promise.resolve()), 'CAL_NOT_READY');
    });
});
