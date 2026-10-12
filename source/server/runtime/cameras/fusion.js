/**
 * 'cameras/fusion': 视数融合 — bind video to the SCADIA variable system.
 *
 * Two directions (matching 展厅's "视数融合" but on the native tag bus, no
 * extra bridge DLL):
 *
 *   1. Data -> Video  (OSD overlay)
 *      Camera OSD items reference SCADIA tags; resolveOsd() reads the live tag
 *      values server-side so the browser needs no extra socket plumbing.
 *
 *   2. Video -> Data  (status / alarm write-back)
 *      A camera's online state is periodically probed and written to a SCADIA
 *      tag (`statusTagId`, 展厅's VD/VC status variable). Alarm/IVS events can
 *      be written the same way via writeEvent().
 */

'use strict';

const storage = require('./camera-storage');
const presets = require('./vendor-presets');
const client = require('./camera-client');
const tagDomain = require('../devices/tag-domain');

const DEFAULT_POLL_MS = 15000;
const PROBE_TIMEOUT = 4000;

var runtime;
var timer = null;
var running = false;
/** cameraId -> { online, lastCheck, error, written } */
var statusCache = new Map();

function init(_runtime) {
    runtime = _runtime;
}

// --------------------------------------------------------------- tag access

function _getTag(tagId) {
    try {
        if (!tagId) { return null; }
        const v = runtime.devices.getTagValue(tagId, true);
        if (v === null || v === undefined) { return null; }
        return typeof v === 'object' ? v.value : v;
    } catch (err) {
        return null;
    }
}

/**
 * Write a tag on behalf of the video subsystem.
 *
 * A video event is an OBSERVATION the platform derived, never a measurement, so it may
 * only target a tag declared `derived` (or `predicted`). Writing it into a
 * `measured` tag - or into a tag with no marker at all, which defaults to measured -
 * is refused, because that would overwrite what a device reported and would make an
 * after-the-fact AI observation indistinguishable from a field reading.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function _setTag(tagId, value, domain) {
    try {
        if (!tagId) { return { ok: false, reason: tagDomain.REFUSAL.UNKNOWN_TAG }; }
        const declared = domain || tagDomain.DOMAINS.DERIVED;
        const tag = runtime.devices.getTagDefinition
            ? runtime.devices.getTagDefinition(tagId)
            : null;
        const verdict = tagDomain.checkSoftwareWrite(tag, declared);
        if (!verdict.ok) {
            if (runtime && runtime.logger) {
                runtime.logger.warn('camera fusion: refusing to write ' + tagId + ' (' + verdict.reason + '); declare the tag as dataDomain=derived to accept video events');
            }
            return verdict;
        }
        const ok = await runtime.devices.setTagValue(tagId, value);
        return { ok: ok !== false && ok !== null };
    } catch (err) {
        if (runtime && runtime.logger) {
            runtime.logger.warn(`camera fusion: cannot write tag ${tagId}: ${err.message}`);
        }
        return { ok: false, reason: 'write-error' };
    }
}

function _tagExists(tagId) {
    try {
        return !!runtime.devices.getDeviceIdFromTag(tagId);
    } catch (err) {
        return false;
    }
}

// ------------------------------------------------------------------- OSD

function _isFinite(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function _formatValue(value, decimals) {
    if (value === null || value === undefined) { return '--'; }
    if (_isFinite(value) && _isFinite(decimals)) {
        return Number(value).toFixed(Math.max(0, Math.min(8, decimals)));
    }
    return String(value);
}

function _formatTime(format) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    switch (format) {
        case 'date': return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        case 'weekday': return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
        case 'datetime': return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        case 'time':
        default: return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
}

/**
 * Resolve a camera's OSD items into display strings with LIVE tag values.
 * @returns {{items: Array, online: boolean}}
 */
async function resolveOsd(cameraId) {
    const cam = await storage.getCamera(cameraId);
    if (!cam) {
        const err = new Error('camera not found: ' + cameraId);
        err.code = 'CAM_NOT_FOUND';
        throw err;
    }
    const cfg = cam.osd && Array.isArray(cam.osd.items) ? cam.osd : { items: [] };
    const items = (cfg.items || []).map(item => {
        const out = {
            type: item.type || 'text',
            label: item.label || '',
            position: item.position || 'top-left',
            tagId: item.tagId || null,
            text: ''
        };
        if (out.type === 'text') {
            out.text = item.text || '';
        } else if (out.type === 'time') {
            out.text = _formatTime(item.format);
        } else if (out.type === 'value') {
            const raw = _getTag(item.tagId);
            out.value = raw;
            out.text = (item.label ? item.label + ' ' : '') + _formatValue(raw, item.decimals) +
                (item.unit ? ' ' + item.unit : '');
            out.quality = raw === null ? 'bad' : 'good';
        }
        return out;
    });
    const status = statusCache.get(cameraId);
    return { cameraId: cameraId, items: items, online: status ? status.online : null, ts: Date.now() };
}

