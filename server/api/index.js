/**
 * 'api/project': API server initialization and general GET/POST
 */

const fs = require('fs');
var express = require('express');
var morgan = require('morgan');
var bodyParser = require('body-parser');
const authJwt = require('./jwt-helper');
const rateLimit = require("express-rate-limit");

const verifyApiOrToken = require('./apikeys/verify-api-or-token');

/**
 * The auth domain, loaded once and remembered.
 *
 * It is initialised twice on purpose: once at startup, and again by the /api/settings handler after
 * a change to the JWT configuration (api/index.js, the secureEnabled/tokenExpiresIn block). Both
 * calls must act on the SAME module instance, so this memo sits in front of the registry's lazy
 * loader - a second require() would return the same cached module object, but a second
 * instantiation of a class-based domain would not, and that difference would only show up as
 * "tokens stopped working after I changed the secret".
 */
let authApiInstance = null;
function authApi() {
    if (!authApiInstance) { authApiInstance = require('./auth'); }
    return authApiInstance;
}

/**
 * Every REST domain, in mount order, with the arguments ITS init() takes.
 *
 * This used to be forty hand-written lines: eighteen identical `XxxApi.init(runtime, authMiddleware,
 * verifyGroups); apiApp.use(XxxApi.app());` pairs, plus three that differ. The duplications were not
 * wrong - they were unverifiable: nothing could tell you whether a domain had been registered at
 * all, and nothing could tell you whether the ORDER was still the one the domains were written
 * against. Mount order is genuinely load-bearing here: the middleware above runs first for every
 * request, express matches routes in registration order, and a sub-app mounted earlier wins.
 *
 * `args` is built lazily, per init() call, because two domains do NOT take the common trio:
 *   - auth       takes the JWT configuration instead of the group checker
 *   - reporting  takes no group checker at all
 *   - reports    is a CLASS from the compiled TypeScript service, not a plain module object, so it
 *                is instantiated here rather than required at the top of the file
 * Writing "everyone takes the same three arguments" into the loop would have been the tempting
 * simplification, and it would have silently changed how three domains authenticate.
 *
 * Adding a domain is now one line, and forgetting to add it is visible: apiRegistry.test.js reads
 * this table against the directories on disk.
 */
const API_REGISTRY = [
    { name: 'projects', load: () => require('./projects') },
    { name: 'users', load: () => require('./users') },
    { name: 'alarms', load: () => require('./alarms') },
    {
        name: 'auth',
        load: authApi,
        args: (ctx) => [ctx.runtime, authJwt.secretCode, authJwt.tokenExpiresIn,
            ctx.runtime.settings.enableRefreshCookieAuth, ctx.runtime.settings.refreshTokenExpiresIn]
    },
    { name: 'plugins', load: () => require('./plugins') },
    { name: 'diagnose', load: () => require('./diagnose') },
    { name: 'daq', load: () => require('./daq') },
    { name: 'scheduler', load: () => require('./scheduler') },
    { name: 'recipes', load: () => require('./recipes') },
    { name: 'scripts', load: () => require('./scripts') },
    { name: 'resources', load: () => require('./resources') },
    { name: 'command', load: () => require('./command') },
    { name: 'calibration', load: () => require('./calibration') },
    { name: 'cameras', load: () => require('./cameras') },
    { name: 'opcua-server', load: () => require('./opcua-server') },
    { name: 'devices', load: () => require('./devices') },
    { name: 'reports', load: () => new (require('../dist/reports.service').ReportsApiService)() },
    { name: 'apikeys', load: () => require('./apikeys') },
    {
        name: 'reporting',
        load: () => require('./reporting'),
        args: (ctx) => [ctx.runtime, ctx.authMiddleware]
    }
];
const utils = require('../runtime/utils');

const version = '1.0.0';

var apiApp;
var server;
var runtime;
/** The domains mounted by the last init(), in order. Read by apiRegistry.test.js. */
const registeredApiNames = [];

