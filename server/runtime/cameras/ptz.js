/**
 * 'cameras/ptz': PTZ / preset / cruise control for IP cameras.
 *
 * Uses only publicly documented vendor HTTP interfaces:
 *   - Hikvision : ISAPI /ISAPI/PTZCtrl/channels/{ch}/continuous  + /presets/{id}/goto
 *   - Dahua     : CGI   /cgi-bin/ptz.cgi?action=start&code=Up&arg1..arg3
 *   - Uniview   : CGI   /cgi-bin/ptz.cgi?action=... (same shape as Dahua)
 *   - onvif/custom: not implemented server-side (returns CAM_PTZ_UNSUPPORTED)
 *
 * PTZ is best-effort: a camera that is offline yields CAM_UNREACHABLE, never an
 * unhandled rejection.
 */

'use strict';

const client = require('./camera-client');
const presets = require('./vendor-presets');

const PTZ_TIMEOUT = 5000;

/** direction -> Dahua/Uniview 'code' value */
const DAHUA_CODE = {
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    leftUp: 'LeftUp', rightUp: 'RightUp', leftDown: 'LeftDown', rightDown: 'RightDown',
    zoomIn: 'ZoomTele', zoomOut: 'ZoomWide',
    focusNear: 'FocusNear', focusFar: 'FocusFar',
    irisOpen: 'IrisOpen', irisClose: 'IrisClose',
    stop: 'Stop'
};

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function httpBase(camera, v) {
    const port = camera.httpPort || v.defaultHttpPort || 80;
    return `http://${camera.host}:${port}`;
}

