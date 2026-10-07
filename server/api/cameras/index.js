/**
 * 'api/cameras': Camera / video-source REST API.
 * Mirrors the calibration API: auth middleware + explicit action checks +
 * stable error codes. Credentials are never returned to the client.
 */

'use strict';

var express = require('express');
const { createAuthHelpers } = require('../_auth-context');
const { projectGuard, domainErrorBoundary } = require('../_domain');

var runtime;
var secureFnc;
var checkGroupsFnc;

const ERR_HTTP = {
    CAM_VALIDATION_ERROR: 400,
    CAM_NOT_FOUND: 404,
    CAM_AUTH_FAILED: 502,
    CAM_UNREACHABLE: 503,
    CAM_NO_SNAPSHOT: 422,
    CAM_NO_RTSP: 422,
    CAM_UNAUTHENTICATED: 401,
    CAM_FORBIDDEN: 403,
    CAM_SECURITY_DISABLED: 403,
    MEDIA_NOT_CONFIGURED: 503,
    MEDIA_UNREACHABLE: 503,
    MEDIA_STREAM_FAILED: 502,
    // The domain boots asynchronously (runtime/index.js calls cameras.init() without awaiting it),
    // so between "HTTP is listening" and "the camera DB is open" every camera route used to fail:
    // service() threw CAM_INTERNAL_ERROR (500) and, before that, camDB was null so the storage layer
    // raised "Cannot read properties of null (reading 'all')". Both were seen in the field log of
    // 2026-10-04 08:36 on a FIRST page load. Not ready is 503 - the caller should retry, and a 500
    // tells an operator the software is broken rather than busy.
    CAM_NOT_READY: 503,
    CAM_PTZ_UNSUPPORTED: 422,
    CAM_PTZ_FAILED: 502,
    CAM_TAG_NOT_FOUND: 404,
    CAM_TAG_WRITE_FAILED: 502,
    GB_NOT_CONFIGURED: 503,
    GB_VALIDATION_ERROR: 400,
    GB_DEVICE_NOT_FOUND: 404,
    GB_CHANNEL_NOT_FOUND: 404,
    GB_DEVICE_OFFLINE: 503,
    GB_SIP_ERROR: 502,
    GB_INVITE_FAILED: 502,
    GB_TIMEOUT: 504,
    AI_NOT_CONFIGURED: 503,
    AI_DISABLED: 503,
    AI_BAD_PAYLOAD: 400
};

function sendError(res, err) {
    const code = (err && err.code) || 'CAM_INTERNAL_ERROR';
    res.status(ERR_HTTP[code] || 500).json({ error: code, message: (err && err.message) || String(err) });
}

// The request authorisation context and the action gate now come from one shared module. This file
// used to carry its own thirty-line copy, and the copies had already drifted from the others (a
// missing field here, a differently-spelled settings check there). The per-domain parts - the error
// code prefix and the wording - stay here, because clients match on the codes.
const authHelpers = createAuthHelpers({
    getRuntime: function () { return runtime; },
    getCheckGroups: function () { return checkGroupsFnc; },
    codePrefix: 'CAM',
    domain: 'cameras'
});
const authContext = authHelpers.authContext;
const requireAction = authHelpers.requireAction;

