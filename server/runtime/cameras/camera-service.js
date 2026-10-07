/**
 * 'cameras/camera-service': validation, credential-safe projection, live access.
 */

'use strict';

const crypto = require('crypto');
const storage = require('./camera-storage');
const presets = require('./vendor-presets');
const client = require('./camera-client');
const ptz = require('./ptz');

const STREAM_MODES = ['snapshot', 'mjpeg', 'hls', 'flv', 'webrtc', 'iframe'];

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}
function assert(ok, code, msg) { if (!ok) { fail(code, msg); } }
function newId() { return 'cam_' + crypto.randomBytes(6).toString('hex'); }
function isStr(v) { return typeof v === 'string' && v.trim().length > 0; }

function validate(camera) {
    assert(camera && typeof camera === 'object', 'CAM_VALIDATION_ERROR', 'camera payload required');
    assert(isStr(camera.name) && camera.name.length <= 120, 'CAM_VALIDATION_ERROR', 'name is required (max 120)');
    assert(presets.VENDORS[camera.vendor], 'CAM_VALIDATION_ERROR', 'unknown vendor: ' + camera.vendor);

    if (camera.vendor === 'custom') {
        assert(isStr(camera.rtspTemplate) || isStr(camera.snapshotTemplate),
            'CAM_VALIDATION_ERROR', 'custom vendor requires an RTSP or snapshot template');
    } else {
        assert(isStr(camera.host), 'CAM_VALIDATION_ERROR', 'host is required');
    }

    const out = Object.assign({}, camera);
    out.port = Number(out.port) || presets.VENDORS[out.vendor].defaultPort;
    out.httpPort = Number(out.httpPort) || presets.VENDORS[out.vendor].defaultHttpPort;
    out.channel = Math.max(1, Number(out.channel) || 1);
    out.subtype = Number(out.subtype) === 1 ? 1 : 0;
    out.streamMode = STREAM_MODES.indexOf(out.streamMode) >= 0 ? out.streamMode : 'snapshot';
    out.previewFps = Math.min(25, Math.max(1, Number(out.previewFps) || 4));
    out.enabled = out.enabled !== false;
    out.aiEnabled = out.aiEnabled === true;
    out.statusTagId = (typeof out.statusTagId === 'string' && out.statusTagId.trim()) ? out.statusTagId.trim() : null;
    out.osd = (out.osd && typeof out.osd === 'object' && Array.isArray(out.osd.items))
        ? { items: out.osd.items.slice(0, 20).map(i => ({
            type: ['text', 'time', 'value'].indexOf(i.type) >= 0 ? i.type : 'text',
            label: i.label || '',
            text: i.text || '',
            format: i.format || 'time',
            tagId: i.tagId || null,
            unit: i.unit || '',
            decimals: Number.isFinite(i.decimals) ? i.decimals : 2,
            position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].indexOf(i.position) >= 0
                ? i.position : 'top-left'
        })) }
        : null;
    return out;
}

/** Public projection: never expose the password. */
function toPublic(camera) {
    if (!camera) { return null; }
    const copy = Object.assign({}, camera);
    delete copy.password;
    copy.hasPassword = !!camera.password;
    copy.endpoints = publicEndpoints(camera);
    copy.statusTagLinked = !!camera.statusTagId;
    return copy;
}

/** Endpoint preview with credentials stripped (safe to show in the UI). */
function publicEndpoints(camera) {
    const ep = presets.resolveEndpoints(camera);
    const strip = (u) => u ? u.replace(/\/\/[^@/]*@/, '//***:***@') : u;
    return { rtsp: strip(ep.rtsp), snapshot: strip(ep.snapshot), mjpeg: strip(ep.mjpeg), vendor: ep.vendorLabel, auth: ep.auth };
}

async function save(payload) {
    const cam = validate(payload);
    cam.id = payload.id || newId();
    if (payload.id) {
        const existing = await storage.getCamera(payload.id);
        assert(existing, 'CAM_NOT_FOUND', 'camera not found: ' + payload.id);
        // keep the stored password when the client sends none (masked edit)
        if (!payload.password) { cam.password = existing.password; }
    }
    const saved = await storage.save(cam);
    return toPublic(saved);
}

