/**
 * 'api/devices': device-level REST surface for the WebAPI/HTTP integration work.
 *
 * The UI already edits devices over the socket API; these routes exist for the
 * things an integration engineer needs from a script or another system:
 *   - export a device's tag definitions to a portable JSON document
 *   - import them back (additive; never deletes, never silently overwrites)
 *   - write many tags in one request
 *   - ask a WebAPI device which tags its endpoint is actually publishing
 *
 * B4 adds the middle layer of the device model (device -> channel -> tag):
 *   - list/create/update/remove a device's channels
 *   - move tags between channels
 *   - export one channel's tags
 *
 * Auth mirrors the camera API: reads need an authenticated viewer, everything
 * that changes a project or drives an output needs admin.
 */

'use strict';

var express = require('express');
const { createAuthHelpers } = require('../_auth-context');
const tagIo = require('../../runtime/devices/tag-io');
const channelUtils = require('../../runtime/devices/channel-utils');
const { projectGuard } = require('../_domain');

var runtime;
var secureFnc;
var checkGroupsFnc;

const ERR_HTTP = {
    DEV_VALIDATION_ERROR: 400,
    DEV_NOT_FOUND: 404,
    DEV_NOT_ACTIVE: 409,
    DEV_WRITE_UNSUPPORTED: 422,
    DEV_WRITE_FAILED: 502,
    DEV_IMPORT_FAILED: 400,
    DEV_CHANNEL_INVALID: 400,
    DEV_CHANNEL_NOT_FOUND: 404,
    DEV_CHANNEL_CONFLICT: 409,
    DEV_SECURITY_DISABLED: 403,
    DEV_UNAUTHENTICATED: 401,
    DEV_FORBIDDEN: 403
};

function sendError(res, err) {
    const code = (err && err.code) || 'DEV_INTERNAL_ERROR';
    res.status(ERR_HTTP[code] || 500).json({ error: code, message: (err && err.message) || String(err) });
}

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

// The request authorisation context and the action gate come from one shared module now; this file
// used to carry its own copy. The error code prefix and the wording stay here - clients match on
// the codes, and collapsing DEV_FORBIDDEN into a shared one would be an API change.
const authHelpers = createAuthHelpers({
    getRuntime: function () { return runtime; },
    getCheckGroups: function () { return checkGroupsFnc; },
    codePrefix: 'DEV',
    domain: 'devices'
});
const authContext = authHelpers.authContext;
const requireAction = authHelpers.requireAction;

function handle(promise, res, ok, op) {
    return Promise.resolve(promise).then(ok).catch(err => {
        const level = (ERR_HTTP[err.code] || 500) < 500 ? 'warn' : 'error';
        runtime.logger[level](`api devices ${op || ''}: ${err.code || ''} ${err.message}`);
        sendError(res, err);
    });
}

/** The empty id of the implicit default channel cannot travel in a URL path;
 *  the literal 'default' (or '~') stands in for it. */
function channelParam(value) {
    const v = value === undefined || value === null ? '' : String(value);
    return (v === 'default' || v === '~') ? channelUtils.DEFAULT_CHANNEL_ID : v;
}

/** Map a channel-utils message onto a stable, actionable error code. */
function channelErrorCode(message) {
    const m = String(message || '');
    if (/not found/.test(m)) { return 'DEV_CHANNEL_NOT_FOUND'; }
    if (/already exists/.test(m)) { return 'DEV_CHANNEL_CONFLICT'; }
    return 'DEV_CHANNEL_INVALID';
}

