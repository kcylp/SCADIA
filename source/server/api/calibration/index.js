/**
 * 'api/calibration': Calibration REST API
 *
 * Registered in server/api/index.js next to recipesApi.
 * All routes pass SCADIA authMiddleware (secureFnc); every handler additionally
 * performs an explicit action-permission check and maps errors to stable codes.
 *
 * Permission model (doc 13.1), mapped onto SCADIA groups:
 *   view     -> any authenticated user (guest allowed when insecure, view-only)
 *   operate  -> non-guest user
 *   approve / write / admin -> admin groups
 * When SCADIA secureEnabled=false the module is view-only (doc 1/13.2).
 */

'use strict';

var express = require('express');
const crypto = require('crypto');
const authJwt = require('../jwt-helper');

var runtime;
var secureFnc;
var checkGroupsFnc;

const ERR_HTTP = {
    CAL_VALIDATION_ERROR: 400,
    CAL_FIT_MIN_POINTS: 400,
    CAL_FIT_ZERO_RAW_SPAN: 400,
    CAL_FIT_NON_FINITE: 400,
    CAL_FIT_NON_FINITE_RESULT: 400,
    CAL_SESSION_NOT_FOUND: 404,
    CAL_PROFILE_NOT_FOUND: 404,
    CAL_UNAUTHENTICATED: 401,
    CAL_FORBIDDEN: 403,
    CAL_SECURITY_DISABLED: 403,
    CAL_STATE_CONFLICT: 409,
    CAL_REVISION_CONFLICT: 409,
    CAL_DEVICE_LOCKED: 409,
    CAL_ALREADY_APPLIED: 409,
    CAL_SAMPLE_IN_PROGRESS: 409,
    CAL_SAMPLE_UNSTABLE: 422,
    CAL_SAMPLE_TIMEOUT: 422,
    CAL_QUALITY_FAILED: 422,
    CAL_ADDRESS_NOT_ALLOWED: 422,
    CAL_DEVICE_WRITE_FAILED: 502,
    CAL_VERIFY_FAILED: 502,
    CAL_DEVICE_OFFLINE: 503,
    CAL_STATE_UNCERTAIN: 500,
    CAL_CODEC_NON_FINITE: 400,
    CAL_CODEC_OUT_OF_RANGE: 400,
    CAL_CODEC_UNKNOWN_TYPE: 400,
    CAL_CODEC_UNKNOWN_ORDER: 400,
    CAL_CODEC_WORD_COUNT: 400,
    CAL_CODEC_WORD_RANGE: 400
};

function sendCalibrationError(res, err) {
    const code = (err && err.code) || 'CAL_INTERNAL_ERROR';
    const http = ERR_HTTP[code] || 500;
    const body = {
        error: code,
        message: (err && err.message) || String(err)
    };
    if (err && err.currentRevision !== undefined) { body.currentRevision = err.currentRevision; }
    if (err && err.currentVersion !== undefined) { body.currentVersion = err.currentVersion; }
    res.status(http).json(body);
}

function _getAuthContext(req) {
    const secureEnabled = !!(runtime.settings && runtime.settings.secureEnabled);
    if (!secureEnabled) {
        // insecure mode: view allowed for anyone; requireAction blocks all writes
        return { secureEnabled: false, isGuest: false, isAdmin: true, userId: req.userId || 'guest' };
    }
    const permission = checkGroupsFnc(req);
    return {
        secureEnabled: true,
        isGuest: authJwt.isGuestUser(req.userId, req.userGroups),
        isAdmin: authJwt.haveAdminPermission(permission),
        userId: req.userId || 'guest'
    };
}

/**
 * Action permission gate. Returns auth context or sends the error response.
 */
function requireAction(req, res, action) {
    const auth = _getAuthContext(req);
    if (action !== 'view' && !auth.secureEnabled) {
        res.status(403).json({ error: 'CAL_SECURITY_DISABLED', message: 'Secure mode is disabled: calibration write operations are not allowed' });
        return null;
    }
    if (action === 'view') {
        return auth;
    }
    if (auth.isGuest) {
        res.status(401).json({ error: 'CAL_UNAUTHENTICATED', message: 'Guest users cannot operate calibration' });
        return null;
    }
    if ((action === 'approve' || action === 'write' || action === 'admin') && !auth.isAdmin) {
        res.status(403).json({ error: 'CAL_FORBIDDEN', message: 'Admin permission required for ' + action });
        return null;
    }
    return auth;
}

function checkEnabled(res) {
    if (!((runtime.settings.calibration || {}).enabled !== false)) {
        res.status(403).json({ error: 'CAL_FORBIDDEN', message: 'calibration module is disabled' });
        return false;
    }
    return true;
}