// ------------------------------------------------------- status write-back

/** Probe one camera's snapshot reachability and update the cache. */
async function probeStatus(camera) {
    const ep = presets.resolveEndpoints(camera);
    let online = false;
    let error = null;
    if (ep.snapshot) {
        try {
            await client.getSnapshot(ep.snapshot, camera.username, camera.password, PROBE_TIMEOUT);
            online = true;
        } catch (err) {
            online = false;
            error = err.code || err.message;
        }
    } else {
        // no snapshot url: fall back to a TCP-ish reachability check via RTSP build
        error = 'NO_SNAPSHOT';
    }
    const prev = statusCache.get(camera.id);
    const rec = { online: online, lastCheck: Date.now(), error: error, written: false };
    statusCache.set(camera.id, rec);

    // write back to the SCADIA tag on change (or first time)
    if (camera.statusTagId && _tagExists(camera.statusTagId)) {
        const changed = !prev || prev.online !== online;
        if (changed) {
            const verdict = await _setTag(camera.statusTagId, online ? 1 : 0);
            rec.written = verdict.ok === true;
            rec.writeRefused = verdict.ok === true ? undefined : verdict.reason;
        } else {
            rec.written = prev.written;
        }
    }
    return rec;
}

/** One full pass over all enabled cameras. */
async function pollOnce() {
    const cameras = await storage.getCameras();
    const enabled = cameras.filter(c => c.enabled !== false);
    const results = [];
    for (const cam of enabled) {
        try {
            const rec = await probeStatus(cam);
            results.push({ id: cam.id, name: cam.name, online: rec.online, error: rec.error });
        } catch (err) {
            results.push({ id: cam.id, name: cam.name, online: false, error: err.message });
        }
    }
    return results;
}

function start(intervalMs) {
    stop();
    const ms = Math.max(5000, Number(intervalMs) || DEFAULT_POLL_MS);
    timer = setInterval(() => {
        if (running) { return; }   // never overlap passes
        running = true;
        pollOnce()
            .catch(err => { if (runtime && runtime.logger) { runtime.logger.warn('camera fusion poll failed: ' + err.message); } })
            .then(() => { running = false; });
    }, ms);
    if (runtime && runtime.logger) {
        runtime.logger.info(`camera fusion: status poller started (${ms} ms)`);
    }
    return { intervalMs: ms };
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    running = false;
    return true;
}

function getStatus() {
    const out = {};
    statusCache.forEach((v, k) => { out[k] = v; });
    return out;
}

/**
 * Write a video-side alarm/event into a SCADIA tag (展厅的报警联动).
 *
 * The target MUST be declared `dataDomain: 'derived'` (or `predicted`). A camera event
 * is an observation the platform produced, so writing it into a measured tag would
 * corrupt the record of what the field actually reported. A refusal is reported as a
 * distinct error code so the caller can tell "tag is not a video target" apart from
 * "the write itself failed".
 *
 * @param {string} tagId target SCADIA tag
 * @param {number|boolean} value 1/0 or true/false
 */
async function writeEvent(tagId, value) {
    if (!_tagExists(tagId)) {
        const err = new Error('tag not found: ' + tagId);
        err.code = 'CAM_TAG_NOT_FOUND';
        throw err;
    }
    const v = (value === true || value === 1) ? 1 : 0;
    const verdict = await _setTag(tagId, v);
    if (!verdict.ok) {
        const refused = verdict.reason && verdict.reason !== 'write-error';
        const err = new Error((refused ? 'tag refused the write: ' : 'tag write failed: ') + tagId + ' (' + verdict.reason + ')');
        err.code = refused ? 'CAM_TAG_DOMAIN_REFUSED' : 'CAM_TAG_WRITE_FAILED';
        err.reason = verdict.reason;
        throw err;
    }
    return { tagId: tagId, value: v };
}

module.exports = {
    init: init,
    resolveOsd: resolveOsd,
    probeStatus: probeStatus,
    pollOnce: pollOnce,
    start: start,
    stop: stop,
    getStatus: getStatus,
    writeEvent: writeEvent,
    DEFAULT_POLL_MS: DEFAULT_POLL_MS
};
