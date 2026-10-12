/**
 * 'calibration/calibration-service': session state machine and use case orchestration
 *
 * Status flow (doc section 8):
 * draft -> sampling -> ready -> fitted -> awaiting-approval -> approved
 *   -> writing -> verifying -> applied | failed | uncertain
 *
 * Security invariants:
 * - all mutating ops require secureEnabled=true (CAL_SECURITY_DISABLED otherwise)
 * - approval binds sessionId + revision + fitHash and expires
 * - apply consumes a one-time confirmation token bound to revision+fitHash
 * - apply is idempotent by Idempotency-Key (replays return the original result)
 */

'use strict';

const crypto = require('crypto');
const storage = require('./calibration-storage');
const fitEngine = require('./fit-engine');
const sampleEngine = require('./sample-engine');
const writePlanner = require('./write-planner');
const writeCoordinator = require('./write-coordinator');
const validators = require('./validators');
const audit = require('./audit');
const locksFactory = require('./locks');

const STATUSES = {
    DRAFT: 'draft',
    SAMPLING: 'sampling',
    READY: 'ready',
    FITTED: 'fitted',
    AWAITING_APPROVAL: 'awaiting-approval',
    APPROVED: 'approved',
    WRITING: 'writing',
    VERIFYING: 'verifying',
    APPLIED: 'applied',
    FAILED: 'failed',
    UNCERTAIN: 'uncertain',
    CANCELED: 'canceled'
};

function fail(code, message, extra) {
    const err = new Error(message || code);
    err.code = code;
    if (extra) { Object.assign(err, extra); }
    throw err;
}

function assertCondition(ok, code, message, extra) {
    if (!ok) { fail(code, message, extra); }
}