function _handlePromise(promise, res, okFn, opName) {
    return Promise.resolve(promise).then(result => {
        okFn(result);
    }).catch(err => {
        const level = ERR_HTTP[err.code] && ERR_HTTP[err.code] < 500 ? 'warn' : 'error';
        runtime.logger[level](`api calibration ${opName || ''}: ${err.code || ''} ${err.message}`);
        sendCalibrationError(res, err);
    });
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        var calApp = express();
        calApp.use(function (req, res, next) {
            if (!runtime.project) {
                res.status(404).end();
            } else {
                res.setHeader('Cache-Control', 'no-store');
                next();
            }
        });

        function service() {
            if (!runtime.calibrationService) {
                throw Object.assign(new Error('calibration service not initialized'), { code: 'CAL_INTERNAL_ERROR' });
            }
            return runtime.calibrationService;
        }

        // ------------------------------------------------------------ profiles

        calApp.get('/api/calibration/profiles', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().getProfiles(), res, r => res.json({ profiles: r || [] }), 'getProfiles');
        });

        calApp.get('/api/calibration/profiles/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().getProfile(req.params.id), res, r => {
                if (!r) { res.status(404).json({ error: 'CAL_PROFILE_NOT_FOUND', message: 'profile not found' }); }
                else { res.json(r); }
            }, 'getProfile');
        });

        calApp.post('/api/calibration/profiles', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().saveProfile(req.body, auth.userId), res, r => res.status(201).json(r), 'saveProfile');
        });

        calApp.put('/api/calibration/profiles/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth || !checkEnabled(res)) { return; }
            const body = Object.assign({}, req.body, { id: req.params.id });
            _handlePromise(service().saveProfile(body, auth.userId), res, r => res.json(r), 'updateProfile');
        });

        calApp.delete('/api/calibration/profiles/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().deleteProfile(req.params.id), res, r => res.json({ result: 'ok' }), 'deleteProfile');
        });

        calApp.post('/api/calibration/profiles/:id/validate', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().validateProfileLive(req.params.id), res, r => res.json(r), 'validateProfile');
        });

        // ------------------------------------------------------------ sessions

        calApp.post('/api/calibration/sessions', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().createSession(req.body && req.body.profileId, auth.userId),
                res, r => res.status(201).json(r), 'createSession');
        });

        calApp.get('/api/calibration/sessions', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().getSessions({
                profileId: req.query.profileId,
                status: req.query.status,
                limit: req.query.limit,
                offset: req.query.offset
            }), res, r => res.json({ sessions: r || [] }), 'getSessions');
        });

        calApp.get('/api/calibration/sessions/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().getSessionView(req.params.id), res, r => {
                if (!r) { res.status(404).json({ error: 'CAL_SESSION_NOT_FOUND', message: 'session not found' }); }
                else { res.json(r); }
            }, 'getSession');
        });

        calApp.post('/api/calibration/sessions/:id/points', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().addPoint(req.params.id, req.body && req.body.referenceValue,
                req.body && req.body.revision, auth.userId), res, r => res.status(201).json(r), 'addPoint');
        });

        calApp.delete('/api/calibration/sessions/:id/points/:pointId', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().deletePoint(req.params.id, req.params.pointId,
                req.query.revision !== undefined ? parseInt(req.query.revision) : undefined, auth.userId),
                res, r => res.json({ result: 'ok' }), 'deletePoint');
        });

        calApp.post('/api/calibration/sessions/:id/points/:pointId/sample', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().startSample(req.params.id, req.params.pointId,
                req.body && req.body.revision, auth.userId), res, r => res.status(202).json(r), 'startSample');
        });

        calApp.post('/api/calibration/sessions/:id/sample/cancel', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().cancelSample(req.params.id, auth.userId), res, r => res.json(r), 'cancelSample');
        });

        calApp.post('/api/calibration/sessions/:id/fit', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().fit(req.params.id, req.body && req.body.revision, auth.userId),
                res, r => res.json(r), 'fit');
        });

        calApp.post('/api/calibration/sessions/:id/submit', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().submit(req.params.id, req.body && req.body.revision, auth.userId),
                res, r => res.json(r), 'submit');
        });

        calApp.post('/api/calibration/sessions/:id/approve', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'approve');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().approve(req.params.id, req.body, auth.userId),
                res, r => res.json(r), 'approve');
        });

        calApp.post('/api/calibration/sessions/:id/reject', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'approve');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().reject(req.params.id, req.body, auth.userId),
                res, r => res.json(r), 'reject');
        });

        calApp.post('/api/calibration/sessions/:id/confirm', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'write');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().confirmApply(req.params.id, req.body, auth.userId),
                res, r => res.json(r), 'confirmApply');
        });

        calApp.post('/api/calibration/sessions/:id/apply', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'write');
            if (!auth || !checkEnabled(res)) { return; }
            const idempotencyKey = req.headers['idempotency-key'];
            _handlePromise(service().apply(req.params.id, req.body, auth.userId, idempotencyKey),
                res, r => {
                    if (r && r.replayed) {
                        res.json({ sessionId: req.params.id, replayed: true, audit: r.audit, status: r.audit ? r.audit.status : null });
                    } else {
                        res.json(r);
                    }
                }, 'apply');
        });

        calApp.post('/api/calibration/sessions/:id/cancel', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().cancelSession(req.params.id, req.body && req.body.revision, auth.userId),
                res, r => res.json(r), 'cancelSession');
        });

        calApp.get('/api/calibration/sessions/:id/export', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth || !checkEnabled(res)) { return; }
            _handlePromise(service().exportSession(req.params.id, req.query.format || 'json'), res, r => {
                res.setHeader('Content-Type', r.contentType);
                res.setHeader('Content-Disposition', 'attachment; filename="' + r.filename + '"');
                res.send(r.content);
            }, 'export');
        });

        // module meta (view permission): used by the UI to show security state
        calApp.get('/api/calibration/meta', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            res.json({
                module: 'calibration',
                secureEnabled: !!(runtime.settings && runtime.settings.secureEnabled),
                writeEnabled: !!((runtime.settings.calibration || {}).writeEnabled),
                rawWriteEnabled: !!((runtime.settings.calibration || {}).rawWriteEnabled)
            });
        });

        return calApp;
    },
    sendCalibrationError: sendCalibrationError
};
