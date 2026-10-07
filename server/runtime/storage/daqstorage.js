/**
 *  Module to manage the DAQ datastore with daqnode
 */

'use strict';

const fs = require('fs');
const path = require('path');
const registry = require("./registry");
const CurrentStorage = require("./sqlite/currentstorage");
var calculator = require('./calculator');
var utils = require('../utils');

var settings;
var logger;
var daqDB = {};                 // node id -> adapter instance; per-device backends keep one per device
var currentStorateDB;
var runtime;
var daqSelection = null;        // set by init(): the single normalised answer to "which backend"

function init(_settings, _log, _runtime) {
    settings = _settings;
    logger = _log;
    runtime = _runtime;
    // Validate and normalise the configured backend ONCE, at boot. An unknown value is
    // refused here rather than silently becoming SQLite further down (ledger A-03).
    daqSelection = registry.normalise(settings, logger);
    logger.info("daqstorage: init successful! backend=" + daqSelection.backendId, true);
    currentStorateDB = CurrentStorage.create(_settings, _log);
}

function reset() {
    for (var id in daqDB) {
        daqDB[id].close();
    }
    daqDB = {};
    logger.info("daqstorage reset!", true);
}

function addDaqNode(_id, fncgetprop) {
    if (!daqSelection) { daqSelection = registry.normalise(settings, logger); }
    const backend = daqSelection.backend;
    // Per-device backends keep one store per device; the others keep exactly one.
    const nodeId = backend.perDeviceNode ? _id : backend.id;
    if (!daqDB[nodeId]) {
        daqDB[nodeId] = registry.create(backend.id, settings, logger, currentStorateDB, { nodeId: _id });
    }
    return daqDB[nodeId].setCall(fncgetprop);
}

function getNodeValues(tagid, fromts, tots) {
    return new Promise(function (resolve, reject) {
        var daqnode = _getDaqNode(tagid);
        if (daqnode) {
            resolve(daqnode.getDaqValue(tagid, fromts, tots));
        } else {
            resolve([]);
        }
    });
}

/**
 * Return tags values,
 * if with options then return function array [{DD/MM/YYYY mm:HH, ...values}]
 * else for chart object {tagId} [{Date, value}]
 * @param {*} tagsid
 * @param {*} fromts
 * @param {*} tots
 * @param {*} options
 * @returns
 */
function getNodesValues(tagsid, fromts, tots, options) {
    return new Promise(async function (resolve, reject) {
        try {
            var dbfncs = [];
            for (let i = 0; i < tagsid.length; i++) {
                dbfncs.push(await getNodeValues(tagsid[i], fromts, tots));
            }
            Promise.all(dbfncs).then(values => {
                if (!values || values.length < 1) {    // (0)[]
                    resolve(['', ...tagsid.map(col => '')]);
                } else if (options) {
                    let calcValues = [];
                    for (let idx = 0 ; idx < values.length; idx++) {
                        if (options.functions[idx]) {
                            calcValues.push(calculator.getFunctionValues(values[idx], fromts, tots, options.functions[idx], options.interval, options.formats[idx]));
                        } else {
                            calcValues.push(calculator.getFunctionValues(values[idx], fromts, tots));
                        }
                    }
                    let keys = Object.keys(calcValues[0]).map(ts => Number(ts));
                    let mergeValues = Object.keys(calcValues[0]).map(ts => [utils.getFormatDate(new Date(Number(ts))), _getValue(calcValues[0][ts])]);
                    for (let x = 1; x < calcValues.length; x++) {
                        let y = 0;
                        keys.forEach(k => {
                            mergeValues[y++].push(_getValue(calcValues[x][k]));
                        });
                    }
                    resolve(mergeValues);
                } else {
                    var result = {};
                    for (let i = 0; i < tagsid.length; i++) {
                        result[tagsid[i]] = values[i].map(v => { return { x: new Date(v.dt), y: v.value} });
                        result[tagsid[i]].push({ x: new Date(tots), y: null});
                        result[tagsid[i]].unshift({ x: new Date(fromts), y: null});
                    }
                    resolve(result);
                }
            }, reason => {
                reject(reason);
            });
        } catch (err) {
            // Was: reject(['ERR', ...]) - the cause was dropped, nothing was logged, and no
            // consumer anywhere understood that sentinel (ledger A-08). A failure must travel
            // as a failure; the .catch() in report.js still renders its ERROR cells.
            logger.error('daqstorage.getNodesValues failed: ' + (err && err.stack ? err.stack : err));
            reject(err);
        }
    });
}


// --------------------------------------------------------------- query contract

/**
 * Per-tag query outcome. A caller MUST be able to tell these apart: the old API
 * answered an empty array for every one of them, so "the value never moved" and
 * "the device was offline" looked identical (contract 10 section 3.4).
 */