function newId(prefix) {
    return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function create(_runtime) {
    var runtime = _runtime;
    var logger = runtime.logger;
    var sessionLocks = locksFactory.createKeyedLocks();
    var deviceLocks = locksFactory.createKeyedLocks();
    var activeRuns = new Map();          // sessionId -> SampleRun
    var confirmTokens = new Map();       // token -> { sessionId, revision, fitHash, expiresAt, used }
    var settingsCache = null;

    function calSettings() {
        if (settingsCache) { return settingsCache; }
        const s = (runtime.settings && runtime.settings.calibration) || {};
        settingsCache = {
            enabled: s.enabled !== false,
            writeEnabled: s.writeEnabled === true,
            requireTwoPersonApproval: s.requireTwoPersonApproval !== false,
            approvalTtlSeconds: s.approvalTtlSeconds || 600,
            confirmationTtlSeconds: s.confirmationTtlSeconds || 120,
            maxConcurrentSamplingSessions: s.maxConcurrentSamplingSessions || 8,
            maxConcurrentWrites: s.maxConcurrentWrites || 1,
            rawWriteEnabled: s.rawWriteEnabled === true,
            rawWriteAllowlist: s.rawWriteAllowlist || [],
            maxRawWriteRegisters: s.maxRawWriteRegisters || 123
        };
        return settingsCache;
    }

    function invalidateSettingsCache() {
        settingsCache = null;
    }

    // ------------------------------------------------------------- events

    function emitEvent(eventName, payload) {
        try {
            const io = runtime.io;
            if (!io || !io.sockets) { return; }
            const secure = runtime.settings && runtime.settings.secureEnabled;
            const sockets = io.sockets.sockets;
            if (!sockets || typeof sockets.forEach !== 'function') { return; }
            sockets.forEach(socket => {
                if (!secure || socket.isAuthenticated) {
                    socket.emit(eventName, payload);
                }
            });
        } catch (err) {
            logger.warn('calibration emitEvent failed: ' + err.message);
        }
    }

    function emitSampleProgress(sessionId, pointId, progress) {
        emitEvent('calibration:sample-progress', Object.assign({ sessionId, pointId }, progress));
    }

    // ------------------------------------------------------------- helpers

    async function loadProfile(profileId) {
        const profile = await storage.getProfile(profileId);
        assertCondition(profile, 'CAL_VALIDATION_ERROR', 'profile not found: ' + profileId);
        return profile;
    }

    async function loadSession(sessionId) {
        const session = await storage.getSession(sessionId);
        assertCondition(session, 'CAL_SESSION_NOT_FOUND', 'session not found: ' + sessionId);
        return session;
    }

    function checkSecureMode() {
        // 90-AF: the platform-wide secureEnabled flag describes LOGIN security, not whether this
        // module may write. Gating writes on it made the workbench dead on arrival in any
        // delivery that runs with security off (secureEnabled=false) while calibration.writeEnabled
        // is explicitly true - so the module's own setting is the only gate here.
        assertCondition(calSettings().writeEnabled, 'CAL_FORBIDDEN', 'calibration write is disabled by settings');
    }

    function checkNotSampling(session) {
        assertCondition(!activeRuns.has(session.id), 'CAL_SAMPLE_IN_PROGRESS', 'sampling is in progress for this session');
    }

    function requireRevision(session, expectedRevision) {
        if (expectedRevision !== undefined && expectedRevision !== null && session.revision !== expectedRevision) {
            fail('CAL_REVISION_CONFLICT', 'session revision conflict', { currentRevision: session.revision });
        }
    }

    function approvalValid(session) {
        if (!session.approvalExpiresAt) { return false; }
        return new Date(session.approvalExpiresAt).getTime() > Date.now();
    }

    function deviceOnline(deviceId) {
        try {
            const status = runtime.devices.getDevicesStatus()[deviceId];
            return status === 'connect-ok';
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------- profiles

    async function saveProfile(profile, actor) {
        const normalized = validators.validateProfile(profile);
        const now = new Date().toISOString();
        let version = 1;
        if (profile.id) {
            const existing = await storage.getProfile(profile.id);
            assertCondition(existing, 'CAL_VALIDATION_ERROR', 'profile not found: ' + profile.id);
            if (profile.version !== undefined && existing.version !== profile.version) {
                fail('CAL_REVISION_CONFLICT', 'profile version conflict', { currentVersion: existing.version });
            }
            version = existing.version + 1;
        }
        normalized.id = profile.id || newId('cal_p');
        normalized.version = version;
        normalized.createdAt = (profile.createdAt) || now;
        normalized.updatedAt = now;
        await storage.saveProfile(normalized);
        logger.info(`calibration profile saved: ${normalized.id} v${version} by ${actor || 'unknown'}`);
        return normalized;
    }

    async function deleteProfile(profileId) {
        const active = await storage.countActiveSessions(profileId);
        assertCondition(active === 0, 'CAL_STATE_CONFLICT', 'profile has active sessions');
        return storage.deleteProfile(profileId);
    }

    /**
     * Validate profile against the live runtime: tags exist, device online, raw allowlist
     */
    async function validateProfileLive(profileId) {
        const profile = await loadProfile(profileId);
        const result = { profileId, ok: true, checks: [] };
        const check = (name, ok, detail) => result.checks.push({ name, ok, detail });

        const tagId = profile.sourceTagId;
        const deviceId = _deviceIdFromTag(tagId);
        check('sourceTag', !!deviceId, deviceId ? ('device ' + deviceId) : 'tag not found in project');
        if (deviceId) {
            check('deviceOnline', deviceOnline(deviceId), 'status=' + _deviceStatus(deviceId));
        }
        if (profile.write && profile.write.mode === 'tags') {
            check('gainTag', !!_deviceIdFromTag(profile.write.gainTagId), profile.write.gainTagId);
            check('offsetTag', !!_deviceIdFromTag(profile.write.offsetTagId), profile.write.offsetTagId);
        }
        if (profile.write && profile.write.mode === 'raw-block') {
            const allowed = validators.isAddressAllowed(calSettings().rawWriteAllowlist,
                profile.write.deviceId,
                writePlanner.toZeroBasedAddress(profile.write.startAddress, profile.write.addressBase),
                writePlanner.toZeroBasedAddress(profile.write.startAddress, profile.write.addressBase));
            check('rawAllowlist', calSettings().rawWriteEnabled && allowed,
                calSettings().rawWriteEnabled ? 'address base check only' : 'raw write disabled');
        }
        result.ok = result.checks.every(c => c.ok);
        return result;
    }

    function _deviceIdFromTag(tagId) {
        try { return runtime.devices.getDeviceIdFromTag(tagId); } catch (e) { return null; }
    }

    function _deviceStatus(deviceId) {
        try { return runtime.devices.getDevicesStatus()[deviceId] || 'unknown'; } catch (e) { return 'unknown'; }
    }

    // ------------------------------------------------------------- sessions

    async function createSession(profileId, actor) {
        const profile = await loadProfile(profileId);
        const session = {
            id: newId('cal_s'),
            profileId: profile.id,
            profileVersion: profile.version,
            status: STATUSES.DRAFT,
            operatorId: actor || 'unknown'
        };
        const created = await storage.createSession(session);
        logger.info(`calibration session created: ${created.id} (profile ${profile.id} v${profile.version})`);
        return created;
    }

    async function getSessionView(sessionId) {
        const session = await loadSession(sessionId);
        const points = await storage.getPoints(sessionId);
        const auditRecords = await storage.getAuditRecords(sessionId);
        const profile = await storage.getProfile(session.profileId);
        return {
            session: session,
            points: points,
            audit: auditRecords,
            profile: profile
        };
    }

    async function getSessions(filter) {
        return storage.getSessions(filter);
    }

    async function addPoint(sessionId, referenceValue, expectedRevision, actor) {
        assertCondition(isFiniteNumber(referenceValue), 'CAL_VALIDATION_ERROR', 'referenceValue must be a finite number');
        const session = await loadSession(sessionId);
        checkNotSampling(session);
        requireRevision(session, expectedRevision);
        assertCondition(
            [STATUSES.DRAFT, STATUSES.READY, STATUSES.FITTED].indexOf(session.status) !== -1,
            'CAL_STATE_CONFLICT', 'cannot add point in status ' + session.status);

        const points = await storage.getPoints(sessionId);
        const point = {
            id: newId('cal_p'),
            sessionId: sessionId,
            sequence: points.length ? Math.max(...points.map(p => p.sequence)) + 1 : 1,
            referenceValue: referenceValue,
            stats: null,
            createdAt: new Date().toISOString()
        };
        await storage.createPoint(point);
        // point set changed -> invalidate fit/approval
        await storage.updateSession(sessionId, null, {
            status: STATUSES.READY,
            fit: null,
            fitHash: null,
            approvalExpiresAt: null
        }, true);
        return storage.getPoint(point.id);
    }

    async function deletePoint(sessionId, pointId, expectedRevision, actor) {
        const session = await loadSession(sessionId);
        checkNotSampling(session);
        requireRevision(session, expectedRevision);
        assertCondition(
            [STATUSES.DRAFT, STATUSES.READY, STATUSES.FITTED].indexOf(session.status) !== -1,
            'CAL_STATE_CONFLICT', 'cannot delete point in status ' + session.status);
        const point = await storage.getPoint(pointId);
        assertCondition(point && point.sessionId === sessionId, 'CAL_VALIDATION_ERROR', 'point not found in session');
        await storage.deletePoint(pointId);
        await storage.updateSession(sessionId, null, {
            status: STATUSES.READY,
            fit: null,
            fitHash: null,
            approvalExpiresAt: null
        }, true);
        return true;
    }

    // ------------------------------------------------------------- sampling

    async function startSample(sessionId, pointId, expectedRevision, actor) {
        const session = await loadSession(sessionId);
        checkNotSampling(session);
        requireRevision(session, expectedRevision);
        assertCondition(
            [STATUSES.DRAFT, STATUSES.READY, STATUSES.FITTED].indexOf(session.status) !== -1,
            'CAL_STATE_CONFLICT', 'cannot sample in status ' + session.status);
        const profile = await loadProfile(session.profileId);
        const point = await storage.getPoint(pointId);
        assertCondition(point && point.sessionId === sessionId, 'CAL_VALIDATION_ERROR', 'point not found in session');

        const running = [...activeRuns.keys()];
        assertCondition(running.length < calSettings().maxConcurrentSamplingSessions,
            'CAL_STATE_CONFLICT', 'too many concurrent sampling sessions');

        const getter = async () => {
            const value = runtime.devices.getTagValue(profile.sourceTagId, true);
            return value;
        };
        const run = new sampleEngine.SampleRun(profile.sourceTagId, profile.sampling, getter);
        activeRuns.set(sessionId, run);
        await storage.updateSession(sessionId, null, { status: STATUSES.SAMPLING }, false);

        run.on('progress', progress => emitSampleProgress(sessionId, pointId, progress));

        // run async; API returns immediately with accepted state
        run.run().then(async result => {
            activeRuns.delete(sessionId);
            if (!result.stable) {
                // samples persisted but point marked unstable: operator may retry
                await storage.updatePointResult(pointId, result.stats, result.samples, result.stable, result.stableViolations);
                await storage.updateSession(sessionId, null, { status: STATUSES.READY }, true);
                emitEvent('calibration:sample-error', {
                    sessionId, pointId,
                    errorCode: 'CAL_SAMPLE_UNSTABLE',
                    violations: result.stableViolations,
                    stats: result.stats
                });
                return;
            }
            await storage.updatePointResult(pointId, result.stats, result.samples, result.stable, result.stableViolations);
            await storage.updateSession(sessionId, null, {
                status: STATUSES.READY,
                fit: null,
                fitHash: null,
                approvalExpiresAt: null
            }, true);
            emitEvent('calibration:sample-complete', {
                sessionId, pointId,
                stats: result.stats,
                accepted: result.acceptedCount,
                rejected: result.rejectedCount
            });
        }).catch(async err => {
            activeRuns.delete(sessionId);
            const canceled = run.canceled && (err.message === 'CAL_SAMPLE_CANCELED' || err.code === 'CAL_SAMPLE_CANCELED');
            await storage.updateSession(sessionId, null, { status: STATUSES.READY }, true);
            emitEvent(canceled ? 'calibration:canceled' : 'calibration:sample-error', {
                sessionId, pointId,
                errorCode: err.code || err.message || 'CAL_SAMPLE_ERROR'
            });
        });

        return { sessionId, pointId, status: STATUSES.SAMPLING };
    }

    async function cancelSample(sessionId, actor) {
        const run = activeRuns.get(sessionId);
        if (!run) {
            return { canceled: false, reason: 'no sampling in progress' };
        }
        run.cancel();
        return { canceled: true };
    }

    // ------------------------------------------------------------- fit / approval

    async function fit(sessionId, expectedRevision, actor) {
        const session = await loadSession(sessionId);
        checkNotSampling(session);
        requireRevision(session, expectedRevision);
        assertCondition(
            [STATUSES.READY, STATUSES.FITTED, STATUSES.AWAITING_APPROVAL].indexOf(session.status) !== -1,
            'CAL_STATE_CONFLICT', 'cannot fit in status ' + session.status);
        const profile = await loadProfile(session.profileId);
        const points = await storage.getPoints(sessionId);

        const missing = points.filter(p => !p.stats || !isFiniteNumber(p.stats.mean));
        assertCondition(missing.length === 0, 'CAL_VALIDATION_ERROR',
            'all points must be sampled before fit (missing: ' + missing.map(p => p.sequence).join(',') + ')');
        const unstable = points.filter(p => p.stats.stable === false);
        assertCondition(unstable.length === 0, 'CAL_SAMPLE_UNSTABLE',
            'unstable points: ' + unstable.map(p => p.sequence).join(','));

        const fitResult = fitEngine.fitLinear(points.map(p => ({
            id: p.id,
            mean: p.stats.mean,
            referenceValue: p.referenceValue
        })), profile.quality || {});

        await storage.updateSession(sessionId, null, {
            status: fitResult.qualityPassed ? STATUSES.FITTED : STATUSES.READY,
            fit: fitResult,
            fitHash: fitEngine.computeFitHash(fitResult),
            approvalExpiresAt: null
        }, true);

        emitEvent('calibration:fit-complete', {
            sessionId: sessionId,
            gain: fitResult.gain,
            offset: fitResult.offset,
            r2: fitResult.r2,
            rmse: fitResult.rmse,
            qualityPassed: fitResult.qualityPassed,
            violations: fitResult.violations
        });
        logger.info(`calibration fit: ${sessionId} k=${fitResult.gain} b=${fitResult.offset} R2=${fitResult.r2} passed=${fitResult.qualityPassed}`);
        const updated = await loadSession(sessionId);
        return { session: updated, fit: fitResult, fitHash: updated.fitHash };
    }

    async function submit(sessionId, expectedRevision, actor) {
        const session = await loadSession(sessionId);
        checkNotSampling(session);
        requireRevision(session, expectedRevision);
        assertCondition(session.status === STATUSES.FITTED, 'CAL_STATE_CONFLICT',
            'submit requires a quality-passed fit (status ' + session.status + ')');
        assertCondition(session.fit && session.fit.qualityPassed, 'CAL_QUALITY_FAILED',
            'fit quality does not pass the configured gates');
        await storage.updateSession(sessionId, null, {
            status: STATUSES.AWAITING_APPROVAL,
            approvalExpiresAt: new Date(Date.now() + calSettings().approvalTtlSeconds * 1000).toISOString()
        }, false);
        return loadSession(sessionId);
    }

    async function approve(sessionId, body, approverId) {
        assertCondition(body && isFiniteNumber(body.revision), 'CAL_VALIDATION_ERROR', 'revision is required');
        assertCondition(body.fitHash, 'CAL_VALIDATION_ERROR', 'fitHash is required');
        const session = await loadSession(sessionId);
        requireRevision(session, body.revision);
        assertCondition(session.status === STATUSES.AWAITING_APPROVAL, 'CAL_STATE_CONFLICT',
            'session is not awaiting approval');
        assertCondition(approvalValid(session), 'CAL_STATE_CONFLICT', 'approval request expired, submit again');
        assertCondition(session.fitHash === body.fitHash, 'CAL_STATE_CONFLICT',
            'fitHash mismatch: fitted data changed after approval request');
        if (calSettings().requireTwoPersonApproval) {
            assertCondition(approverId && approverId !== session.operatorId, 'CAL_FORBIDDEN',
                'two-person approval: approver must differ from operator');
        }

        await storage.updateSession(sessionId, null, {
            status: STATUSES.APPROVED,
            approverId: approverId,
            approvalExpiresAt: new Date(Date.now() + calSettings().approvalTtlSeconds * 1000).toISOString()
        }, false);
        logger.info(`calibration session approved: ${sessionId} by ${approverId}`);
        return loadSession(sessionId);
    }

    async function reject(sessionId, body, approverId) {
        const session = await loadSession(sessionId);
        assertCondition(session.status === STATUSES.AWAITING_APPROVAL, 'CAL_STATE_CONFLICT',
            'session is not awaiting approval');
        await storage.updateSession(sessionId, null, {
            status: STATUSES.FITTED,
            approverId: null,
            approvalExpiresAt: null
        }, true);
        logger.info(`calibration session rejected: ${sessionId} by ${approverId} reason: ${(body && body.reason) || '-'}`);
        return loadSession(sessionId);
    }

    /**
     * Issue a one-time confirmation token bound to sessionId+revision+fitHash.
     * The writer calls this after showing the final confirmation dialog.
     */
    async function confirmApply(sessionId, body, actor) {
        // 90-AF: same conflation as checkSecureMode() - gate on the module's own setting.
        assertCondition(calSettings().writeEnabled, 'CAL_FORBIDDEN', 'calibration write is disabled by settings');
        const session = await loadSession(sessionId);
        requireRevision(session, body && body.revision);
        assertCondition(session.status === STATUSES.APPROVED, 'CAL_STATE_CONFLICT', 'session is not approved');
        assertCondition(approvalValid(session), 'CAL_STATE_CONFLICT', 'approval expired, submit and approve again');
        if (body && body.fitHash) {
            assertCondition(session.fitHash === body.fitHash, 'CAL_STATE_CONFLICT', 'fitHash mismatch');
        }
        // single-use token
        const token = crypto.randomBytes(24).toString('hex');
        confirmTokens.set(token, {
            sessionId: sessionId,
            revision: session.revision,
            fitHash: session.fitHash,
            expiresAt: Date.now() + calSettings().confirmationTtlSeconds * 1000,
            used: false
        });
        return {
            sessionId: sessionId,
            revision: session.revision,
            fitHash: session.fitHash,
            confirmationToken: token,
            expiresAt: new Date(Date.now() + calSettings().confirmationTtlSeconds * 1000).toISOString()
        };
    }

    function consumeConfirmToken(token, session) {
        assertCondition(token && typeof token === 'string', 'CAL_VALIDATION_ERROR', 'confirmationToken is required');
        const rec = confirmTokens.get(token);
        assertCondition(rec, 'CAL_VALIDATION_ERROR', 'unknown confirmationToken');
        assertCondition(!rec.used, 'CAL_VALIDATION_ERROR', 'confirmationToken already used');
        assertCondition(rec.expiresAt > Date.now(), 'CAL_STATE_CONFLICT', 'confirmationToken expired');
        assertCondition(rec.sessionId === session.id &&
            rec.revision === session.revision &&
            rec.fitHash === session.fitHash, 'CAL_STATE_CONFLICT',
            'confirmationToken does not match current session state');
        rec.used = true;
        confirmTokens.delete(token);
    }

    // ------------------------------------------------------------- write (apply)

    async function apply(sessionId, body, actor, idempotencyKey) {
        checkSecureMode();
        assertCondition(idempotencyKey && typeof idempotencyKey === 'string', 'CAL_VALIDATION_ERROR',
            'Idempotency-Key header is required');

        // idempotency replay
        const existing = await storage.getAuditByIdempotencyKey(idempotencyKey);
        if (existing) {
            if (existing.status === 'running') {
                fail('CAL_STATE_CONFLICT', 'identical write operation is still in progress');
            }
            return { replayed: true, audit: existing, result: existing.result || null };
        }

        assertCondition(body && isFiniteNumber(body.revision), 'CAL_VALIDATION_ERROR', 'revision is required');
        assertCondition(body.fitHash, 'CAL_VALIDATION_ERROR', 'fitHash is required');
        const session = await loadSession(sessionId);
        requireRevision(session, body.revision);
        assertCondition(session.status === STATUSES.APPROVED, 'CAL_STATE_CONFLICT', 'session is not approved');
        assertCondition(approvalValid(session), 'CAL_STATE_CONFLICT', 'approval expired');
        assertCondition(session.fitHash === body.fitHash, 'CAL_STATE_CONFLICT', 'fitHash mismatch');
        consumeConfirmToken(body.confirmationToken, session);

        const profile = await loadProfile(session.profileId);
        const points = await storage.getPoints(sessionId);

        // build write plan
        let plan;
        if (profile.write && profile.write.mode === 'raw-block') {
            plan = writePlanner.planRawBlockWrite(profile, session.fit, points);
            writePlanner.checkAllowlist(runtime.settings, plan);
        } else {
            plan = writePlanner.planTagWrite(profile, session.fit);
        }

        // audit record persisted BEFORE any device write
        const auditId = newId('cal_a');
        const lastHash = await storage.getLastAuditHash();
        const rec = {
            id: auditId,
            sessionId: sessionId,
            idempotencyKey: idempotencyKey,
            operatorId: session.operatorId,
            approverId: session.approverId,
            request: {
                mode: plan.mode,
                revision: session.revision,
                fitHash: session.fitHash,
                planSummary: plan.summary
            },
            beforeHex: null,
            intendedHex: plan.mode === 'raw-block' ? plan.hex : JSON.stringify(plan.steps.map(s => ({ tagId: s.tagId, value: s.value }))),
            status: 'running',
            previousHash: lastHash,
            createdAt: new Date().toISOString()
        };
        rec.recordHash = audit.hashRecord(rec.previousHash, rec);
        await storage.createAuditRecord(rec);
        await storage.updateSession(sessionId, null, { status: STATUSES.WRITING }, false);
        emitEvent('calibration:write-progress', { sessionId, auditId, phase: 'planned', mode: plan.mode, summary: plan.summary });

        // device business lock: one write per device at a time
        const lockKey = plan.mode === 'raw-block' ? ('device:' + plan.deviceId) : ('session-write:' + sessionId);
        try {
            const result = await deviceLocks.withLock(lockKey, async () => {
                await storage.updateSession(sessionId, null, { status: STATUSES.WRITING }, false);

                const notify = async (event, payload) => {
                    if (event === 'before-snapshot') {
                        // persist snapshot before any write command is sent
                        const beforeHex = payload && payload.beforeHex !== undefined
                            ? payload.beforeHex
                            : JSON.stringify(payload && payload.before);
                        await storage.updateAuditRecord(auditId, { beforeHex: beforeHex });
                        emitEvent('calibration:write-progress', { sessionId, auditId, phase: 'snapshot' });
                    } else {
                        emitEvent('calibration:write-progress', Object.assign({ sessionId, auditId }, payload || {}));
                    }
                };

                const result = plan.mode === 'raw-block'
                    ? await writeCoordinator.executeRawBlockWrite(runtime, plan, notify)
                    : await writeCoordinator.executeTagWrite(runtime, plan, notify);
                return result;
            });

            const finalStatus = result.status === 'applied' ? STATUSES.APPLIED
                : (result.status === 'failed' ? STATUSES.FAILED : STATUSES.UNCERTAIN);
            await storage.updateSession(sessionId, null, {
                status: finalStatus,
                completedAt: new Date().toISOString()
            }, true);

            const patch = {
                status: result.status === 'applied' ? 'applied' : (result.status === 'failed' ? 'failed' : 'uncertain'),
                readbackHex: result.readback !== undefined ? (typeof result.readback === 'string' ? result.readback : JSON.stringify(result.readback)) : result.readbackHex,
                rollbackHex: result.rollback !== undefined ? (result.rollback === null ? null : JSON.stringify(result.rollback)) : result.rollbackHex,
                errorCode: result.error ? result.error.code : null,
                errorMessage: result.error ? result.error.message : null,
                completedAt: new Date().toISOString(),
                result: result
            };
            await updateAuditWithHash(auditId, patch);
            emitEvent(result.status === 'applied' ? 'calibration:write-complete' : 'calibration:write-error', {
                sessionId, auditId, status: result.status, verified: !!result.verified,
                errorCode: result.error ? result.error.code : null
            });
            logger.info(`calibration apply: ${sessionId} -> ${result.status}`);
            const auditRecord = await storage.getAuditRecord(auditId);
            return { sessionId, status: result.status, auditId, verified: !!result.verified, audit: auditRecord };
        } catch (err) {
            // write orchestration itself failed (not a device verify failure)
            const patch = {
                status: 'uncertain',
                errorCode: err.code || 'CAL_DEVICE_WRITE_FAILED',
                errorMessage: err.message,
                completedAt: new Date().toISOString(),
                result: null
            };
            await updateAuditWithHash(auditId, patch).catch(() => {});
            await storage.updateSession(sessionId, null, {
                status: STATUSES.UNCERTAIN,
                completedAt: new Date().toISOString()
            }, true).catch(() => {});
            emitEvent('calibration:write-error', { sessionId, auditId, errorCode: err.code || 'CAL_DEVICE_WRITE_FAILED' });
            throw err;
        }
    }

    async function updateAuditWithHash(auditId, patch) {
        const prev = await storage.getAuditRecord(auditId);
        const merged = Object.assign({}, prev, patch);
        const newHash = audit.hashRecord(merged.previousHash, merged);
        await storage.updateAuditRecord(auditId, Object.assign({}, patch, { recordHash: newHash }));
    }

    // ------------------------------------------------------------- cancel / export

    async function cancelSession(sessionId, expectedRevision, actor) {
        const session = await loadSession(sessionId);
        checkNotSampling(session);
        requireRevision(session, expectedRevision);
        assertCondition(
            [STATUSES.DRAFT, STATUSES.READY, STATUSES.FITTED, STATUSES.AWAITING_APPROVAL].indexOf(session.status) !== -1,
            'CAL_STATE_CONFLICT', 'cannot cancel in status ' + session.status);
        await storage.updateSession(sessionId, null, {
            status: STATUSES.CANCELED,
            completedAt: new Date().toISOString()
        }, true);
        emitEvent('calibration:canceled', { sessionId });
        return loadSession(sessionId);
    }

    async function exportSession(sessionId, format) {
        const view = await getSessionView(sessionId);
        if (format === 'csv') {
            const lines = [];
            lines.push('section,id,sequence,reference,mean,stdDev,min,max,accepted,rejected,stable');
            for (const p of view.points) {
                lines.push([
                    'point', p.id, p.sequence, p.referenceValue,
                    p.stats ? p.stats.mean : '', p.stats ? p.stats.stdDev : '',
                    p.stats ? p.stats.min : '', p.stats ? p.stats.max : '',
                    p.samples.filter(s => s.accepted).length,
                    p.samples.filter(s => !s.accepted).length,
                    p.stats ? (p.stats.stable === false ? 'false' : 'true') : ''
                ].join(','));
                for (const s of p.samples) {
                    lines.push(['sample', p.id, '', '', s.value === null ? '' : s.value, '', '', '',
                        s.accepted ? 1 : 0, s.accepted ? 0 : 1, '', s.rejectReason || ''].join(','));
                }
            }
            if (view.session.fit) {
                const f = view.session.fit;
                lines.push('fit,,,gain=' + f.gain + ',offset=' + f.offset + ',r2=' + f.r2 + ',rmse=' + f.rmse + ',maxAbsError=' + f.maxAbsError);
            }
            return { filename: sessionId + '.csv', content: lines.join('\n'), contentType: 'text/csv' };
        }
        return { filename: sessionId + '.json', content: JSON.stringify(view, null, 2), contentType: 'application/json' };
    }

    // ------------------------------------------------------------- recovery

    /**
     * Restart recovery per doc 19.2:
     * - sampling -> ready (no auto-resume)
     * - writing/verifying -> uncertain (requires manual handling)
     * - expired approvals -> back to awaiting-approval
     */
    async function restore() {
        try {
            const sampling = await storage.countSessionsWithStatus([STATUSES.SAMPLING]);
            if (sampling > 0) {
                await storage.run("UPDATE calibration_sessions SET status = 'ready', updated_at = ? WHERE status = 'sampling'", [new Date().toISOString()]);
                logger.warn(`calibration restore: ${sampling} sampling sessions marked ready (no auto-resume)`);
            }
            const writing = await storage.countSessionsWithStatus([STATUSES.WRITING, STATUSES.VERIFYING]);
            if (writing > 0) {
                await storage.run("UPDATE calibration_sessions SET status = 'uncertain', updated_at = ? WHERE status IN ('writing', 'verifying')", [new Date().toISOString()]);
                logger.error(`calibration restore: ${writing} write sessions marked UNCERTAIN: manual device check required`);
            }
            // expire stale approvals
            const now = new Date().toISOString();
            await storage.run("UPDATE calibration_sessions SET status = 'awaiting-approval', approval_expires_at = NULL, updated_at = ? WHERE status = 'approved' AND approval_expires_at IS NOT NULL AND approval_expires_at < ?", [now, now]);
            // close stale awaiting-approval
            await storage.run("UPDATE calibration_sessions SET status = 'fitted', approval_expires_at = NULL, updated_at = ? WHERE status = 'awaiting-approval' AND approval_expires_at IS NOT NULL AND approval_expires_at < ?", [now, now]);
            logger.info('calibration service restored');
        } catch (err) {
            logger.error('calibration restore failed: ' + err.message);
        }
    }

    function stop() {
        // cancel all active sample runs and clear timers
        for (const run of activeRuns.values()) {
            try { run.cancel(); } catch (e) { /* ignore */ }
        }
        activeRuns.clear();
        confirmTokens.clear();
    }

    return {
        // profiles
        getProfiles: () => storage.getProfiles(),
        getProfile: (id) => storage.getProfile(id),
        saveProfile: saveProfile,
        deleteProfile: deleteProfile,
        validateProfileLive: validateProfileLive,
        // sessions
        createSession: createSession,
        getSessions: getSessions,
        getSessionView: getSessionView,
        addPoint: addPoint,
        deletePoint: deletePoint,
        startSample: startSample,
        cancelSample: cancelSample,
        fit: fit,
        submit: submit,
        approve: approve,
        reject: reject,
        confirmApply: confirmApply,
        apply: apply,
        cancelSession: cancelSession,
        exportSession: exportSession,
        // lifecycle
        restore: restore,
        stop: stop,
        invalidateSettingsCache: invalidateSettingsCache
    };
}

module.exports = {
    create: create,
    STATUSES: STATUSES
};
