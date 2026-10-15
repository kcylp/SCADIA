/**
 * 'cameras/ai/ai-service': AI video analytics hub.
 *
 * External detection engines (Frigate-style) push results in; this service
 * normalises them, keeps a short-lived per-camera box list for the browser to
 * overlay, and raises/clears a SCADIA alarm tag so a detection can drive the same
 * alarm system as any process value.
 *
 * Design choices worth naming:
 *  - boxes are EPHEMERAL: a detection is valid for `ttlMs` and then disappears,
 *    exactly like a live object leaving the frame. Nothing is written to disk,
 *    so the store cannot grow without bound.
 *  - the alarm is edge-driven with a hold: it is set when a detection arrives and
 *    cleared only after `alarmClearMs` with no further detections, so a bouncing
 *    detector does not machine-gun the tag bus.
 *  - ingest transports (MQTT / WebSocket / HTTP) only translate transport into
 *    `ingest()`; all policy lives here.
 */

'use strict';

const normalize = require('./normalize');

const DEFAULTS = {
    ttlMs: 5000,
    alarmClearMs: 15000,
    minScore: 0.5,
    maxDetections: 50
};

var settings = null;
var logger = { info: function () {}, warn: function () {}, error: function () {} };
var runtime = null;
var storage = null;

// cameraKey -> { detections: [], updatedAt }
var store = new Map();
// cameraKey -> { active: bool, timer }
var alarms = new Map();
var pruneTimer = null;
var cameraLookup = { at: 0, map: new Map() };
var stats = { ingests: 0, detections: 0, dropped: 0, alarms: 0, lastIngest: null, lastError: null };

function cfg() { return (settings && settings.ai) || {}; }

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// ------------------------------------------------------------------ resolve

/**
 * Map an engine's camera name onto one of our camera records.
 * Engines identify a camera by their own config name; operators set our camera
 * name to match, so matching on id OR name covers the common case with no extra
 * mapping table (and `settings.ai.cameraMap` covers the rest).
 */
async function resolveCameraKey(raw) {
    const key = raw ? String(raw).trim() : null;
    if (!key) { return null; }
    const map = cfg().cameraMap || {};
    if (map[key]) { return String(map[key]); }
    if (!storage || !storage.getCameras) { return key; }

    const now = Date.now();
    if (now - cameraLookup.at > 10000) {
        try {
            const cams = await storage.getCameras();
            const m = new Map();
            for (const c of cams) {
                if (c.id) { m.set(c.id, c.id); }
                if (c.name) { m.set(c.name, c.id); }
            }
            cameraLookup = { at: now, map: m };
        } catch (err) {
            cameraLookup = { at: now, map: new Map() };
        }
    }
    return cameraLookup.map.get(key) || key;
}

// ------------------------------------------------------------------- policy

function passesFilter(d) {
    const minScore = num(cfg().minScore, DEFAULTS.minScore);
    if (d.score !== null && d.score !== undefined && d.score < minScore) { return false; }
    const labels = Array.isArray(cfg().labels) ? cfg().labels : [];
    if (labels.length && labels.indexOf(d.label) < 0) { return false; }
    return true;
}

// ------------------------------------------------------------------- ingest

/**
 * Ingest one engine payload (already parsed JSON).
 * @param {object} payload
 * @param {string} source 'mqtt' | 'ws' | 'http'
 * @returns {Promise<{camera, kept, dropped, cleared, alarm}>}
 */