function init(_server, _runtime) {
    server = _server;
    runtime = _runtime;

    return new Promise(function (resolve, reject) {
        if (runtime.settings.disableServer !== false) {
            apiApp = express();

			if (runtime.settings.logApiLevel !== 'none') {
				apiApp.use(morgan(['combined', 'common', 'dev', 'short', 'tiny'].
				includes(runtime.settings.logApiLevel) ? runtime.settings.logApiLevel : 'combined'));
			}

            var maxApiRequestSize = runtime.settings.apiMaxLength || '100mb';
            apiApp.use(bodyParser.json({limit:maxApiRequestSize}));
            apiApp.use(bodyParser.urlencoded({limit:maxApiRequestSize, extended: true}));
            authJwt.init(runtime.settings.secureEnabled, runtime.settings.secretCode, runtime.settings.tokenExpiresIn);
            const authMiddleware = verifyApiOrToken(runtime);

            const authLimiter = rateLimit({
                windowMs: runtime.settings.authRateLimitWindowMs || 5 * 60 * 1000,
                max: runtime.settings.authRateLimitMax || 100,
                skip: (req) => req.path !== '/api/signin' && req.path !== '/api/refresh'
            });

            const limiter = rateLimit({
                windowMs: runtime.settings.apiRateLimitWindowMs || 5 * 60 * 1000,
                max: runtime.settings.apiRateLimitMax || 1000,
                skip: (req) => req.path === '/api/version'
            });

            // Apply before route handlers so sub-routers are covered too.
            apiApp.use(authLimiter);
            apiApp.use(limiter);

            // Mounted in the order the table declares. The common trio is the default; a domain
            // that needs different arguments says so in its own entry.
            const mountContext = { runtime: runtime, authMiddleware: authMiddleware, verifyGroups: verifyGroups };
            registeredApiNames.length = 0;
            API_REGISTRY.forEach((entry) => {
                const apiModule = entry.load();
                const initArgs = entry.args ? entry.args(mountContext)
                    : [runtime, authMiddleware, verifyGroups];
                apiModule.init.apply(apiModule, initArgs);
                apiApp.use(apiModule.app());
                registeredApiNames.push(entry.name);
            });

            apiApp.use((err, req, res, next) => {
                if (err?.type === 'entity.too.large') {
                    return res.status(413).json({
                        message: `The submitted content exceeds the maximum allowed size (${maxApiRequestSize})`
                    });
                }
                next(err);
            });

            /**
             * GET Server setting data
             */
            apiApp.get('/api/version', function (req, res) {
                res.json(version);
            });

            /**
             * GET Server setting data
             */
            apiApp.get('/api/settings', authMiddleware, function (req, res) {
                if (runtime.settings) {
                    const permission = verifyGroups(req);
                    const tosend = authJwt.haveAdminPermission(permission)
                        ? getSanitizedSettings(runtime.settings)
                        : getPublicSettings(runtime.settings);
                    // res.header("Access-Control-Allow-Origin", "*");
                    // res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                    res.json(tosend);
                } else {
                    res.status(404).end();
                    runtime.logger.error('api get settings: Value Not Found!');
                }
            });

            /**
             * POST Server user settings
             */
            apiApp.post("/api/settings", authMiddleware, function(req, res, next) {
                const permission = verifyGroups(req);
                if (res.statusCode === 403) {
                    runtime.logger.error("api post settings: Tocken Expired");
                } else if (!authJwt.haveAdminPermission(permission)) {
                    res.status(401).json({error:"unauthorized_error", message: "Unauthorized!"});
                    runtime.logger.error("api post settings: Unauthorized");
                } else {
                    try {
                        if (req.body.smtp && !req.body.smtp.password && runtime.settings.smtp && runtime.settings.smtp.password) {
                            req.body.smtp.password = runtime.settings.smtp.password;
                        }
                        if (utils.isEmptyObject(req.body.daqstore?.credentials) && runtime.settings.daqstore?.credentials) {
                            req.body.daqstore.credentials = runtime.settings.daqstore?.credentials;
                        }
                        if (!req.body.secretCode && runtime.settings.secretCode) {
                            req.body.secretCode = runtime.settings.secretCode;
                        }
                        if (req.body.secureEnabled && !req.body.secretCode) {
                            req.body.secretCode = utils.generateSecretCode();
                            runtime.logger.warn('Generated random JWT secret because secureEnabled=true and no secretCode was provided.');
                        }
                        const prevAuth = {
                            secureEnabled: runtime.settings.secureEnabled,
                            tokenExpiresIn: runtime.settings.tokenExpiresIn,
                            enableRefreshCookieAuth: runtime.settings.enableRefreshCookieAuth,
                            refreshTokenExpiresIn: runtime.settings.refreshTokenExpiresIn,
                            secretCode: runtime.settings.secretCode
                        };
                        if (req.body.nodeRedEnabled === true &&
                            utils.isNullOrUndefined(req.body.nodeRedAuthMode) &&
                            runtime.settings.nodeRedEnabled === false) {
                            req.body.nodeRedAuthMode = 'secure';
                        }
                        fs.writeFileSync(runtime.settings.userSettingsFile, JSON.stringify(req.body, null, 4));
                        mergeUserSettings(req.body);
                        if (prevAuth.secureEnabled !== runtime.settings.secureEnabled ||
                            prevAuth.tokenExpiresIn !== runtime.settings.tokenExpiresIn ||
                            prevAuth.enableRefreshCookieAuth !== runtime.settings.enableRefreshCookieAuth ||
                            prevAuth.refreshTokenExpiresIn !== runtime.settings.refreshTokenExpiresIn ||
                            prevAuth.secretCode !== runtime.settings.secretCode) {
                            authJwt.init(runtime.settings.secureEnabled, runtime.settings.secretCode, runtime.settings.tokenExpiresIn);
                            authApi().init(runtime, authJwt.secretCode, authJwt.tokenExpiresIn, runtime.settings.enableRefreshCookieAuth, runtime.settings.refreshTokenExpiresIn);
                        }
                        runtime.restart(true).then(function(result) {
                            res.end();
                        }).catch(err => {
                            // 90-AF: settings save could hang forever on restart failure.
                            res.status(500).json({ error: 'restart_failed', message: String(err) });
                            runtime.logger.error('api post settings: restart failed ' + err);
                        });
                    } catch (err) {
                        res.status(400).json({ error: "unexpected_error", message: err });
                        runtime.logger.error("api post settings: " + err);
                    }
                }
            });

            /**
             * GET Heartbeat to check token
             */
            apiApp.post('/api/heartbeat', authMiddleware, async function (req, res) {

                if (!runtime.settings.secureEnabled) {
                    return res.end();
                }

                if (req.body.params) {

                    if (!req.isAuthenticated) {
                        // guest → NON puo rinnovare token
                        return res.status(200).json({
                            message: 'guest'
                        });
                    }

                    const currentUser = await getCurrentTokenUser(req);
                    if (currentUser === undefined) {
                        // The identity store failed. Saying 401 here would tell the client its
                        // credentials are void, and a client that believes that forces a re-login.
                        return res.status(503).json({
                            error: 'identity_store_unavailable',
                            message: 'Could not read the user record: the token was not refused, it could not be checked.'
                        });
                    }
                    if (!currentUser) {
                        // A domain code, matching the sibling branch six lines up: that one already
                        // answers 'identity_store_unavailable' rather than the platform-wide
                        // 'unauthorized_error' (N-23). The 401 is unchanged, so a client that keys
                        // on the status still sees exactly what it saw before.
                        return res.status(401).json({
                            error: 'heartbeat_user_not_found',
                            message: 'The token is valid but its user no longer exists, so no new token was issued.'
                        });
                    }

                    req.userGroups = currentUser.groups;
                    const token = authJwt.getNewTokenFromRequest(req);
                    return res.status(200).json({
                        message: 'tokenRefresh',
                        token,
                        data: currentUser
                    });
                }

                // Guest heartbeat
                if (req.userId === 'guest') {
                    return res.status(200).json({
                        message: 'guest',
                        token: authJwt.getGuestToken()
                    });
                }

                return res.end();
            });

            runtime.logger.info('api: init successful!', true);
        } else {
        }
        resolve();
    });
}