/** Build the vendor PTZ request (method, url, body, contentType). */
function buildPtzRequest(camera, action) {
    const v = presets.VENDORS[camera.vendor] || presets.VENDORS.custom;
    const ch = Number(camera.channel) || 1;
    const base = httpBase(camera, v);

    if (camera.vendor === 'hikvision') {
        const speed = Math.min(100, Math.max(1, Math.round((action.speed || 1) * 50)));
        // action.code in {'up','down',...,'stop'}
        const map = {
            up: { x: 0, y: speed }, down: { x: 0, y: -speed },
            left: { x: -speed, y: 0 }, right: { x: speed, y: 0 },
            leftUp: { x: -speed, y: speed }, rightUp: { x: speed, y: speed },
            leftDown: { x: -speed, y: -speed }, rightDown: { x: speed, y: -speed },
            zoomIn: { x: 0, y: 0, zoom: speed }, zoomOut: { x: 0, y: 0, zoom: -speed },
            stop: { x: 0, y: 0, zoom: 0 }
        };
        const m = map[action.code] || map.stop;
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<PTZData><pan>${m.x || 0}</pan><tilt>${m.y || 0}</tilt><zoom>${m.zoom || 0}</zoom></PTZData>`;
        return {
            method: 'PUT',
            url: `${base}/ISAPI/PTZCtrl/channels/${ch}/continuous`,
            body: body,
            contentType: 'application/xml'
        };
    }

    if (camera.vendor === 'dahua' || camera.vendor === 'uniview') {
        const code = DAHUA_CODE[action.code] || 'Stop';
        const arg2 = Math.min(8, Math.max(1, Math.round((action.speed || 1) * 4)));
        const arg3 = Math.min(8, Math.max(1, Math.round((action.speed || 1) * 4)));
        const cmd = action.code === 'stop' ? 'stop' : 'start';
        return {
            method: 'GET',
            url: `${base}/cgi-bin/ptz.cgi?action=${cmd}&channel=${ch}&code=${code}` +
                 `&arg1=0&arg2=${arg2}&arg3=${arg3}`,
            body: null,
            contentType: null
        };
    }

    fail('CAM_PTZ_UNSUPPORTED', `PTZ is not implemented for vendor '${camera.vendor}'`);
}

/** Build a preset goto request. */
function buildPresetRequest(camera, presetId, op) {
    const v = presets.VENDORS[camera.vendor] || presets.VENDORS.custom;
    const ch = Number(camera.channel) || 1;
    const id = Math.max(1, Math.min(300, Number(presetId) || 1));
    const base = httpBase(camera, v);

    if (camera.vendor === 'hikvision') {
        if (op === 'goto') {
            return { method: 'PUT', url: `${base}/ISAPI/PTZCtrl/channels/${ch}/presets/${id}/goto`, body: '', contentType: 'application/xml' };
        }
        if (op === 'set') {
            return { method: 'PUT', url: `${base}/ISAPI/PTZCtrl/channels/${ch}/presets/${id}`, body: '', contentType: 'application/xml' };
        }
        if (op === 'delete') {
            return { method: 'DELETE', url: `${base}/ISAPI/PTZCtrl/channels/${ch}/presets/${id}`, body: null, contentType: null };
        }
    }
    if (camera.vendor === 'dahua' || camera.vendor === 'uniview') {
        const code = op === 'goto' ? 'GotoPreset' : (op === 'set' ? 'SetPreset' : 'ClearPreset');
        return {
            method: 'GET',
            url: `${base}/cgi-bin/ptz.cgi?action=start&channel=${ch}&code=${code}&arg1=0&arg2=${id}&arg3=0`,
            body: null,
            contentType: null
        };
    }
    fail('CAM_PTZ_UNSUPPORTED', `presets are not implemented for vendor '${camera.vendor}'`);
}

async function _send(camera, req) {
    const res = await client.requestWithAuth(req.method, req.url, camera.username, camera.password, {
        body: req.body, contentType: req.contentType, timeoutMs: PTZ_TIMEOUT, maxBytes: 256 * 1024
    });
    if (res.status === 401 || res.status === 403) {
        fail('CAM_AUTH_FAILED', 'camera rejected the credentials');
    }
    if (res.status >= 400) {
        fail('CAM_PTZ_FAILED', 'camera returned ' + res.status);
    }
    return { ok: true, status: res.status };
}

/** Continuous PTZ move. action: { code, speed } */
async function move(camera, action) {
    if (!camera || !camera.host) { fail('CAM_VALIDATION_ERROR', 'camera has no host'); }
    try {
        const r = await _send(camera, buildPtzRequest(camera, action || {}));
        return Object.assign({ action: (action && action.code) || 'stop', vendor: camera.vendor }, r);
    } catch (err) {
        if (err.code) { throw err; }
        fail('CAM_UNREACHABLE', 'camera unreachable: ' + err.message);
    }
}

/** Preset operations: op in {'goto','set','delete'} */
async function preset(camera, presetId, op) {
    if (!camera || !camera.host) { fail('CAM_VALIDATION_ERROR', 'camera has no host'); }
    try {
        const r = await _send(camera, buildPresetRequest(camera, presetId, op || 'goto'));
        return Object.assign({ preset: Number(presetId) || 1, op: op || 'goto', vendor: camera.vendor }, r);
    } catch (err) {
        if (err.code) { throw err; }
        fail('CAM_UNREACHABLE', 'camera unreachable: ' + err.message);
    }
}

/** Capability report so the UI can enable/disable the control pad. */
function capabilities(camera) {
    const v = presets.VENDORS[camera.vendor] || presets.VENDORS.custom;
    const supported = camera.vendor === 'hikvision' || camera.vendor === 'dahua' || camera.vendor === 'uniview';
    return {
        vendor: camera.vendor,
        vendorLabel: v.label,
        ptz: supported,
        presets: supported,
        cruise: camera.vendor === 'hikvision' || camera.vendor === 'dahua',
        lens: supported,
        audio: camera.vendor === 'hikvision' || camera.vendor === 'dahua'
    };
}

module.exports = {
    move: move,
    preset: preset,
    capabilities: capabilities,
    DAHUA_CODE: DAHUA_CODE
};