async function ingest(payload, source) {
    if (!cfg().enabled) { fail('AI_DISABLED', 'AI analytics is disabled (settings.ai.enabled)'); }

    stats.ingests++;
    stats.lastIngest = new Date().toISOString();

    const norm = normalize.normalizePayload(payload, {
        defaultWidth: cfg().detectWidth,
        defaultHeight: cfg().detectHeight,
        maxDetections: num(cfg().maxDetections, DEFAULTS.maxDetections)
    });
    const cameraKey = await resolveCameraKey(norm.camera);

    // 'end' event: the object left the frame -> drop this camera's boxes.
    if (norm.eventType === 'end') {
        if (cameraKey) { store.delete(cameraKey); clearAlarm(cameraKey, source); }
        return { camera: cameraKey, kept: 0, dropped: norm.dropped, cleared: true, alarm: false };
    }

    if (!cameraKey) {
        stats.dropped += norm.dropped;
        fail('AI_BAD_PAYLOAD', 'payload has no camera identifier');
    }

    const kept = [];
    for (const d of norm.detections) {
        if (!passesFilter(d)) { continue; }
        kept.push(Object.assign({}, d, { camera: cameraKey, source: source }));
    }
    stats.dropped += norm.dropped + (norm.detections.length - kept.length);
    stats.detections += kept.length;

    if (kept.length) {
        store.set(cameraKey, { detections: kept, updatedAt: Date.now() });
        raiseAlarm(cameraKey, source);
    }
    // A payload that was valid but matched nothing (filtered label / low score)
    // must NOT clear boxes already on screen: a "dog" event says nothing about
    // the person standing there. Boxes leave through an explicit `end` event or
    // through the TTL, never as a side effect of somebody else's detection.

    return { camera: cameraKey, kept: kept.length, dropped: norm.dropped, cleared: false, alarm: alarms.get(cameraKey) ? !!alarms.get(cameraKey).active : false };
}

/** Read the live boxes for one camera (expired entries are pruned on read). */
function getDetections(cameraKey) {
    const key = cameraKey ? String(cameraKey).trim() : null;
    if (!key) { return { camera: null, detections: [], updatedAt: null, ageMs: null, expired: false }; }
    const rec = store.get(key);
    if (!rec) { return { camera: key, detections: [], updatedAt: null, ageMs: null, expired: false }; }
    const ttl = num(cfg().ttlMs, DEFAULTS.ttlMs);
    const age = Date.now() - rec.updatedAt;
    if (age > ttl) {
        store.delete(key);
        return { camera: key, detections: [], updatedAt: rec.updatedAt, ageMs: age, expired: true };
    }
    return { camera: key, detections: rec.detections, updatedAt: rec.updatedAt, ageMs: age, expired: false };
}

/** All live detections, keyed by camera. */
function getAllDetections() {
    const out = {};
    for (const key of Array.from(store.keys())) {
        const r = getDetections(key);
        if (r.detections.length) { out[key] = r; }
    }
    return out;
}

// -------------------------------------------------------------------- alarm

function raiseAlarm(cameraKey, source) {
    const tagId = cfg().alarmTagId;
    if (!tagId) { return; }
    let a = alarms.get(cameraKey);
    if (!a) { a = { active: false, timer: null }; alarms.set(cameraKey, a); }
    if (a.timer) { clearTimeout(a.timer); a.timer = null; }
    if (!a.active) {
        a.active = true;
        stats.alarms++;
        writeAlarmTag(tagId, 1, source);
    }
    const clearMs = num(cfg().alarmClearMs, DEFAULTS.alarmClearMs);
    a.timer = setTimeout(() => clearAlarm(cameraKey, source), clearMs);
    if (a.timer.unref) { a.timer.unref(); }
}

function clearAlarm(cameraKey, source) {
    const a = alarms.get(cameraKey);
    if (!a) { return; }
    if (a.timer) { clearTimeout(a.timer); }
    alarms.delete(cameraKey);
    const anyActive = Array.from(alarms.values()).some(x => x.active);
    // A single global tag mirrors "some camera has an alarm"; the per-camera
    // state above is what lets the hold/clear logic stay independent.
    if (a.active && !anyActive && cfg().alarmTagId) {
        writeAlarmTag(cfg().alarmTagId, 0, source);
    }
}

