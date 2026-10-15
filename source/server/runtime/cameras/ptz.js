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
            // Focus travels on the SAME continuous endpoint. Measured on DS-2ZCN3007(D) V5.6.18:
            // <focus> here answers statusCode 1 (OK), while /momentary answers 'Invalid Content',
            // and /ISAPI/System/Video/inputs/channels/1/focus does not exist on this firmware.
            // It only MOVES the lens while the lens is in MANUAL focus: in SEMIAUTOMATIC (the
            // factory setting) the camera accepts the command and ignores it - measured, sharpness
            // moved by less than 0.5% - so a focus action first switches the lens to manual.
            focusNear: { focus: speed }, focusFar: { focus: -speed },
            stop: { x: 0, y: 0, zoom: 0, focus: 0 }
        };
        // A code this driver does not implement has to FAIL LOUDLY. It used to fall back to
        // 'stop', so pressing (for example) iris answered 200 with ok:true while the camera did
        // nothing at all - the worst possible answer, because the button then looks broken, or
        // worse, working.
        const m = map[action.code];
        if (!m) {
            fail('CAM_PTZ_UNSUPPORTED', `the ${camera.vendor} driver does not implement '${action.code}'`);
        }
        const parts = [`<pan>${m.x || 0}</pan>`, `<tilt>${m.y || 0}</tilt>`, `<zoom>${m.zoom || 0}</zoom>`];
        if (m.focus) { parts.push(`<focus>${m.focus}</focus>`); }
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<PTZData>${parts.join('')}</PTZData>`;
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

/**
 * Lens focus style, per camera.
 *
 * Manual focus is a MODE, not a one-off command: the camera has to be switched into it first, and
 * while it is in it nobody is auto-focusing any more. Leaving a site camera stuck out of focus is a
 * worse outcome than not offering the button at all, so the lens is returned to the camera's own
 * automatic focus a few seconds after the last manual focus command.
 */
const focusState = new Map();
const FOCUS_RESTORE_MS = 15000;

function focusStyleBody(style) {
    // Both fields are required: the camera answers 400 badXmlContent without focusLimited, and the
    // enum has to be upper case ('manual' is rejected).
    return `<?xml version="1.0" encoding="UTF-8"?>