/** Persist a device whose channel wiring changed (no driver restart needed). */
function persistDevice(device) {
    return runtime.project.setProjectData(
        runtime.project.ProjectDataCmdType.SetDevice,
        device
    );
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        var devApp = express();
        devApp.use(projectGuard(() => runtime, { noStore: true }));

        function deviceOrFail(id) {
            const devices = runtime.project.getDevices() || {};
            const device = devices[id];
            if (!device) { fail('DEV_NOT_FOUND', 'device not found: ' + id); }
            return device;
        }

        // ------------------------------------------------------------- list

        devApp.get('/api/devices', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            try {
                const devices = runtime.project.getDevices() || {};
                const list = Object.keys(devices).map(id => {
                    const d = devices[id];
                    return {
                        id: d.id,
                        name: d.name,
                        type: d.type,
                        enabled: !!d.enabled,
                        tagCount: Object.keys(d.tags || {}).length,
                        channelCount: channelUtils.getChannels(d)
                            .filter(c => !c.isDefault).length
                    };
                });
                res.json({ devices: list });
            } catch (err) {
                sendError(res, err);
            }
        });

        // ----------------------------------------------------------- export

        devApp.get('/api/devices/:id/tags', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            try {
                const device = deviceOrFail(req.params.id);
                const includeValues = req.query.values === 'true' || req.query.values === '1';
                let values = null;
                if (includeValues) {
                    values = {};
                    for (const tagId of Object.keys(device.tags || {})) {
                        const v = runtime.devices.getTagValue(tagId, false);
                        if (v !== null && v !== undefined) { values[tagId] = v; }
                    }
                }
                const doc = tagIo.exportDeviceTags(device, { includeValues: includeValues, values: values });
                if (req.query.download === 'true' || req.query.download === '1') {
                    const safeName = String(device.name || device.id).replace(/[^\w.-]+/g, '_');
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_tags.json"`);
                }
                res.json(doc);
            } catch (err) {
                sendError(res, err);
            }
        });

        // ----------------------------------------------------------- import

        devApp.post('/api/devices/:id/tags', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                const device = deviceOrFail(req.params.id);
                const body = req.body || {};
                const content = body.content !== undefined ? body.content : body;
                const normalized = tagIo.normalizeImport(content);
                if (normalized.error) {
                    fail('DEV_VALIDATION_ERROR', normalized.error);
                }
                if (!normalized.list.length) {
                    fail('DEV_VALIDATION_ERROR', 'no tag definitions found in the request');
                }

                const merged = tagIo.mergeDeviceTags(device, normalized.list, {
                    overwrite: body.overwrite === true || body.overwrite === 'true'
                });

                // Nothing imported and something was wrong: that is a failed
                // import, not a success with notes. A caller must not be able to
                // mistake "all of it was rejected" for "it worked".
                if (!merged.added.length && !merged.updated.length && merged.errors.length) {
                    fail('DEV_IMPORT_FAILED', 'no tag could be imported: ' +
                        merged.errors.slice(0, 5).map(e => `${e.id || '(no id)'}: ${e.error}`).join('; '));
                }

                // Nothing changed: do not touch the project, just report.
                if (!merged.added.length && !merged.updated.length) {
                    return {
                        added: 0, updated: 0,
                        skipped: merged.skipped.map(s => s.id),
                        errors: merged.errors
                    };
                }

                // A tag can name a channel the device does not declare (pasted
                // file, hand-edited JSON). Canonicalize so what gets stored is
                // self-consistent, and report what had to be regrouped instead
                // of leaving a tag pointing at nothing.
                const norm = channelUtils.normalizeDevice(merged.device);
                const importedDevice = norm.device;

                // persist, then apply to the running device so the new tags
                // start updating without a manual restart
                return runtime.project.setProjectData(
                    runtime.project.ProjectDataCmdType.SetDevice,
                    importedDevice
                ).then(() => {
                    try {
                        runtime.devices.updateDevice(importedDevice);
                    } catch (err) {
                        runtime.logger.warn(`api devices import: device restart failed: ${err.message}`);
                    }
                    return {
                        added: merged.added.length,
                        updated: merged.updated.length,
                        skipped: merged.skipped.map(s => s.id),
                        errors: merged.errors,
                        channelWarnings: norm.warnings,
                        tagCount: Object.keys(importedDevice.tags || {}).length
                    };
                });
            }), res, r => res.json(r), 'import-tags');
        });

        // ------------------------------------------------------ batch write

        devApp.post('/api/devices/:id/write', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                deviceOrFail(req.params.id);
                const body = req.body || {};
                const entries = Array.isArray(body) ? body : body.entries;
                if (!Array.isArray(entries) || !entries.length) {
                    fail('DEV_VALIDATION_ERROR', 'entries must be a non-empty array of {id, value}');
                }
                for (const e of entries) {
                    if (!e || e.id === undefined) {
                        fail('DEV_VALIDATION_ERROR', 'every entry needs an id');
                    }
                }
                return runtime.devices.setTagsValues(req.params.id, entries)
                    .then(result => {
                        if (!result.ok && result.written === 0 && result.failed.length) {
                            // Distinguish "the device cannot be written" from "the
                            // endpoint refused it": the first is a configuration
                            // problem, the second an operational one.
                            const allUnsupported = result.failed.every(f => f.error === 'write not supported' || f.error === 'unknown tag');
                            if (allUnsupported) {
                                fail('DEV_WRITE_UNSUPPORTED', 'this device/tag cannot be written: ' +
                                    result.failed.map(f => `${f.id}: ${f.error}`).join(', '));
                            }
                        }
                        return result;
                    })
                    .catch(err => {
                        if (err && /not active/i.test(err.message || '')) {
                            fail('DEV_NOT_ACTIVE', err.message);
                        }
                        throw err;
                    });
            }), res, r => res.status(r.ok ? 200 : 502).json(r), 'write-tags');
        });

        // --------------------------------------------------- discover tags

        // Ask a WebAPI device which tags its endpoint is actually publishing.
        devApp.post('/api/devices/:id/tags/discover', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                deviceOrFail(req.params.id);
                return runtime.devices.getDeviceTagsResult(req.params.id);
            }).then(result => {
                // The driver reports the raw request items; flatten them into the
                // same portable definition shape the import endpoint accepts.
                const flat = [];
                const seen = {};
                for (const group of (result && result.tags) || []) {
                    for (const item of [].concat(group || [])) {
                        const id = item && item.id;
                        if (!id || seen[id]) { continue; }
                        seen[id] = true;
                        flat.push({
                            id: id,
                            name: item.name || id,
                            label: item.label,
                            address: item.address || id,
                            memaddress: item.memaddress,
                            type: item.type || 'number'
                        });
                    }
                }
                return {
                    count: flat.length,
                    newTagsCount: (result && result.newTagsCount) || 0,
                    tags: flat
                };
            }), res, r => res.json(r), 'discover-tags');
        });

        // --------------------------------------------------------- channels
        //
        // The channel layer is metadata on top of `device.tags`: a channel is an
        // attribute of a tag (tag.channelId), not a container for it. That keeps
        // every tagId stable (DAQ history, alarms, calibration and the scheduler
        // all index by it) and means a channel edit never needs a driver
        // reconnect. The implicit channel ('' -> 'default' in a URL) collects the
        // tags of a plain two-layer device, and is derived, never stored.

        devApp.get('/api/devices/:id/channels', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            try {
                const device = deviceOrFail(req.params.id);
                res.json({
                    device: { id: device.id, name: device.name },
                    channels: channelUtils.getChannels(device)
                });
            } catch (err) {
                sendError(res, err);
            }
        });

        devApp.post('/api/devices/:id/channels', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                const device = deviceOrFail(req.params.id);
                const created = channelUtils.createChannel(device, req.body || {});
                if (created.error) { fail(channelErrorCode(created.error), created.error); }
                return persistDevice(created.device).then(() => ({
                    channel: created.channel,
                    channels: channelUtils.getChannels(created.device)
                }));
            }), res, r => res.status(201).json(r), 'create-channel');
        });

        devApp.put('/api/devices/:id/channels/:channelId', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                const device = deviceOrFail(req.params.id);
                const updated = channelUtils.updateChannel(device, channelParam(req.params.channelId), req.body || {});
                if (updated.error) { fail(channelErrorCode(updated.error), updated.error); }
                return persistDevice(updated.device).then(() => ({
                    channel: updated.channel,
                    channels: channelUtils.getChannels(updated.device)
                }));
            }), res, r => res.json(r), 'update-channel');
        });

        devApp.delete('/api/devices/:id/channels/:channelId', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                const device = deviceOrFail(req.params.id);
                const channelId = channelParam(req.params.channelId);
                const removed = channelUtils.removeChannel(device, channelId, {
                    reassignTo: channelParam(req.query.reassignTo)
                });
                if (removed.error) { fail(channelErrorCode(removed.error), removed.error); }
                return persistDevice(removed.device).then(() => ({
                    removed: channelId,
                    reassigned: removed.reassigned,
                    channels: channelUtils.getChannels(removed.device)
                }));
            }), res, r => res.json(r), 'remove-channel');
        });

        // Move tags into a channel; omit channelId (or use '') to move them back
        // to the default channel. Tags are never deleted, only regrouped.
        devApp.post('/api/devices/:id/tags/assign', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(Promise.resolve().then(() => {
                const device = deviceOrFail(req.params.id);
                const body = req.body || {};
                const tagIds = body.tagIds !== undefined ? body.tagIds : body.tags;
                if (!Array.isArray(tagIds) || !tagIds.length) {
                    fail('DEV_VALIDATION_ERROR', 'tagIds must be a non-empty array');
                }
                const channelId = channelParam(body.channelId);
                const assigned = channelUtils.assignTags(device, tagIds, channelId);
                if (assigned.error) {
                    fail(/not found/.test(assigned.error) ? 'DEV_CHANNEL_NOT_FOUND' : 'DEV_VALIDATION_ERROR', assigned.error);
                }
                return persistDevice(assigned.device).then(() => ({
                    channelId: channelId,
                    moved: assigned.moved,
                    errors: assigned.errors,
                    channels: channelUtils.getChannels(assigned.device)
                }));
            }), res, r => res.json(r), 'assign-tags');
        });

        // Export one channel's tags in the same portable shape the import
        // endpoint accepts, so a channel can be cloned onto another device.
        devApp.get('/api/devices/:id/channels/:channelId/tags', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            try {
                const device = deviceOrFail(req.params.id);
                const channelId = channelParam(req.params.channelId);
                const channel = channelUtils.getChannel(device, channelId);
                if (!channel) { fail('DEV_CHANNEL_NOT_FOUND', `channel '${channelId}' not found`); }
                const scoped = Object.assign({}, device, { tags: channelUtils.tagsOf(device, channelId) });
                const doc = tagIo.exportDeviceTags(scoped, {});
                doc.channel = { id: channel.id, name: channel.name };
                res.json(doc);
            } catch (err) {
                sendError(res, err);
            }
        });

        return devApp;
    },
    sendError: sendError
};