function getPublicSettings(settings) {
    const tosend = getSanitizedSettings(settings);
    if (tosend.smtp) {
        delete tosend.smtp.host;
        delete tosend.smtp.port;
        delete tosend.smtp.username;
    }
    if (tosend.daqstore) {
        delete tosend.daqstore.url;
        delete tosend.daqstore.host;
    }
    return tosend;
}

function getSanitizedSettings(settings) {
    const tosend = utils.clone(settings);
    delete tosend.secretCode;
    if (tosend.smtp) {
        delete tosend.smtp.password;
    }
    if (tosend.daqstore?.credentials) {
        delete tosend.daqstore.credentials;
    }
    return tosend;
}

function mergeUserSettings(settings) {
    if (settings.language) {
        runtime.settings.language = settings.language;
    }
    if (!utils.isNullOrUndefined(settings.hideEditorOnboarding)) {
        runtime.settings.hideEditorOnboarding = settings.hideEditorOnboarding;
    }
    if (settings.editorSectionMessages) {
        runtime.settings.editorSectionMessages = Object.assign(
            {},
            runtime.settings.editorSectionMessages || {},
            settings.editorSectionMessages
        );
    }
    runtime.settings.broadcastAll = settings.broadcastAll;
    if (!utils.isNullOrUndefined(settings.lazyViewLoading)) {
        runtime.settings.lazyViewLoading = settings.lazyViewLoading;
    }
    if (!utils.isNullOrUndefined(settings.apiRateLimitWindowMs)) {
        runtime.settings.apiRateLimitWindowMs = settings.apiRateLimitWindowMs;
    }
    if (!utils.isNullOrUndefined(settings.apiRateLimitMax)) {
        runtime.settings.apiRateLimitMax = settings.apiRateLimitMax;
    }
    if (!utils.isNullOrUndefined(settings.authRateLimitWindowMs)) {
        runtime.settings.authRateLimitWindowMs = settings.authRateLimitWindowMs;
    }
    if (!utils.isNullOrUndefined(settings.authRateLimitMax)) {
        runtime.settings.authRateLimitMax = settings.authRateLimitMax;
    }
    runtime.settings.secureEnabled = settings.secureEnabled;
    runtime.settings.logFull = settings.logFull;
    runtime.settings.userRole = settings.userRole;
    runtime.settings.nodeRedEnabled = settings.nodeRedEnabled;
    if (!utils.isNullOrUndefined(settings.nodeRedAuthMode)) {
        runtime.settings.nodeRedAuthMode = settings.nodeRedAuthMode;
    }
    if (!utils.isNullOrUndefined(settings.enableRefreshCookieAuth)) {
        runtime.settings.enableRefreshCookieAuth = settings.enableRefreshCookieAuth;
    }
    if (!utils.isNullOrUndefined(settings.refreshTokenExpiresIn)) {
        runtime.settings.refreshTokenExpiresIn = settings.refreshTokenExpiresIn;
    }
    if (!utils.isNullOrUndefined(settings.nodeRedUnsafeModules)) {
        runtime.settings.nodeRedUnsafeModules = settings.nodeRedUnsafeModules;
    }
    runtime.settings.swaggerEnabled = settings.swaggerEnabled;
    if (settings.secretCode) {
        runtime.settings.secretCode = settings.secretCode;
    }
    if (settings.secureEnabled) {
        runtime.settings.tokenExpiresIn = settings.tokenExpiresIn;
        runtime.settings.enableRefreshCookieAuth = settings.enableRefreshCookieAuth;
        runtime.settings.refreshTokenExpiresIn = settings.refreshTokenExpiresIn;
    }
    if (settings.smtp) {
        runtime.settings.smtp = settings.smtp;
    }
    if (settings.daqstore) {
        runtime.settings.daqstore = settings.daqstore;
    }
    if (settings.alarms) {
        runtime.settings.alarms = settings.alarms;
    }
    if (settings.logs) {
        runtime.settings.logs = settings.logs;
    }
}