function handle(promise, res, ok, op) {
    return Promise.resolve(promise).then(ok).catch(err => {
        const level = (ERR_HTTP[err.code] || 500) < 500 ? 'warn' : 'error';
        runtime.logger[level](`api cameras ${op || ''}: ${err.code || ''} ${err.message}`);
        sendError(res, err);
    });
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        var camApp = express();
        camApp.use(projectGuard(() => runtime, { noStore: true }));

        function service() {
            if (!runtime.cameraService) {
                // Still booting. Say so with a code that means "come back", not "we are broken".
                throw Object.assign(new Error('camera service still initialising'), { code: 'CAM_NOT_READY' });
            }
            return runtime.cameraService;
        }
        function vendorPresets() {
            if (!runtime.cameraPresets) {
                // No guard here used to mean `vendorPresets().vendorList()` threw a TypeError, which
                // surfaced as 500 CAM_INTERNAL_ERROR. Same rule as service(): not there yet is 503.
                throw Object.assign(new Error('camera presets still initialising'), { code: 'CAM_NOT_READY' });
            }
            return runtime.cameraPresets;
        }
        function mediaGateway() {
            if (!runtime.cameraMedia) {
                throw Object.assign(new Error('media gateway not initialized'), { code: 'MEDIA_NOT_CONFIGURED' });
            }
            return runtime.cameraMedia;
        }
        function fusion() {
            if (!runtime.cameraFusion) {
                // Was CAM_INTERNAL_ERROR (500) - which contradicts the rule written above this map:
                // "Not ready is 503 - the caller should retry, and a 500 tells an operator the
                // software is broken rather than busy." The cameras domain boots asynchronously
                // (runtime/index.js does not await cameras.init()), so absence means "still
                // booting". Missed when service() was fixed; caught by
                // test/cameras/domainNotReadyContract.test.js, which holds the window open.
                throw Object.assign(new Error('camera fusion still initialising'), { code: 'CAM_NOT_READY' });
            }
            return runtime.cameraFusion;
        }
        function gb() {
            if (!runtime.cameraGb28181 || !runtime.settings || !runtime.settings.gb28181 ||
                !runtime.settings.gb28181.enabled) {
                throw Object.assign(new Error('GB28181 is not enabled (settings.gb28181.enabled)'),
                    { code: 'GB_NOT_CONFIGURED' });
            }
            return runtime.cameraGb28181.service;
        }

        // vendor templates (for the editor form)
        camApp.get('/api/cameras/vendors', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            res.json({ vendors: vendorPresets().vendorList() });
        });

        /**
         * The camera inventory - an empty one while the store is not available yet.
         *
         * WHY THIS IS NOT AN ERROR. The camera store is opened asynchronously at boot, and (measured,
         * batch 75) a project reload used to close it for the rest of the session. In both windows this
         * route answered 500/503 with "not connected yet", which an operator reads as "the software is
         * broken" - while the honest answer to "which cameras are configured?" is "none, yet". The
         * OTHER camera routes keep their 503: they name a resource that cannot be served, and a retry is
         * the correct client behaviour. A list has no such obligation.
         */
        function listCamerasOrNone() {
            let cameraService;
            try { cameraService = service(); } catch (err) { return emptyInventory(err); }
            return Promise.resolve()
                .then(() => cameraService.list())
                .catch(err => {
                    const notReady = (err && err.code === 'CAM_NOT_READY') ||
                        /reading 'all'/.test((err && err.message) || '');
                    if (notReady) { return emptyInventory(err); }
                    throw err;
                });
        }
        function emptyInventory(err) {
            runtime.logger.warn('api cameras list: camera store is not available yet (' +
                ((err && (err.code || err.message)) || 'unknown') + ') - answering an empty inventory');
            return [];
        }

        camApp.get('/api/cameras', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(listCamerasOrNone(), res, r => res.json({ cameras: r || [] }), 'list');
        });

        camApp.get('/api/cameras/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(service().getCamera(req.params.id), res, r => {
                if (!r) { res.status(404).json({ error: 'CAM_NOT_FOUND', message: 'camera not found' }); }
                else { res.json(service().toPublic(r)); }
            }, 'get');
        });

        camApp.post('/api/cameras', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(service().save(req.body), res, r => res.status(201).json(r), 'create');
        });

        camApp.put('/api/cameras/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(service().save(Object.assign({}, req.body, { id: req.params.id })), res, r => res.json(r), 'update');
        });

        camApp.delete('/api/cameras/:id', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(service().remove(req.params.id), res, () => res.json({ result: 'ok' }), 'delete');
        });

        // test an unsaved payload
        camApp.post('/api/cameras/probe', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(service().probe(req.body), res, r => res.json(r), 'probe');
        });

        camApp.post('/api/cameras/:id/probe', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(service().probe(req.params.id), res, r => res.json(r), 'probe-id');
        });

        // live JPEG frame (server-side authenticated); used by the preview
        camApp.get('/api/cameras/:id/snapshot', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(service().snapshot(req.params.id), res, r => {
                res.setHeader('Content-Type', r.contentType);
                res.setHeader('Cache-Control', 'no-store');
                res.send(r.body);
            }, 'snapshot');
        });

        camApp.get('/api/cameras-meta', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            const media = runtime.settings && runtime.settings.mediaServer;
            res.json({
                module: 'cameras',
                secureEnabled: !!(runtime.settings && runtime.settings.secureEnabled),
                streamModes: service().STREAM_MODES,
                mediaServer: { enabled: !!(media && media.enabled && media.apiUrl), type: (media && media.type) || null }
            });
        });

        // media gateway: resolve / start a browser-playable stream for a camera
        camApp.get('/api/cameras/:id/play', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(service().getCamera(req.params.id), res, cam => {
                if (!cam) { res.status(404).json({ error: 'CAM_NOT_FOUND', message: 'camera not found' }); return null; }
                return mediaGateway().playback(runtime.settings, cam)
                    .then(r => res.json(r))
                    .catch(err => sendError(res, err));
            }, 'play');
        });

        camApp.post('/api/cameras/:id/play/stop', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(service().getCamera(req.params.id), res, cam => {
                if (!cam) { res.status(404).json({ error: 'CAM_NOT_FOUND', message: 'camera not found' }); return null; }
                return mediaGateway().removeProxy(runtime.settings, cam)
                    .then(() => res.json({ result: 'ok' }))
                    .catch(err => sendError(res, err));
            }, 'play-stop');
        });

        // WHEP signalling relay: browser posts its SDP offer, we add the media
        // secret server-side and return ZLMediaKit's SDP answer.
        camApp.post('/api/cameras/:id/whep',
            express.text({ type: ['application/sdp', 'text/plain'], limit: '1mb' }),
            secureFnc, (req, res) => {
                const auth = requireAction(req, res, 'view');
                if (!auth) { return; }
                handle(service().getCamera(req.params.id), res, cam => {
                    if (!cam) { res.status(404).json({ error: 'CAM_NOT_FOUND', message: 'camera not found' }); return null; }
                    const offer = typeof req.body === 'string' ? req.body : '';
                    return mediaGateway().whep(runtime.settings, cam, offer)
                        .then(r => {
                            res.status(r.status === 201 ? 201 : 200);
                            res.setHeader('Content-Type', 'application/sdp');
                            res.send(r.sdp);
                        })
                        .catch(err => sendError(res, err));
                }, 'whep');
            });

        // ---------------------------------------------------------------- PTZ

        camApp.get('/api/cameras/:id/ptz/capabilities', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(service().ptzCapabilities(req.params.id), res, r => res.json(r), 'ptz-caps');
        });

        camApp.post('/api/cameras/:id/ptz', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            const action = { code: (req.body && req.body.code) || 'stop', speed: (req.body && req.body.speed) || 1 };
            handle(service().ptzMove(req.params.id, action), res, r => res.json(r), 'ptz-move');
        });

        camApp.post('/api/cameras/:id/ptz/preset', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            const id = (req.body && req.body.preset) || 1;
            const op = (req.body && req.body.op) || 'goto';
            handle(service().ptzPreset(req.params.id, id, op), res, r => res.json(r), 'ptz-preset');
        });

        // ------------------------------------------------- 视数融合 (fusion)

        // current OSD overlay content with LIVE tag values (server-resolved)
        camApp.get('/api/cameras/:id/osd', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(fusion().resolveOsd(req.params.id), res, r => res.json(r), 'osd');
        });

        // camera online status (from the background poller)
        camApp.get('/api/cameras/:id/status', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            const s = fusion().getStatus();
            res.json(s[req.params.id] || { online: null, error: 'not-polled-yet' });
        });

        camApp.get('/api/fusion/status', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(Promise.resolve(fusion().getStatus()), res, r => res.json({ status: r }), 'fusion-status');
        });

        // force one poll pass (manual / testing)
        camApp.post('/api/fusion/poll', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(fusion().pollOnce(), res, r => res.json({ polled: r.length, results: r }), 'fusion-poll');
        });

        // video-side event -> SCADIA tag (报警联动), e.g. AI detection hit
        camApp.post('/api/fusion/event', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            const body = req.body || {};
            handle(fusion().writeEvent(body.tagId, body.value), res, r => res.json(r), 'fusion-event');
        });

        camApp.get('/api/media/health', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(mediaGateway().health(runtime.settings), res, r => res.json(r), 'media-health');
        });

        // ------------------------------------------------------- GB28181 国标

        camApp.get('/api/gb28181/status', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            if (!runtime.cameraGb28181 || !runtime.settings.gb28181 || !runtime.settings.gb28181.enabled) {
                res.json({ enabled: false });
                return;
            }
            handle(Promise.resolve(gb().status()), res, r => res.json(r), 'gb-status');
        });

        camApp.get('/api/gb28181/devices', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(gb().listDevices(), res, r => res.json({ devices: r || [] }), 'gb-devices');
        });

        camApp.get('/api/gb28181/channels', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(gb().listChannels(), res, r => res.json({ channels: r || [] }), 'gb-channels');
        });

        camApp.get('/api/gb28181/sessions', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            res.json({ sessions: gb().getSessions() });
        });

        camApp.get('/api/gb28181/devices/:deviceId', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(gb().getDevice(req.params.deviceId), res, d => {
                if (!d) {
                    res.status(404).json({ error: 'GB_DEVICE_NOT_FOUND', message: 'device not found' });
                    return null;
                }
                return gb().getChannels(d.deviceId)
                    .then(channels => res.json(Object.assign({}, d, { channels: channels })));
            }, 'gb-device');
        });

        camApp.get('/api/gb28181/devices/:deviceId/channels', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(gb().getChannels(req.params.deviceId), res, r => res.json({ channels: r || [] }), 'gb-channels-device');
        });

        // refresh the channel catalog (device answers asynchronously)
        camApp.post('/api/gb28181/devices/:deviceId/catalog', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            handle(gb().queryCatalog(req.params.deviceId), res, r => res.json(r), 'gb-catalog');
        });

        camApp.post('/api/gb28181/devices/:deviceId/refresh', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            handle(gb().refreshDevice(req.params.deviceId), res, r => res.json(r), 'gb-refresh');
        });

        // PTZ over SIP: {"channel":"<channelId>","code":"up|down|left|right|zoomIn|zoomOut|stop","speed":50}
        camApp.post('/api/gb28181/devices/:deviceId/ptz', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            const body = req.body || {};
            const action = { code: body.code || 'stop', speed: body.speed, ptzCmd: body.ptzCmd };
            handle(gb().ptz(req.params.deviceId, body.channel, action), res, r => res.json(r), 'gb-ptz');
        });

        // preset/cruise: {"channel":"...","op":"presetGoto","index":1}
        camApp.post('/api/gb28181/devices/:deviceId/preset', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            const body = req.body || {};
            handle(gb().preset(req.params.deviceId, body.channel, body.op, body.index), res, r => res.json(r), 'gb-preset');
        });

        // start a live stream (INVITE -> ZLMediaKit RTP port)
        camApp.post('/api/gb28181/devices/:deviceId/channels/:channelId/play', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            handle(gb().play(req.params.deviceId, req.params.channelId), res, r => res.json(r), 'gb-play');
        });

        camApp.post('/api/gb28181/devices/:deviceId/channels/:channelId/stop', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            handle(gb().stopStream(req.params.deviceId, req.params.channelId), res, r => res.json(r), 'gb-stop');
        });

        camApp.delete('/api/gb28181/devices/:deviceId', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'admin');
            if (!auth) { return; }
            handle(gb().removeDevice(req.params.deviceId), res, r => res.json(r), 'gb-delete');
        });

        function ai() {
            if (!runtime.cameraAi || !runtime.settings.ai || !runtime.settings.ai.enabled) {
                throw Object.assign(new Error('AI analytics is not enabled (settings.ai.enabled)'),
                    { code: 'AI_NOT_CONFIGURED' });
            }
            return runtime.cameraAi.service;
        }

        // ------------------------------------------------ AI 视频分析 (analytics)

        camApp.get('/api/ai/status', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            if (!runtime.cameraAi || !runtime.settings.ai || !runtime.settings.ai.enabled) {
                res.json({ enabled: false });
                return;
            }
            handle(Promise.resolve(ai().status()), res, r => res.json(r), 'ai-status');
        });

        // live boxes: ?camera=<id> for one camera, omit for all cameras
        camApp.get('/api/ai/detections', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            if (!runtime.cameraAi || !runtime.settings.ai || !runtime.settings.ai.enabled) {
                res.json({ enabled: false, detections: [], cameras: {} });
                return;
            }
            const camera = req.query && req.query.camera;
            if (camera) {
                res.json(Object.assign({ enabled: true }, ai().getDetections(camera)));
                return;
            }
            res.json({ enabled: true, cameras: ai().getAllDetections() });
        });

        // ingest one detection payload (bridge / engine webhook / manual test).
        // MQTT and WebSocket transports call the same service entry point.
        camApp.post('/api/ai/events', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'operate');
            if (!auth) { return; }
            handle(ai().ingest(req.body, 'http'), res, r => res.json(r), 'ai-ingest');
        });

        // Same reason as calibration: every helper here (service(), ai(), mediaGateway(), gb(),
        // fusion()) refuses by THROWING, and the routes call them as arguments, so the throw escapes
        // the module's own promise handler. See api/_domain.js.
        camApp.use(domainErrorBoundary(sendError, () => runtime && runtime.logger));

        return camApp;
    },
    sendError: sendError
};