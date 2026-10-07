/**
 * 'calibration/calibration-storage': SQLite storage for calibration profiles,
 * sessions, points, samples and write audit. Follows the SCADIA recipe-storage
 * style (sqlite3 + promise wrappers) and adds explicit schema versioning and
 * transaction helpers per design doc section 9.
 */

'use strict';

const path = require('path');
const storage = require('../storage/databases');

var settings;
var logger;
var runtime;
var calDB;

/**
 * The connection is opened by an ASYNC callback (see init below), so there is a window where this
 * module exists, the routes are live and calDB is still undefined. Before this guard that window
 * produced "Cannot read properties of undefined (reading 'all')" from INSIDE a promise executor -
 * a TypeError, not a rejection, so it escaped the caller's .catch and reached the client as a bare
 * 500 ("the software is broken" to an operator) instead of 503 ("come back").
 * api/calibration/index.js already maps CAL_NOT_READY to 503, so the storage layer only has to name
 * the condition. Same shape as runtime/cameras/camera-storage.js (batch 75, where the flakiness of
 * test/cameras/domainBootRace.test.js first exposed it: measured 6 runs, 3 red, always
 * "calibration -> 500" on the very first poll).
 */
function requireConnection() {
    if (!calDB) {
        const err = new Error('calibration storage is not connected yet');
        err.code = 'CAL_NOT_READY';
        throw err;
    }
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS calibration_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calibration_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  approver_id TEXT,
  fit_json TEXT,
  fit_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  approval_expires_at TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(profile_id) REFERENCES calibration_profiles(id)
);

CREATE TABLE IF NOT EXISTS calibration_points (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  reference_value REAL NOT NULL,
  stats_json TEXT,
  samples_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sequence),
  FOREIGN KEY(session_id) REFERENCES calibration_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calibration_write_audit (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  operator_id TEXT NOT NULL,
  approver_id TEXT,
  request_json TEXT NOT NULL,
  before_hex TEXT,
  intended_hex TEXT NOT NULL,
  readback_hex TEXT,
  rollback_hex TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  previous_hash TEXT,
  record_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(session_id) REFERENCES calibration_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_calibration_sessions_profile
  ON calibration_sessions(profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_calibration_write_audit_session
  ON calibration_write_audit(session_id, created_at);
`;

// ------------------------------------------------------------------ helpers

function run(sql, params) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        calDB.run(sql, params || [], function (err) {
            if (err) { reject(err); } else { resolve({ changes: this.changes, lastID: this.lastID }); }
        });
    });
}

function get(sql, params) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        calDB.get(sql, params || [], (err, row) => {
            if (err) { reject(err); } else { resolve(row); }
        });
    });
}

function all(sql, params) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        calDB.all(sql, params || [], (err, rows) => {
            if (err) { reject(err); } else { resolve(rows || []); }
        });
    });
}

/**
 * Serialized write transaction. The callback receives no handles and must
 * only use the exported helpers; sqlite3 executes its own queue, but we guard
 * with BEGIN IMMEDIATE/COMMIT to keep multi-statement consistency.
 */
function tx(fn) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        calDB.serialize(() => {
            calDB.run('BEGIN IMMEDIATE', (err) => {
                if (err) { reject(err); return; }
            });
            Promise.resolve()
                .then(fn)
                .then(async (result) => {
                    await run('COMMIT');
                    resolve(result);
                })
                .catch(async (err) => {
                    try { await run('ROLLBACK'); } catch (e) { /* ignore */ }
                    reject(err);
                });
        });
    });
}

function nowIso() {
    return new Date().toISOString();
}

// ------------------------------------------------------------------- schema

function _createDB() {
    return new Promise((resolve, reject) => {
        const dbPath = storage.resolveDbFile(settings.workDir, 'calibration', logger);
        calDB = storage.open(dbPath, (err) => {
            if (err) {
                logger.error('calibration-storage DB connection error: ' + err);
                reject(err);
                return;
            }
            calDB.serialize(() => {
                calDB.run('PRAGMA foreign_keys = ON');
                calDB.run('PRAGMA journal_mode = WAL');
                calDB.run(`CREATE TABLE IF NOT EXISTS calibration_schema_version (
                    version INTEGER PRIMARY KEY,
                    applied_at TEXT NOT NULL
                )`, (err) => {
                    if (err) { reject(err); return; }
                    calDB.get('SELECT MAX(version) as v FROM calibration_schema_version', async (err, row) => {
                        if (err) { reject(err); return; }
                        const current = row && row.v ? row.v : 0;
                        try {
                            if (current < 1) {
                                await _applyMigrations(current);
                                await run('INSERT OR REPLACE INTO calibration_schema_version (version, applied_at) VALUES (?, ?)', [SCHEMA_VERSION, nowIso()]);
                            }
                            resolve();
                        } catch (e) {
                            logger.error('calibration-storage migration error: ' + e);
                            reject(e);
                        }
                    });
                });
            });
        });
    });
}

async function _applyMigrations(fromVersion) {
    // fromVersion is always 0 for now: create the full initial schema.
    const statements = SCHEMA_SQL.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
        await run(stmt);
    }
}

// ------------------------------------------------------------------ profiles

function saveProfile(profile) {
    // profile: { id, name, description, data?, version } - `data` holds the full
    // config; when absent (service passes a normalized profile) the object itself
    // is persisted as the payload.
    const payload = profile.data !== undefined ? profile.data : profile;
    const ts = nowIso();
    return tx(async () => {
        const existing = await get('SELECT version FROM calibration_profiles WHERE id = ?', [profile.id]);
        if (existing) {
            if (profile.expectedVersion !== undefined && profile.expectedVersion !== null && existing.version !== profile.expectedVersion) {
                const err = new Error('CAL_REVISION_CONFLICT');
                err.code = 'CAL_REVISION_CONFLICT';
                throw err;
            }
            const newVersion = existing.version + 1;
            await run(`UPDATE calibration_profiles SET name = ?, description = ?, data = ?, version = ?, updated_at = ? WHERE id = ?`,
                [profile.name, profile.description || '', JSON.stringify(payload), newVersion, ts, profile.id]);
            return { id: profile.id, version: newVersion };
        }
        await run(`INSERT INTO calibration_profiles (id, name, description, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
            [profile.id, profile.name, profile.description || '', JSON.stringify(payload), ts, ts]);
        return { id: profile.id, version: 1 };
    });
}