<FocusConfiguration><focusStyle>${style}</focusStyle><focusLimited>600</focusLimited></FocusConfiguration>`;
}

function buildFocusStyleRequest(camera, style) {
    const v = presets.VENDORS[camera.vendor] || presets.VENDORS.custom;
    const ch = Number(camera.channel) || 1;
    return {
        method: 'PUT',
        url: `${httpBase(camera, v)}/ISAPI/Image/channels/${ch}/focusConfiguration`,
        body: focusStyleBody(style),
        contentType: 'application/xml'
    };
}

/** Put the lens into manual focus (once per burst) and arm the automatic restore. */
async function ensureManualFocus(camera) {
    const key = camera.id || (camera.host + ':' + camera.channel);
    const st = focusState.get(key);
    if (st && st.manual) {
        clearTimeout(st.timer);
        st.timer = armFocusRestore(key, camera);
        return;
    }
    await _send(camera, buildFocusStyleRequest(camera, 'MANUAL'));
    focusState.set(key, { manual: true, timer: armFocusRestore(key, camera) });
}

function armFocusRestore(key, camera) {
    const timer = setTimeout(() => {
        _send(camera, buildFocusStyleRequest(camera, 'SEMIAUTOMATIC')).then(() => {
            focusState.delete(key);
        }).catch(err => {
            focusState.delete(key);
            console.warn('cameras/ptz: could not restore automatic focus on ' + (camera.name || key) + ': ' + err.message);
        });
    }, FOCUS_RESTORE_MS);
    if (timer.unref) { timer.unref(); }
    return timer;
}

/** Explicitly hand the lens back to the camera's automatic focus. */
async function focusAuto(camera) {
    const key = camera.id || (camera.host + ':' + camera.channel);
    const st = focusState.get(key);
    if (st && st.timer) { clearTimeout(st.timer); }
    focusState.delete(key);
    const r = await _send(camera, buildFocusStyleRequest(camera, 'SEMIAUTOMATIC'));
    return Object.assign({ action: 'focusAuto', vendor: camera.vendor }, r);
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

/**
 * Step ("click once, move a little") support.
 *
 * Zoom / focus / iris are CONTINUOUS resources on the camera: once a move is sent, somebody has to
 * send 'stop' or the lens keeps travelling until it hits its mechanical end. The control pad used
 * to send a move on click and never a stop - measured symptom: one click on the zoom button ran the
 * lens all the way in, and the operator could not stop it.
 *
 * So: a move carrying 'ms' is a STEP, and the server owns the ending. The stop is armed AFTER the
 * move really went out (a failed move must not be followed by a stray stop), and a second step on
 * the same camera just pushes the deadline back - so clicking repeatedly steps repeatedly, the way
 * a key repeat feels, instead of fighting a stop that fires mid-click.
 */
const STEP_DEFAULT_MS = 200;
const STEP_MAX_MS = 3000;
const stepTimers = new Map();

function stepKey(camera) { return camera.id || (camera.host + ':' + camera.channel); }

function armStepStop(camera, ms) {
    const key = stepKey(camera);
    const prev = stepTimers.get(key);
    if (prev) { clearTimeout(prev); }
    const timer = setTimeout(() => {
        stepTimers.delete(key);
        _send(camera, buildPtzRequest(camera, { code: 'stop' })).catch(err => {
            console.warn('cameras/ptz: step stop failed on ' + (camera.name || key) + ': ' + err.message);
        });
    }, ms);
    if (timer.unref) { timer.unref(); }
    stepTimers.set(key, timer);
}

/** Continuous PTZ move. action: { code, speed, ms }. With ms > 0 the move self-stops after ms. */
async function move(camera, action) {
    if (!camera || !camera.host) { fail('CAM_VALIDATION_ERROR', 'camera has no host'); }
    try {
        const code = (action && action.code) || 'stop';
        if (camera.vendor === 'hikvision' && (code === 'focusNear' || code === 'focusFar')) {
            await ensureManualFocus(camera);
        }
        const r = await _send(camera, buildPtzRequest(camera, action || {}));
        const ms = Number(action && action.ms);
        if (code !== 'stop' && ms > 0) { armStepStop(camera, Math.min(STEP_MAX_MS, Math.max(50, ms))); }
        return Object.assign({ action: (action && action.code) || 'stop', stepMs: code !== 'stop' && ms > 0 ? ms : 0, vendor: camera.vendor }, r);
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
        // Per-camera step length for the "click once, move a little" buttons. A dome and a box
        // camera do not want the same nudge, so this is a camera field, not a global constant.
        stepMs: Number(camera.ptzStepMs) > 0 ? Number(camera.ptzStepMs) : STEP_DEFAULT_MS,
        // Whether the camera can really pan/tilt is a PER-CAMERA fact: a dome has motors, a plain
        // fixed box camera has none (its PTZ commands would go out on RS-485 to a head that may not
        // be there). Default is "yes" so nothing changes for a fleet that does have heads; set
        // ptzPanTilt:false on a camera record and the direction pad disappears for that camera only.
        panTilt: supported && camera.ptzPanTilt !== false,
        // No vendor branch below implements iris, and the box cameras this product drives expose an
        // automatic iris with no tunable parameters at all (measured: the exposure resource carries
        // only <ExposureType>, no shutter/gain). Reporting it here made the UI show a control that
        // could never work, so it is reported as unsupported instead.
        iris: false,
        audio: camera.vendor === 'hikvision' || camera.vendor === 'dahua'
    };
}

module.exports = {
    move: move,
    preset: preset,
    focusAuto: focusAuto,
    capabilities: capabilities,
    DAHUA_CODE: DAHUA_CODE
};