async function writeAlarmTag(tagId, value, source) {
    if (!runtime || !runtime.cameraFusion) {
        logger.warn('ai: alarm tag configured but the fusion service is unavailable');
        return false;
    }
    try {
        await runtime.cameraFusion.writeEvent(tagId, value);
        return true;
    } catch (err) {
        if (err && err.code === 'CAM_TAG_DOMAIN_REFUSED') {
            // Configuration mistake, not a failure: an AI event may only target a tag
            // declared as derived/predicted (contract 11 section 3). Say so once, with
            // the fix, instead of logging an opaque write error on every detection.
            logger.warn(`ai: alarm tag '${tagId}' is not a software target (${err.reason}); declare it as dataDomain='derived' to accept AI events`);
            return false;
        }
        logger.warn(`ai: cannot write alarm tag ${tagId} (${source || 'ingest'}): ${err.message}`);
        return false;
    }
}

// ------------------------------------------------------------------ hygiene

function prune() {
    const ttl = num(cfg().ttlMs, DEFAULTS.ttlMs);
    const now = Date.now();
    for (const [key, rec] of store) {
        if (now - rec.updatedAt > ttl) { store.delete(key); }
    }
}

function startPrune() {
    stopPrune();
    const ttl = num(cfg().ttlMs, DEFAULTS.ttlMs);
    const period = Math.max(500, Math.floor(ttl / 2));
    pruneTimer = setInterval(prune, period);
    if (pruneTimer.unref) { pruneTimer.unref(); }
}

function stopPrune() {
    if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

// ---------------------------------------------------------------- lifecycle

async function init(_settings, _log, _runtime, _storage, ingests) {
    settings = _settings;
    if (_log) { logger = _log; }
    runtime = _runtime || null;
    storage = _storage || null;

    store.clear();
    alarms.forEach(a => { if (a.timer) { clearTimeout(a.timer); } });
    alarms.clear();
    // The camera-name lookup depends on both the store and cameraMap, so a
    // (re)start always re-reads it.
    cameraLookup = { at: 0, map: new Map() };
    stats = { ingests: 0, detections: 0, dropped: 0, alarms: 0, lastIngest: null, lastError: null };

    if (!cfg().enabled) {
        logger.info('ai: disabled (settings.ai.enabled = false)');
        return { enabled: false };
    }
    startPrune();

    const out = { enabled: true, mqtt: false, ws: false };
    if (ingests && ingests.start) {
        try {
            const r = await ingests.start(ingest);
            out.mqtt = !!(r && r.mqtt);
            out.ws = (r && r.wsPort) || false;
        } catch (err) {
            stats.lastError = err.message;
            logger.error('ai: ingest startup failed: ' + (err.message || err));
        }
    }
    logger.info(`ai: enabled (minScore ${num(cfg().minScore, DEFAULTS.minScore)}, ttl ${num(cfg().ttlMs, DEFAULTS.ttlMs)}ms)` +
        (out.mqtt ? ', mqtt on' : '') + (out.ws ? `, ws on :${out.ws}` : ''), true);
    return out;
}

async function stop(ingests) {
    stopPrune();
    alarms.forEach(a => { if (a.timer) { clearTimeout(a.timer); } });
    alarms.clear();
    store.clear();
    if (ingests && ingests.stop) { await ingests.stop(); }
    return true;
}

/** Drop every box + alarm for a camera (e.g. the camera was deleted). */
function forgetCamera(cameraKey) {
    if (!cameraKey) { return; }
    store.delete(cameraKey);
    clearAlarm(cameraKey, 'forget');
}

function status() {
    return {
        enabled: !!cfg().enabled,
        minScore: num(cfg().minScore, DEFAULTS.minScore),
        ttlMs: num(cfg().ttlMs, DEFAULTS.ttlMs),
        labels: Array.isArray(cfg().labels) ? cfg().labels : [],
        alarmTagId: cfg().alarmTagId || null,
        cameras: store.size,
        alarms: Array.from(alarms.values()).filter(a => a.active).length,
        stats: Object.assign({}, stats)
    };
}

module.exports = {
    DEFAULTS: DEFAULTS,
    init: init,
    stop: stop,
    ingest: ingest,
    getDetections: getDetections,
    getAllDetections: getAllDetections,
    forgetCamera: forgetCamera,
    resolveCameraKey: resolveCameraKey,
    status: status
};