function getProfile(id) {
    return get('SELECT * FROM calibration_profiles WHERE id = ?', [id]).then(row => row ? _mapProfile(row) : null);
}

function getProfiles() {
    return all('SELECT * FROM calibration_profiles ORDER BY updated_at DESC').then(rows => rows.map(_mapProfile));
}

function _mapProfile(row) {
    const payload = JSON.parse(row.data);
    // Flatten the stored payload to the top level so consumers can use
    // profile.sampling / profile.write / profile.sourceTagId directly.
    return Object.assign({}, payload, {
        id: row.id,
        name: payload.name !== undefined ? payload.name : row.name,
        description: payload.description !== undefined ? payload.description : row.description,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        data: payload
    });
}

function deleteProfile(id) {
    return run('DELETE FROM calibration_profiles WHERE id = ?', [id]);
}

function countActiveSessions(profileId) {
    return get(`SELECT COUNT(*) as c FROM calibration_sessions WHERE profile_id = ? AND status NOT IN ('applied','failed','uncertain','canceled')`, [profileId])
        .then(row => row ? row.c : 0);
}

// ------------------------------------------------------------------ sessions

function _mapSession(row) {
    return {
        id: row.id,
        profileId: row.profile_id,
        profileVersion: row.profile_version,
        status: row.status,
        operatorId: row.operator_id,
        approverId: row.approver_id,
        fit: row.fit_json ? JSON.parse(row.fit_json) : null,
        fitHash: row.fit_hash,
        revision: row.revision,
        approvalExpiresAt: row.approval_expires_at,
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at
    };
}