const QUERY_STATUS = {
    OK: 'ok',
    UNKNOWN_TAG: 'unknown-tag',
    DAQ_DISABLED: 'daq-disabled',
    NO_DATA: 'no-data',
    BACKEND_ERROR: 'backend-error',
    RANGE_TOO_LARGE: 'range-too-large',
    TOO_MANY_POINTS: 'too-many-points',
    TOO_MANY_TAGS: 'too-many-tags',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled'
};

/** Contract defaults. Overridable per call through options.limits. */
const QUERY_DEFAULTS = {
    maxRangeMs: 366 * 24 * 60 * 60 * 1000,   // one year
    maxPointsPerTag: 200000,
    maxTags: 200,
    timeoutMs: 30000
};

/**
 * Resolve a tag archive identity without touching a backend.
 * `returns {{status:string, deviceId:string|null, daqEnabled:boolean}}
 */
function describeTag(tagId) {
    if (!runtime || !runtime.devices || typeof runtime.devices.resolveTag !== 'function') {
        return { status: QUERY_STATUS.OK, deviceId: null, daqEnabled: true };
    }
    const resolved = runtime.devices.resolveTag(tagId);
    if (!resolved) {
        return { status: QUERY_STATUS.UNKNOWN_TAG, deviceId: null, daqEnabled: false };
    }
    if (resolved.ambiguous) {
        // Ambiguous ownership: the series cannot be attributed with confidence.
        return { status: QUERY_STATUS.UNKNOWN_TAG, deviceId: resolved.deviceId, daqEnabled: false, ambiguous: true };
    }
    let daqEnabled = true;
    try {
        const devices = runtime.project ? runtime.project.getDevices() : null;
        const dev = devices && devices[resolved.deviceId];
        const tag = dev && dev.tags ? dev.tags[tagId] : null;
        if (tag && (!tag.daq || tag.daq.enabled !== true)) { daqEnabled = false; }
    } catch (err) { /* keep the optimistic default; the backend call will speak up */ }
    return {
        status: daqEnabled ? QUERY_STATUS.OK : QUERY_STATUS.DAQ_DISABLED,
        deviceId: resolved.deviceId,
        daqEnabled: daqEnabled
    };
}

/**
 * Query archived series with explicit semantics (contract 10).
 *
 * ADDITIVE BY DESIGN: getNodesValues() keeps its historical shape for the report,
 * Node-RED and script consumers. This entry point is what new code (AI analysis, the
 * REST layer) should use, because it reports what it could NOT answer.
 *
 * Semantics:
 *   - the interval is [from, to);
 *   - no interpolation: a gap stays a gap and is reported in gaps;
 *   - quality is "unknown" until backends carry a real quality code;
 *   - exceeding a limit is an explicit error status, never a silent truncation.
 *
 * `param {string[]} tagIds
 * `param {number} fromTs epoch ms, inclusive
 * `param {number} toTs   epoch ms, exclusive
 * `param {object} [options] { limits, signal }
 * `returns {Promise<object>} query result envelope
 */
