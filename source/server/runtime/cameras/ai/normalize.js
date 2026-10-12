/**
 * 'cameras/ai/normalize': turn an AI engine's detection payload into the one
 * shape the platform stores and the browser draws.
 *
 * Detection engines all publish their own flavour of JSON (Frigate over MQTT is
 * the reference here), and they report boxes either in detect-resolution pixels
 * or already normalised. Everything is funnelled into:
 *
 *   { camera, label, score, region:{x,y,w,h}, normalized, timestamp, id, source }
 *
 * `region` is normalised 0..1 with the origin at the top-left, so the browser can
 * place a box with plain percentages and never needs the source resolution.
 * A payload that cannot be normalised is reported as such (`normalized:false`)
 * instead of being silently drawn in the wrong place.
 */

'use strict';

const DEFAULT_MAX_DETECTIONS = 50;

function num(v) {
    if (v === undefined || v === null || v === '') { return null; }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function str(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function clamp01(v) {
    if (!Number.isFinite(v)) { return 0; }
    return Math.max(0, Math.min(1, v));
}

/** [x1,y1,x2,y2] or {x,y,w,h} / {left,top,right,bottom} -> {x,y,w,h} in pixels. */
function boxToRect(box) {
    if (!box) { return null; }
    if (Array.isArray(box) && box.length >= 4) {
        const x1 = num(box[0]), y1 = num(box[1]), x2 = num(box[2]), y2 = num(box[3]);
        if (x1 === null || y1 === null || x2 === null || y2 === null) { return null; }
        return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    if (typeof box === 'object') {
        const x = num(box.x !== undefined ? box.x : box.left);
        const y = num(box.y !== undefined ? box.y : box.top);
        const w = num(box.w !== undefined ? box.w : box.width);
        const h = num(box.h !== undefined ? box.h : box.height);
        if (x === null || y === null) {
            const r = num(box.right), b = num(box.bottom);
            if (r !== null && b !== null) { return { x: Math.min(x || 0, r), y: Math.min(y || 0, b), w: Math.abs(r - (x || 0)), h: Math.abs(b - (y || 0)) }; }
            return null;
        }
        if (w !== null && h !== null) { return { x: x, y: y, w: w, h: h }; }
        const right = num(box.right), bottom = num(box.bottom);
        if (right !== null && bottom !== null) {
            return { x: Math.min(x, right), y: Math.min(y, bottom), w: Math.abs(right - x), h: Math.abs(bottom - y) };
        }
    }
    return null;
}

/** Pixel rect -> normalised region, clamped to the frame. */
function normalizeRect(rect, width, height) {
    if (!rect || !(width > 0) || !(height > 0)) { return null; }
    const x = clamp01(rect.x / width);
    const y = clamp01(rect.y / height);
    const w = clamp01(rect.w / width);
    const h = clamp01(rect.h / height);
    return {
        x: x,
        y: y,
        w: Math.min(w, 1 - x),
        h: Math.min(h, 1 - y)
    };
}

/**
 * Accepts an already-normalised region ({x,y,w,h} all <= 1, or an explicit
 * `normalized:true` flag) and clamps it.
 */
function regionIfNormalized(obj) {
    const r = obj && obj.region ? obj.region : null;
    if (!r) { return null; }
    const x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
    if (x === null || y === null || w === null || h === null) { return null; }
    const looksNormalized = obj.normalized === true ||
        (Math.abs(x) <= 1 && Math.abs(y) <= 1 && Math.abs(w) <= 1 && Math.abs(h) <= 1);
    if (!looksNormalized) { return null; }
    const cx = clamp01(x), cy = clamp01(y);
    return { x: cx, y: cy, w: Math.min(clamp01(w), 1 - cx), h: Math.min(clamp01(h), 1 - cy) };
}

/**
 * One engine object -> a detection, or null when it carries no usable box.
 * @param {object} obj    engine object (Frigate 'after', or a generic detection)
 * @param {object} dims   { width, height } used to normalise pixel boxes
 */
function normalizeOne(obj, dims, ctx) {
    if (!obj || typeof obj !== 'object') { return null; }
    const label = str(obj.label) || str(obj.type) || str(obj.class) || 'object';
    const scoreRaw = num(obj.score) !== null ? num(obj.score)
        : (num(obj.confidence) !== null ? num(obj.confidence) : num(obj.percent));
    let score = scoreRaw;
    if (score !== null && score > 1) { score = score / 100; }        // engines often use 0..100

    let region = regionIfNormalized(obj);
    if (!region) {
        const rect = boxToRect(obj.region && !regionIfNormalized(obj) ? null : obj.box);
        if (rect) { region = normalizeRect(rect, dims.width, dims.height); }
    }

    const ts = num(obj.timestamp) || num(obj.frame_time) || null;
    return {
        id: str(obj.id) || null,
        camera: str(obj.camera) || (ctx && ctx.camera) || null,
        label: label,
        score: score === null ? null : Math.max(0, Math.min(1, score)),
        region: region,
        normalized: !!region,
        timestamp: ts ? (ts > 1e12 ? Math.round(ts) : Math.round(ts * 1000)) : Date.now()
    };
}

/**
 * Normalise any supported payload into a list of detections.
 *
 * Supported inputs:
 *   - Frigate MQTT event: { type:'new'|'update'|'end', after:{...}, before:{...} }
 *   - Frigate camera topic: { camera, label, score, box:[x1,y1,x2,y2] }
 *   - platform envelope:   { camera|cameraId|source, detections:[...] , imageWidth, imageHeight }
 *   - a single detection object
 *
 * @returns {{camera:string|null, detections:Array, dropped:number, eventType:string|null}}
 */
function normalizePayload(payload, opts) {
    const o = opts || {};
    const max = Number(o.maxDetections) > 0 ? Number(o.maxDetections) : DEFAULT_MAX_DETECTIONS;
    const out = { camera: null, detections: [], dropped: 0, eventType: null };
    if (!payload || typeof payload !== 'object') { return out; }

    // An explicit camera name travels with every shape we accept.
    const camera = str(payload.camera) || str(payload.cameraId) || str(payload.source) ||
        (payload.after ? str(payload.after.camera) : null) || null;
    out.camera = camera;

    // Frigate event lifecycle: 'end' means the object is gone, which the store
    // treats as "clear this camera's boxes" rather than as a new detection.
    if (str(payload.type) === 'end') {
        out.eventType = 'end';
        return out;
    }
    if (str(payload.type)) { out.eventType = str(payload.type); }

    // Frame size: explicit payload -> configured default. Frigate reports boxes
    // in detect-resolution pixels, so the configured default is the common case.
    const dims = {
        width: num(payload.imageWidth) || num(payload.width) || num(o.defaultWidth),
        height: num(payload.imageHeight) || num(payload.height) || num(o.defaultHeight)
    };

    const ctx = { camera: camera };
    let candidates = [];
    if (payload.after && typeof payload.after === 'object') {
        candidates = [payload.after];
    } else if (Array.isArray(payload.detections)) {
        candidates = payload.detections;
    } else if (Array.isArray(payload.objects)) {
        candidates = payload.objects;
    } else if (Array.isArray(payload)) {
        candidates = payload;
    } else {
        candidates = [payload];
    }

    for (const c of candidates) {
        const d = normalizeOne(c, dims, Object.assign({}, ctx, { camera: str(c && c.camera) || camera }));
        if (!d) { out.dropped++; continue; }
        if (!d.normalized) { out.dropped++; continue; }   // without a frame size a pixel box cannot be placed
        if (!d.camera) { d.camera = camera; }
        out.detections.push(d);
        if (out.detections.length >= max) { break; }
    }
    return out;
}

module.exports = {
    normalizePayload: normalizePayload,
    normalizeOne: normalizeOne,
    boxToRect: boxToRect,
    normalizeRect: normalizeRect,
    clamp01: clamp01,
    DEFAULT_MAX_DETECTIONS: DEFAULT_MAX_DETECTIONS
};