function createSession(session) {
    const ts = nowIso();
    return run(`INSERT INTO calibration_sessions
        (id, profile_id, profile_version, status, operator_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [session.id, session.profileId, session.profileVersion, session.status, session.operatorId, ts, ts])
        .then(() => getSession(session.id));
}

function getSession(id) {
    return get('SELECT * FROM calibration_sessions WHERE id = ?', [id]).then(row => row ? _mapSession(row) : null);
}

function getSessions(filter) {
    filter = filter || {};
    const where = [];
    const params = [];
    if (filter.profileId) { where.push('profile_id = ?'); params.push(filter.profileId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    let sql = 'SELECT * FROM calibration_sessions';
    if (where.length) { sql += ' WHERE ' + where.join(' AND '); }
    sql += ' ORDER BY created_at DESC';
    if (filter.limit) { sql += ' LIMIT ' + parseInt(filter.limit); }
    if (filter.offset) { sql += ' OFFSET ' + parseInt(filter.offset); }
    return all(sql, params).then(rows => rows.map(_mapSession));
}

/**
 * Update session with optimistic revision check inside a transaction.
 * patch fields: status, approverId, fit, fitHash, approvalExpiresAt, idempotencyKey, completedAt
 * bumpRevision: increment revision
 */
function updateSession(id, expectedRevision, patch, bumpRevision) {
    return tx(async () => {
        const row = await get('SELECT * FROM calibration_sessions WHERE id = ?', [id]);
        if (!row) {
            const err = new Error('CAL_SESSION_NOT_FOUND');
            err.code = 'CAL_SESSION_NOT_FOUND';
            throw err;
        }
        if (expectedRevision !== undefined && expectedRevision !== null && row.revision !== expectedRevision) {
            const err = new Error('CAL_REVISION_CONFLICT');
            err.code = 'CAL_REVISION_CONFLICT';
            err.currentRevision = row.revision;
            throw err;
        }
        const sets = [];
        const params = [];
        if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
        if (patch.approverId !== undefined) { sets.push('approver_id = ?'); params.push(patch.approverId); }
        if (patch.fit !== undefined) { sets.push('fit_json = ?'); params.push(JSON.stringify(patch.fit)); }
        if (patch.fitHash !== undefined) { sets.push('fit_hash = ?'); params.push(patch.fitHash); }
        if (patch.approvalExpiresAt !== undefined) { sets.push('approval_expires_at = ?'); params.push(patch.approvalExpiresAt); }
        if (patch.idempotencyKey !== undefined) { sets.push('idempotency_key = ?'); params.push(patch.idempotencyKey); }
        if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(patch.completedAt); }
        if (bumpRevision) { sets.push('revision = revision + 1'); }
        if (!sets.length) { return row.revision; }
        sets.push('updated_at = ?');
        params.push(nowIso());
        params.push(id);
        await run('UPDATE calibration_sessions SET ' + sets.join(', ') + ' WHERE id = ?', params);
        const updated = await get('SELECT revision FROM calibration_sessions WHERE id = ?', [id]);
        return updated.revision;
    });
}

function countSessionsWithStatus(statuses) {
    return get(`SELECT COUNT(*) as c FROM calibration_sessions WHERE status IN (${statuses.map(() => '?').join(',')})`, statuses)
        .then(row => row ? row.c : 0);
}

// ------------------------------------------------------------------- points

function _mapPoint(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        referenceValue: row.reference_value,
        stats: row.stats_json ? JSON.parse(row.stats_json) : null,
        samples: row.samples_json ? JSON.parse(row.samples_json) : [],
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function createPoint(point) {
    const ts = nowIso();
    return run(`INSERT INTO calibration_points (id, session_id, sequence, reference_value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [point.id, point.sessionId, point.sequence, point.referenceValue, ts, ts])
        .then(() => getPoint(point.id));
}

function getPoint(id) {
    return get('SELECT * FROM calibration_points WHERE id = ?', [id]).then(row => row ? _mapPoint(row) : null);
}

function getPoints(sessionId) {
    return all('SELECT * FROM calibration_points WHERE session_id = ? ORDER BY sequence', [sessionId])
        .then(rows => rows.map(_mapPoint));
}

function deletePoint(id) {
    return run('DELETE FROM calibration_points WHERE id = ?', [id]);
}

function updatePointResult(id, stats, samples, stable, stableViolations) {
    // stable flag is persisted inside the stats JSON to avoid schema churn
    const merged = Object.assign({}, stats || {}, {
        stable: stable !== false,
        stableViolations: stableViolations || []
    });
    return run('UPDATE calibration_points SET stats_json = ?, samples_json = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(merged), JSON.stringify(samples || []), nowIso(), id]);
}

// -------------------------------------------------------------------- audit

function createAuditRecord(rec) {
    return run(`INSERT INTO calibration_write_audit
        (id, session_id, idempotency_key, operator_id, approver_id, request_json,
         before_hex, intended_hex, readback_hex, rollback_hex, status, error_code, error_message,
         previous_hash, record_hash, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [rec.id, rec.sessionId, rec.idempotencyKey, rec.operatorId, rec.approverId || null,
         JSON.stringify(rec.request || {}), rec.beforeHex || null, rec.intendedHex || '',
         rec.readbackHex || null, rec.rollbackHex || null, rec.status, rec.errorCode || null,
         rec.errorMessage || null, rec.previousHash || null, rec.recordHash, rec.createdAt || nowIso(), rec.completedAt || null]);
}

function updateAuditRecord(id, patch) {
    const sets = [];
    const params = [];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.readbackHex !== undefined) { sets.push('readback_hex = ?'); params.push(patch.readbackHex); }
    if (patch.rollbackHex !== undefined) { sets.push('rollback_hex = ?'); params.push(patch.rollbackHex); }
    if (patch.errorCode !== undefined) { sets.push('error_code = ?'); params.push(patch.errorCode); }
    if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); params.push(patch.errorMessage); }
    if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(patch.completedAt); }
    if (patch.recordHash !== undefined) { sets.push('record_hash = ?'); params.push(patch.recordHash); }
    if (!sets.length) { return Promise.resolve(); }
    params.push(id);
    return run('UPDATE calibration_write_audit SET ' + sets.join(', ') + ' WHERE id = ?', params);
}

function getAuditRecord(id) {
    return get('SELECT * FROM calibration_write_audit WHERE id = ?', [id]).then(row => row ? _mapAudit(row) : null);
}

function getAuditByIdempotencyKey(idempotencyKey) {
    return get('SELECT * FROM calibration_write_audit WHERE idempotency_key = ?', [idempotencyKey]).then(row => row ? _mapAudit(row) : null);
}

function getAuditRecords(sessionId) {
    return all('SELECT * FROM calibration_write_audit WHERE session_id = ? ORDER BY created_at', [sessionId])
        .then(rows => rows.map(_mapAudit));
}

function getLastAuditHash() {
    return get('SELECT record_hash FROM calibration_write_audit ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .then(row => row ? row.record_hash : null);
}

function _mapAudit(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        idempotencyKey: row.idempotency_key,
        operatorId: row.operator_id,
        approverId: row.approver_id,
        request: JSON.parse(row.request_json || '{}'),
        beforeHex: row.before_hex,
        intendedHex: row.intended_hex,
        readbackHex: row.readback_hex,
        rollbackHex: row.rollback_hex,
        status: row.status,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        previousHash: row.previous_hash,
        recordHash: row.record_hash,
        createdAt: row.created_at,
        completedAt: row.completed_at
    };
}

// --------------------------------------------------------------- init/close

function init(_settings, _log, _runtime) {
    settings = _settings;
    logger = _log;
    runtime = _runtime;
    return _createDB();
}

function close() {
    return new Promise((resolve) => {
        if (calDB) {
            calDB.close(() => {
                calDB = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    init: init,
    close: close,
    tx: tx,
    run: run,
    get: get,
    all: all,

    saveProfile: saveProfile,
    getProfile: getProfile,
    getProfiles: getProfiles,
    deleteProfile: deleteProfile,
    countActiveSessions: countActiveSessions,

    createSession: createSession,
    getSession: getSession,
    getSessions: getSessions,
    updateSession: updateSession,
    countSessionsWithStatus: countSessionsWithStatus,

    createPoint: createPoint,
    getPoint: getPoint,
    getPoints: getPoints,
    deletePoint: deletePoint,
    updatePointResult: updatePointResult,

    createAuditRecord: createAuditRecord,
    updateAuditRecord: updateAuditRecord,
    getAuditRecord: getAuditRecord,
    getAuditByIdempotencyKey: getAuditByIdempotencyKey,
    getAuditRecords: getAuditRecords,
    getLastAuditHash: getLastAuditHash,

    SCHEMA_VERSION: SCHEMA_VERSION
};