async function querySeries(tagIds, fromTs, toTs, options) {
    const opts = options || {};
    const limits = Object.assign({}, QUERY_DEFAULTS, opts.limits || {});
    const tags = Array.isArray(tagIds) ? tagIds.slice() : [];
    const startedAt = Date.now();

    const envelope = {
        contractVersion: 1,
        requested: { tags: tags, fromTs: fromTs, toTs: toTs, interval: "[from,to)" },
        effective: { fromTs: fromTs, toTs: toTs, aggregated: false },
        series: {},
        status: {},
        gaps: {},
        resolution: {},
        limits: limits,
        elapsedMs: 0
    };

    const fail = (status) => {
        tags.forEach(t => {
            envelope.series[t] = [];
            envelope.status[t] = status;
            envelope.gaps[t] = [];
            envelope.resolution[t] = null;
        });
        envelope.elapsedMs = Date.now() - startedAt;
        return envelope;
    };

    if (!tags.length) { envelope.elapsedMs = Date.now() - startedAt; return envelope; }
    if (tags.length > limits.maxTags) { return fail(QUERY_STATUS.TOO_MANY_TAGS); }
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) { return fail(QUERY_STATUS.BACKEND_ERROR); }
    if (toTs < fromTs) { return fail(QUERY_STATUS.BACKEND_ERROR); }
    if (toTs - fromTs > limits.maxRangeMs) { return fail(QUERY_STATUS.RANGE_TOO_LARGE); }

    for (const tagId of tags) {
        const described = describeTag(tagId);
        envelope.series[tagId] = [];
        envelope.status[tagId] = described.status;
        envelope.gaps[tagId] = [];
        envelope.resolution[tagId] = null;
    }

    const queryable = tags.filter(t => envelope.status[t] === QUERY_STATUS.OK);

    for (const tagId of queryable) {
        if (opts.signal && opts.signal.cancelled) { envelope.status[tagId] = QUERY_STATUS.CANCELLED; continue; }
        let rows = null;
        try {
            rows = await Promise.race([
                getNodeValues(tagId, fromTs, toTs),
                new Promise((_res, rej) => setTimeout(() => rej(new Error("QUERY_TIMEOUT")), limits.timeoutMs))
            ]);
        } catch (err) {
            envelope.status[tagId] = (err && err.message === "QUERY_TIMEOUT") ? QUERY_STATUS.TIMEOUT : QUERY_STATUS.BACKEND_ERROR;
            continue;
        }
        if (!Array.isArray(rows) || !rows.length) {
            envelope.status[tagId] = QUERY_STATUS.NO_DATA;
            continue;
        }

        const points = [];
        let skippedOutOfRange = 0;
        for (const row of rows) {
            const t = Number(row.dt);
            if (!Number.isFinite(t)) { continue; }
            if (t < fromTs || t >= toTs) { skippedOutOfRange++; continue; }   // [from, to)
            points.push({ t: t, v: row.value, quality: "unknown" });
        }
        if (points.length > limits.maxPointsPerTag) { envelope.status[tagId] = QUERY_STATUS.TOO_MANY_POINTS; continue; }

        points.sort((a, b) => a.t - b.t);

        // Report uncovered spans instead of interpolating across them. The threshold is
        // derived from the series own median cadence, so a slow tag is not all gap.
        const strides = [];
        for (let i = 1; i < points.length; i++) { strides.push(points[i].t - points[i - 1].t); }
        const sortedStrides = strides.slice().sort((a, b) => a - b);
        const median = sortedStrides.length ? sortedStrides[Math.floor(sortedStrides.length / 2)] : 0;
        const gapThreshold = median > 0 ? median * 3 : 0;
        if (gapThreshold > 0) {
            for (let i = 1; i < points.length; i++) {
                if (points[i].t - points[i - 1].t > gapThreshold) {
                    envelope.gaps[tagId].push({ from: points[i - 1].t, to: points[i].t, reason: "no-data" });
                }
            }
        }

        envelope.series[tagId] = points;
        envelope.status[tagId] = QUERY_STATUS.OK;
        envelope.resolution[tagId] = {
            medianStrideMs: median,
            points: points.length,
            skippedOutOfRange: skippedOutOfRange
        };
    }

    envelope.elapsedMs = Date.now() - startedAt;
    return envelope;
}

/** True when every requested tag answered OK. */
function isQueryComplete(envelope) {
    if (!envelope || !envelope.status) { return false; }
    return Object.keys(envelope.status).every(t => envelope.status[t] === QUERY_STATUS.OK);
}
function checkRetention() {
    return new Promise(async function (resolve, reject) {
        // The facade no longer knows which backend rolls what: it asks the registry, which is
        // the only module that names an adapter (F-2: retention belongs to the interface).
        if (settings.daqstore && daqSelection && settings.daqstore.retention !== 'none') {
            try {
                registry.rollRetention(daqSelection.backendId, settings,
                    utils.getRetentionLimit(settings.daqstore.retention),
                (fileDeleted) => {
                    logger.info(`daqstorage.checkRetention file ${fileDeleted} removed`);
                },
                (err) => {
                    logger.error(`daqstorage.checkRetention remove file failed! ${err}`);
                });
            } catch (err) {
                logger.error(err);
            }
        }
        logger.info(`daqstorage.checkRetention processed`);
        resolve();
    });
}

function getCurrentStorageFnc() {
    return currentStorateDB.getValuesByDeviceId;
}

function _getDaqNode(tagid) {
    var nodes = Object.values(daqDB);
    for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getDaqMap(tagid)[tagid]) {
            return nodes[i];
        }
    }
}

// _getDbType(), _getQuestDbModule() and the local DaqStoreTypeEnum all lived here. They
// were three ways of answering "which backend": a string comparison, a try/catch that fell
// back to SQLite when a package was missing, and a private copy of the vocabulary that the
// client disagreed with. All three now come from ./registry.js, which is also the single
// place the D4 contract is consumed.

function _getValue(value) {
    if (value == Number.MAX_VALUE || value === utils.SMALLEST_NEGATIVE_INTEGER || value == null) {
        return '';
    }
    return value.toString();
}

module.exports = {
    init: init,
    reset: reset,
    addDaqNode: addDaqNode,
    getNodeValues: getNodeValues,
    getNodesValues: getNodesValues,
    checkRetention: checkRetention,
    getCurrentStorageFnc: getCurrentStorageFnc,
    querySeries: querySeries,
    describeTag: describeTag,
    isQueryComplete: isQueryComplete,
    QUERY_STATUS: QUERY_STATUS,
    QUERY_DEFAULTS: QUERY_DEFAULTS,
};
