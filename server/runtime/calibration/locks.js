/**
 * 'calibration/locks': per-key async locks for sampling sessions and device writes
 *
 * Lock order per design doc 19.1:
 *   session -> device business lock -> physical I/O lock (SCADIA socketMutex) -> DB transaction
 */

'use strict';

function createKeyedLocks() {
    const chains = new Map();

    /**
     * Run fn while holding the lock for key. Serializes concurrent callers per key.
     * @returns Promise resolving with fn result
     */
    function withLock(key, fn) {
        const prev = chains.get(key) || Promise.resolve();
        const run = prev.catch(() => {}).then(() => fn());
        // store a tail that never rejects
        chains.set(key, run.catch(() => {}));
        // cleanup when tail settles and this is still the last one
        run.catch(() => {}).then(() => {
            if (chains.get(key) === run) {
                chains.delete(key);
            }
        });
        return run;
    }

    function isLocked(key) {
        return chains.has(key);
    }

    return {
        withLock: withLock,
        isLocked: isLocked
    };
}

module.exports = {
    createKeyedLocks: createKeyedLocks
};