/**
 * The stored identity behind a token, for the heartbeat's token refresh.
 *
 * THREE ANSWERS, and the distinction is the point:
 *
 *   an object   the user exists and its stored groups are usable
 *   null        a MISS - no such user, or one with no groups. The token must not be reissued, and
 *               the caller answers 401. That is the "deleted user" case and it is correct.
 *   undefined   a FAILURE - the user store threw. The caller answers 503 and keeps the client
 *               logged in, because the credentials are fine and the server is not.
 *
 * The previous version collapsed the last two: a throwing store was logged and then answered null,
 * so the heartbeat replied 401 Unauthorized. A client that receives 401 on a token refresh treats
 * the session as void - it forces a re-login, or logs the operator out mid-shift - because the
 * server said the token is bad. It was not: the database was.
 *
 * @param {*} req
 * @returns {Promise<object|null|undefined>}
 */
async function getCurrentTokenUser(req) {
    if (!req.isAuthenticated || authJwt.isGuestUser(req.userId, req.userGroups)) {
        return null;
    }

    let users;
    try {
        users = await runtime.users.getUsers({ username: req.userId });
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        runtime.logger.error('api heartbeat: user lookup FAILED (store unavailable), not treating the ' +
            'session as unauthenticated: ' + message);
        return undefined;
    }

    if (users && users.length && !utils.isNullOrUndefined(users[0].groups)) {
        return {
            username: users[0].username,
            fullname: users[0].fullname,
            groups: users[0].groups,
            info: users[0].info
        };
    }

    return null;
}

function verifyGroups(req) {
    if (runtime.settings && runtime.settings.secureEnabled) {
        if (req.apiKey) {
            return authJwt.adminGroups[0];
        }
        if (req.tokenExpired) {
            return (runtime.settings.userRole) ? null : 0;
        }
        const userInfo = runtime.users.getUserCache(req.userId);
        if (req.isAuthenticated && !authJwt.isGuestUser(req.userId, req.userGroups) && !userInfo) {
            return null;
        }
        return (runtime.settings.userRole && req.userId !== 'admin') ? userInfo : userInfo ? userInfo.groups : req.userGroups;
    } else {
        return authJwt.adminGroups[0];
    }
}

function start() {
}

function stop() {
}

module.exports = {
    init: init,
    start: start,
    stop: stop,

    get apiApp() { return apiApp; },
    get server() { return server; },
    get authJwt() { return authJwt; },
    _getPublicSettings: getPublicSettings,
    _getSanitizedSettings: getSanitizedSettings
};
