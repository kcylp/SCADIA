/**
 * 'api/cameras': Camera / video-source REST API.
 * Mirrors the calibration API: auth middleware + explicit action checks +
 * stable error codes. Credentials are never returned to the client.
 */

'use strict';

var express = require('express');
const authJwt = require('../jwt-helper');

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
    AI_BAD_PAYLOAD: 400,
    AI_RULES_CONFLICT: 409
};

function sendError(res, err) {
    const code = (err && err.code) || 'CAM_INTERNAL_ERROR';
    res.status(ERR_HTTP[code] || 500).json({ error: code, message: (err && err.message) || String(err) });
}

function authContext(req) {
    const secureEnabled = !!(runtime.settings && runtime.settings.secureEnabled);
    if (!secureEnabled) {
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

/** action: 'view' | 'admin' */
function requireAction(req, res, action) {
    const auth = authContext(req);
    if (action === 'view') { return auth; }
    if (!auth.secureEnabled) {
        res.status(403).json({ error: 'CAM_SECURITY_DISABLED', message: 'Secure mode is disabled: camera changes are not allowed' });
        return null;
    }
    if (auth.isGuest) {
        res.status(401).json({ error: 'CAM_UNAUTHENTICATED', message: 'Guest users cannot manage cameras' });
        return null;
    }
    if (action === 'admin' && !auth.isAdmin) {
        res.status(403).json({ error: 'CAM_FORBIDDEN', message: 'Admin permission required' });
        return null;
    }
    return auth;
}

function requireSceneView(req, res) {
    // Global scene files have no per-camera ACL; match the unified analysis boundary.
    if (!runtime.settings?.secureEnabled) { return authContext(req); }
    if (!req.isAuthenticated) {
        res.status(401).json({ error: 'CAM_UNAUTHENTICATED', message: 'Login required' });
        return null;
    }
    return requireAction(req, res, 'admin');
}

function requireSceneAdmin(req, res) {
    return require('../scene-auth').requireSceneAdmin(req, res, runtime, checkGroupsFnc);
}

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
        camApp.use(function (req, res, next) {
            if (!runtime.project) { res.status(404).end(); return; }
            res.setHeader('Cache-Control', 'no-store');
            next();
        });

        function service() {
            if (!runtime.cameraService) {
                throw Object.assign(new Error('camera service not initialized'), { code: 'CAM_INTERNAL_ERROR' });
            }
            return runtime.cameraService;
        }
        function vendorPresets() { return runtime.cameraPresets; }
        function mediaGateway() {
            if (!runtime.cameraMedia) {
                throw Object.assign(new Error('media gateway not initialized'), { code: 'MEDIA_NOT_CONFIGURED' });
            }
            return runtime.cameraMedia;
        }
        function fusion() {
            if (!runtime.cameraFusion) {
                throw Object.assign(new Error('fusion not initialized'), { code: 'CAM_INTERNAL_ERROR' });
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

        camApp.get('/api/cameras', secureFnc, (req, res) => {
            const auth = requireAction(req, res, 'view');
            if (!auth) { return; }
            handle(service().list(), res, r => res.json({ cameras: r || [] }), 'list');
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
            // ms > 0 表示"步进"：服务端在 ms 之后自动补一个 stop（相机上是连续资源，
            // 没人发 stop 就会一路走到机械尽头 —— 这正是"点一下直接到底"的成因）
            const action = { code: (req.body && req.body.code) || 'stop', speed: (req.body && req.body.speed) || 1, ms: (req.body && req.body.ms) || 0 };
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
            const auth = runtime.settings?.secureEnabled ? requireAction(req, res, 'operate') : requireSceneAdmin(req, res);
            if (!auth) { return; }
            handle(ai().ingest(req.body, 'http'), res, r => res.json(r), 'ai-ingest');
        });

        let sceneStore;
        const scenes = () => {
            const active = runtime.cameraScenes || require('../../runtime/cameras').scenes;
            if (active) { return active; }
            if (!sceneStore) {
                const { SceneStore } = require('../../runtime/cameras/scene-store');
                sceneStore = new SceneStore(runtime.settings.workDir, runtime.settings.imagesFileDir);
            }
            return sceneStore;
        };
        let sceneCalibration;
        const calibration = () => {
            if (!sceneCalibration) {
                sceneCalibration = new (require('../../runtime/cameras/scene-calibration').Calibration)(runtime.settings.workDir);
            }
            return sceneCalibration;
        };
        const rules = new (require('../../runtime/cameras/scene-rules').SceneRules)(runtime.settings.workDir);
        let sceneThermometry;
        const thermometry = () => {
            if (!sceneThermometry) {
                sceneThermometry = require('../../runtime/cameras/thermometry').create(runtime);
            }
            return sceneThermometry;
        };
        camApp.get('/api/ai/scenes/rules/:source', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => rules.read(req.params.source)), res, r => res.json(r), 'scene-rules');
        });
        camApp.put('/api/ai/scenes/rules/:source', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(Promise.resolve().then(() => rules.save(req.params.source, req.body, req.userId)), res, r => res.json(r), 'scene-rules-save');
        });
        camApp.get('/api/ai/scenes/calibration', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(Promise.resolve().then(() => calibration().read()), res, r => res.json(r), 'scene-calibration');
        });
        camApp.post('/api/ai/scenes/calibration', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(Promise.resolve().then(() => calibration().save(req.body, req.userId || 'unknown')), res, r => res.json(r), 'scene-calibration-save');
        });
        camApp.get('/api/ai/scenes', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().status()), res, r => res.json(r), 'scenes');
        });
        camApp.get('/api/ai/scenes/thermometry', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => thermometry().snapshot()), res, r => {
                res.set('Cache-Control', 'private, no-store'); res.json(r);
            }, 'scenes-thermometry');
        });
        camApp.get('/api/ai/scenes/frame/:source', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            const source = { visible: 'kuangqu1', thermal: 'kuangqu1-thermal' }[req.params.source];
            if (!source) { return res.sendStatus(404); }
            const upstream = require('http').get('http://127.0.0.1:1886/snapshot/' + source, response => {
                if (response.statusCode !== 200) { response.resume(); return res.sendStatus(503); }
                res.set('Cache-Control', 'no-store'); res.type('jpeg');
                res.set('X-Frame-Time', response.headers['x-frame-time'] || '0');
                response.on('error', () => res.destroy()); response.pipe(res);
            });
            upstream.setTimeout(4000, () => upstream.destroy());
            upstream.on('error', () => { if (!res.headersSent) { res.sendStatus(503); } else { res.destroy(); } });
            res.on('close', () => upstream.destroy());
        });
        const eventFrames = event => {
            const frames = [{ file: event.shot, at: event.at }, ...(event.evidenceFrames || [])];
            return frames.filter((f, i) => new RegExp('^scene-' + event.eventId + '(?:-[0-2])?\\.jpg$').test(f.file) &&
                frames.findIndex(other => other.file === f.file) === i);
        };
        camApp.get('/api/ai/scene-events/:id/evidence-manifest', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().getEvent(req.params.id)), res, event => {
                const frames = eventFrames(event).map((f, index) => ({ at: f.at,
                    available: require('fs').existsSync(require('path').join(runtime.settings.workDir, 'scene-evidence', f.file)),
                    url: '/api/ai/scene-events/' + event.eventId + '/evidence?frame=' + index }));
                res.set('Cache-Control', 'private, no-store');
                res.json({ eventId: event.eventId, sceneId: event.sceneId, at: event.at,
                    ackAt: event.ackAt, ackBy: event.ackBy, reviewStatus: event.reviewStatus, review: event.review, frames });
            }, 'scene-evidence-manifest');
        });
        camApp.get('/api/ai/scene-events/:id/evidence', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            if (req.query.frame !== undefined && !/^[0-3]$/.test(req.query.frame)) { return res.sendStatus(400); }
            handle(Promise.resolve().then(() => scenes().getEvent(req.params.id)), res, event => {
                const frame = eventFrames(event)[Number(req.query.frame || 0)];
                if (!frame) { return res.sendStatus(404); }
                res.set('Cache-Control', 'private, no-store');
                res.sendFile(require('path').join(runtime.settings.workDir, 'scene-evidence', frame.file), err => {
                    if (err && !res.headersSent) { res.sendStatus(404); }
                });
            }, 'scene-evidence');
        });
        camApp.post('/api/ai/scene-review-tasks/claim', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().claimReview()), res, r => res.json({ task: r }), 'scene-review-claim');
        });
        camApp.post('/api/ai/scene-review-tasks/:id/result', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().finishReview(req.params.id, req.body)), res, r => res.json(r), 'scene-review-result');
        });
        camApp.get('/api/ai/scene-events/deliveries', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(scenes().deliveries(), res, rows => res.json({ rows }), 'scene-deliveries');
        });
        camApp.get('/api/ai/scene-events/summary', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().aggregate(req.query)), res, r => res.json(r), 'scene-summary');
        });
        camApp.get('/api/ai/scene-events/export', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().exportEvents(req.query)), res, r => {
                res.set('Content-Disposition', 'attachment; filename="scadia-scene-events.json"');
                res.json(r);
            }, 'scene-export');
        });
        camApp.get('/api/ai/scene-events', secureFnc, (req, res) => {
            if (!requireSceneView(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().list(req.query)), res, r => res.json(r), 'scene-events');
        });
        camApp.post('/api/ai/scene-events/:id/ack', secureFnc, (req, res) => {
            if (!requireSceneAdmin(req, res)) { return; }
            handle(Promise.resolve().then(() => scenes().acknowledge(req.params.id, req.userId || 'unknown')), res, r => res.json(r), 'scene-ack');
        });

        // 报警计数清零：**当日与累计全部清空**（用户口径："所有都清除"）。
        // 计数文件由事件桥接器维护，平台不持有它们，所以这里是平台代写这两份 JSON。
        // 只清"次数"，不删报警记录本身 —— 报警记录在 /api/alarms，另有确认/删除流程。
        camApp.post('/api/ai/events/reset', secureFnc, (req, res) => {
            const auth = requireSceneAdmin(req, res);
            if (!auth) { return; }
            handle(resetEventCounters(req), res, r => res.json(r), 'ai-events-reset');
        });

        return camApp;
    },
    sendError: sendError
};

function resetEventCounters(req) {
    return require('../../runtime/cameras/event-counters').reset(
        runtime.settings.workDir, runtime.settings.imagesFileDir, req.userId || 'unknown'
    );
}
