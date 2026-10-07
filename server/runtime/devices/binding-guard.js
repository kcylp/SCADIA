/**
 * devices/binding-guard: detect that a device was rebound WHILE a read was in flight,
 * and drop the result if so (contract 09 section 4.3).
 *
 * WHY THIS EXISTS
 * A device is rebound IN PLACE: updateDevice() stops it and loadDevice() runs again on the
 * same object, rebuilding the driver tag maps. Clearing the polling timer does NOT cancel a
 * read that is already awaiting its transport, so that answer can arrive after the rebind
 * and be stored as if it belonged to the new binding.
 *
 * HOW A DRIVER USES IT
 *   const rev = bindingRevisionOf(data, runtime);   // when the read STARTS
 *   ... await transport ...
 *   if (bindingChangedSince(data, rev, runtime)) {  // when it COMPLETES
 *       // drop the result
 *   }
 *
 * TWO SOURCES OF THE REVISION
 *   data.bindingRevision    - stamped onto the definition by the devices manager before
 *                             load(); the driver holds a CLONE, so this value is the
 *                             generation that clone belongs to and never changes under it.
 *   runtime.devices.getBindingRevision(id) - the LIVE generation of the device.
 * A rebind during a read makes the live value differ from the cloned one, which is exactly
 * the signal we need. Comparing the live value against itself would never detect anything.
 *
 * SAFETY: a revision of 0 means tracking is unavailable; the guard then never blocks, so
 * drivers and code paths that do not participate behave exactly as before.
 */

'use strict';

/**
 * The generation a driver read belongs to.
 * Prefers the cloned definition the driver was loaded with; falls back to the live value
 * when a driver has no clone (e.g. a test double).
 *
 * @param {object} data driver device data
 * @param {object} [runtime]
 * @returns {number}
 */
function bindingRevisionOf(data, runtime) {
    if (data && typeof data.bindingRevision === 'number') { return data.bindingRevision; }
    if (data && typeof data.getBindingRevision === 'function') {
        try { return Number(data.getBindingRevision()) || 0; } catch (err) { /* fall through */ }
    }
    if (runtime && runtime.devices && typeof runtime.devices.getBindingRevision === 'function'
        && data && data.id) {
        try { return Number(runtime.devices.getBindingRevision(data.id)) || 0; } catch (err) { /* fall through */ }
    }
    return 0;
}

/**
 * True when the device was rebound while a read stamped with @revision@ was in flight.
 *
 * @param {object} data
 * @param {number} revision value captured when the read started
 * @param {object} [runtime]
 * @returns {boolean}
 */
function bindingChangedSince(data, revision, runtime) {
    if (!revision) { return false; }
    if (!runtime || !runtime.devices || typeof runtime.devices.getBindingRevision !== 'function') { return false; }
    if (!data || !data.id) { return false; }
    let live = 0;
    try { live = Number(runtime.devices.getBindingRevision(data.id)) || 0; } catch (err) { return false; }
    return !!live && live !== revision;
}

module.exports = {
    bindingRevisionOf: bindingRevisionOf,
    bindingChangedSince: bindingChangedSince
};