function getCamera(id) { return storage.getCamera(id); }
function list() { return storage.getCameras().then(rows => rows.map(toPublic)); }

async function remove(id) {
    const c = await storage.getCamera(id);
    assert(c, 'CAM_NOT_FOUND', 'camera not found: ' + id);
    return storage.deleteCamera(id);
}

/** Fetch one JPEG frame server-side (digest/basic auth handled here). */
async function snapshot(id) {
    const cam = await storage.getCamera(id);
    assert(cam, 'CAM_NOT_FOUND', 'camera not found: ' + id);
    const ep = presets.resolveEndpoints(cam);
    assert(ep.snapshot, 'CAM_NO_SNAPSHOT', 'this vendor/camera has no snapshot URL');
    try {
        const res = await client.getSnapshot(ep.snapshot, cam.username, cam.password, 6000);
        return { body: res.body, contentType: res.headers['content-type'] || 'image/jpeg' };
    } catch (err) {
        if (err.status === 401) { fail('CAM_AUTH_FAILED', 'camera rejected the credentials'); }
        fail('CAM_UNREACHABLE', 'camera unreachable: ' + err.message);
    }
}

/** Mask credentials embedded in a URL userinfo segment (never leak passwords). */
function maskUrl(u) {
    return u ? u.replace(/\/\/[^@/]*@/, '//***:***@') : u;
}

/** Connectivity probe used by the editor "test" button. */
async function probe(idOrPayload) {
    const cam = typeof idOrPayload === 'string' ? await storage.getCamera(idOrPayload) : validate(idOrPayload);
    assert(cam, 'CAM_NOT_FOUND', 'camera not found');
    const ep = presets.resolveEndpoints(cam);
    // never return credentials: the probe result is sent to the browser
    const result = { vendor: ep.vendorLabel, rtsp: maskUrl(ep.rtsp), auth: ep.auth, snapshot: { ok: false } };
    if (ep.snapshot) {
        try {
            const res = await client.getSnapshot(ep.snapshot, cam.username, cam.password, 6000);
            const isJpeg = res.body && res.body.length > 2 && res.body[0] === 0xFF && res.body[1] === 0xD8;
            result.snapshot = { ok: true, jpeg: isJpeg, bytes: res.body.length };
        } catch (err) {
            result.snapshot = { ok: false, error: err.code || err.message, status: err.status };
        }
    }
    result.ok = result.snapshot.ok;
    return result;
}

/**
 * PTZ move. Accepts a camera id or an unsaved payload, so the editor can test
 * the control pad before saving.
 */
async function ptzMove(idOrPayload, action) {
    const cam = typeof idOrPayload === 'string' ? await storage.getCamera(idOrPayload) : validate(idOrPayload);
    assert(cam, 'CAM_NOT_FOUND', 'camera not found');
    return ptz.move(cam, action);
}

async function ptzPreset(idOrPayload, presetId, op) {
    const cam = typeof idOrPayload === 'string' ? await storage.getCamera(idOrPayload) : validate(idOrPayload);
    assert(cam, 'CAM_NOT_FOUND', 'camera not found');
    return ptz.preset(cam, presetId, op);
}

async function ptzCapabilities(idOrPayload) {
    const cam = typeof idOrPayload === 'string' ? await storage.getCamera(idOrPayload) : validate(idOrPayload);
    assert(cam, 'CAM_NOT_FOUND', 'camera not found');
    return ptz.capabilities(cam);
}

module.exports = {
    STREAM_MODES: STREAM_MODES,
    list: list,
    getCamera: getCamera,
    save: save,
    remove: remove,
    snapshot: snapshot,
    probe: probe,
    ptzMove: ptzMove,
    ptzPreset: ptzPreset,
    ptzCapabilities: ptzCapabilities,
    toPublic: toPublic,
    validate: validate
};
