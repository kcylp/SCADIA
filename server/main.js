const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const nopt = require("nopt");
const schedule = require('node-schedule');
const jwt = require('jsonwebtoken');

const paths = require('./paths');
const logger = require('./runtime/logger');
const utils = require('./runtime/utils');
var events = require("./runtime/events").create();
const SCADIA = require('./scadia.js');
const runtime = require('./runtime');
const authJwt = require('./api/jwt-helper');

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const express = require('express');
const app = express();

var server;
var settingsFile;

var startTime = new Date();

var knownOpts = {
    "help": Boolean,
    "port": Number,
    "userDir": [path]
};
var shortHands = {
    "?": ["--help"],
    "p": ["--port"],
    "u": ["--userDir"]
};

nopt.invalidHandler = function (k, v, t) {
    // TODO: console.log(k,v,t);
}

var parsedArgs = nopt(knownOpts, shortHands, process.argv, 2);

if (parsedArgs.help) {
    console.log("SCADIA v" + SCADIA.version());
    console.log("Usage: scadia [-?] [--port PORT] [--userDir DIR]");
    console.log("");
    console.log("Options:");
    console.log("  -p, --port     PORT  port to listen on");
    console.log("  -u, --userDir  DIR   use specified user directory");
    console.log("  -?, --help           show this help");
    process.exit();
}

// Define directory
var rootDir = __dirname;
var workDir = path.resolve(process.cwd(), '_appdata');

if (process.env.userDir) {
    rootDir = process.env.userDir;
    workDir = path.resolve(process.env.userDir, '_appdata');
}

if (parsedArgs.userDir) {
    rootDir = parsedArgs.userDir;
    workDir = path.resolve(parsedArgs.userDir, '_appdata');
}

if (parsedArgs.env) {
    require('./envParams.js');
}

if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir);
}

// Read app settings
var appSettingsFile = path.join(workDir, 'settings.js');
if (fs.existsSync(appSettingsFile)) {
    settingsFile = appSettingsFile;
} else {
    var defaultSettings = path.join(__dirname, 'settings.default.js');
    try {
        fs.copyFileSync(defaultSettings, appSettingsFile, fs.constants.COPYFILE_EXCL);
        logger.debug('settings.js default created successful!');
    } catch (err) {
        logger.error(err);
    }
    settingsFile = appSettingsFile;
}
try {
    var settings = require(settingsFile);
    var defSettings = require(path.join(__dirname, 'settings.default.js'));
    if (defSettings.version !== settings.version) {
        logger.warn("Settings are outdated. Missing fields have been merged from defaults. Consider reviewing 'settings.json'.");
        settings = utils.deepMerge(defSettings, settings);
    }

    settings.workDir = workDir;
    settings.appDir = __dirname;
    settings.packageDir = path.resolve(rootDir, '_pkg');
    settings.settingsFile = settingsFile;
    settings.environment = process.env.NODE_ENV || 'prod';
    settings.uploadFileDir = '_upload_files';
    settings.imagesFileDir = path.resolve(rootDir, '_images');
    settings.widgetsFileDir = path.resolve(rootDir, '_widgets');
    // The built-in asset library belongs to the SOFTWARE, not to the site: it hangs off appDir,
    // so it is present for every project and every userDir. Read-only at runtime.
    settings.assetsDir = path.join(settings.appDir, '_assets');
    settings.reportsDir = path.resolve(rootDir, '_reports');
    settings.webcamSnapShotsDir = path.resolve(rootDir, settings.webcamSnapShotsDir);
    settings.logDir = path.resolve(rootDir, settings.logDir);
    settings.dbDir = path.resolve(rootDir, settings.dbDir || '_db');
} catch (err) {
    logger.error('Error loading settings file: ' + settingsFile)
    if (err.code == 'MODULE_NOT_FOUND') {
        if (err.toString().indexOf(settingsFile) === -1) {
            logger.error(err.toString());
        }
    } else {
        logger.error(err);
    }
    process.exit();
}
// Read user settings
try {
    var userSettingsFile = path.join(workDir, 'mysettings.json');
    settings.userSettingsFile = userSettingsFile;
    if (fs.existsSync(userSettingsFile)) {
        var mysettings = JSON.parse(fs.readFileSync(userSettingsFile, 'utf8'));
        if (mysettings.language) {
            settings.language = mysettings.language;
        }
        if (!utils.isNullOrUndefined(mysettings.hideEditorOnboarding)) {
            settings.hideEditorOnboarding = mysettings.hideEditorOnboarding;
        }
        if (mysettings.editorSectionMessages) {
            settings.editorSectionMessages = Object.assign(
                {},
                settings.editorSectionMessages || {},
                mysettings.editorSectionMessages
            );
        }
        if (mysettings.uiPort) {
            settings.uiPort = mysettings.uiPort;
        }
        if (!utils.isNullOrUndefined(mysettings.secureEnabled)) {
            settings.secureEnabled = mysettings.secureEnabled;
            if (!settings.tokenExpiresIn) {
                settings.tokenExpiresIn = '1h';
            }
        }
        if (!utils.isNullOrUndefined(mysettings.secureOnlyEditor)) {
            settings.secureOnlyEditor = mysettings.secureOnlyEditor;
        }
        if (mysettings.tokenExpiresIn) {
            settings.tokenExpiresIn = mysettings.tokenExpiresIn;
        }
        if (!utils.isNullOrUndefined(mysettings.enableRefreshCookieAuth)) {
            settings.enableRefreshCookieAuth = mysettings.enableRefreshCookieAuth;
        }
        if (mysettings.refreshTokenExpiresIn) {
            settings.refreshTokenExpiresIn = mysettings.refreshTokenExpiresIn;
        }
        if (mysettings.secretCode) {
            settings.secretCode = mysettings.secretCode;
        }
        if (mysettings.smtp) {
            settings.smtp = mysettings.smtp;
        }
        if (mysettings.daqstore) {
            settings.daqstore = mysettings.daqstore;
        }
        if (mysettings.alarms) {
            settings.alarms = mysettings.alarms;
        }
        if (mysettings.logs) {
            settings.logs = mysettings.logs;
        }
        if (!utils.isNullOrUndefined(mysettings.broadcastAll)) {
            settings.broadcastAll = mysettings.broadcastAll;
        }
        if (!utils.isNullOrUndefined(mysettings.lazyViewLoading)) {
            settings.lazyViewLoading = mysettings.lazyViewLoading;
        }
        if (!utils.isNullOrUndefined(mysettings.logFull)) {
            settings.logFull = mysettings.logFull;
        }
        if (!utils.isNullOrUndefined(mysettings.userRole)) {
            settings.userRole = mysettings.userRole;
        }
        if (!utils.isNullOrUndefined(mysettings.nodeRedEnabled)) {
            settings.nodeRedEnabled = mysettings.nodeRedEnabled;
        }
        if (!utils.isNullOrUndefined(mysettings.nodeRedAuthMode)) {
            settings.nodeRedAuthMode = mysettings.nodeRedAuthMode;
        }
        if (!utils.isNullOrUndefined(mysettings.swaggerEnabled)) {
            settings.swaggerEnabled = mysettings.swaggerEnabled;
        }
        if (mysettings.nodeRedEnabled === true && utils.isNullOrUndefined(mysettings.nodeRedAuthMode)) {
            settings.nodeRedAuthMode = 'legacy-open';
        }

        /**
         * Everything the UI saves, honestly re-loaded.
         *
         * The block above is a hand-written list of twenty-two keys, and it was the ONLY thing read
         * back out of mysettings.json. Anything absent from that list was written by POST /api/settings,
         * shown as "on" in the UI, and then silently ignored on the next start - the file said one
         * thing and the runtime did another, with no error anywhere. Thirty-five keys fell through,
         * including EVERY opt-in subsystem block: ai, mediaServer, gb28181, opcuaServer, calibration.
         * Measured: ai.enabled was true in mysettings.json and the service still logged
         * "ai: disabled (settings.ai.enabled = false)" on every boot, so 煤矿 AI 视频分析 could not be
         * switched on at all on this build.
         *
         * So: copy the rest, minus the keys the server DERIVES for itself. Those must never be taken
         * from a file, or a stale path/port in the user's settings would override the layout that is
         * actually running (the code below recomputes them all).
         */
        const DERIVED_AT_BOOT = [
            'version', 'workDir', 'appDir', 'packageDir', 'settingsFile', 'userSettingsFile',
            'environment', 'uploadFileDir', 'imagesFileDir', 'widgetsFileDir', 'assetsDir',
            'reportsDir', 'httpStatic', 'httpUploadFileStatic', 'uiHost', 'serverPort',
            'logDir', 'dbDir'
        ];
        const alreadyRead = [
            'language', 'hideEditorOnboarding', 'editorSectionMessages', 'uiPort', 'secureEnabled',
            'secureOnlyEditor', 'tokenExpiresIn', 'enableRefreshCookieAuth', 'refreshTokenExpiresIn',
            'secretCode', 'smtp', 'daqstore', 'alarms', 'logs', 'broadcastAll', 'lazyViewLoading',
            'logFull', 'userRole', 'nodeRedEnabled', 'nodeRedAuthMode', 'swaggerEnabled'
        ];
        Object.keys(mysettings).forEach((key) => {
            if (DERIVED_AT_BOOT.indexOf(key) >= 0 || alreadyRead.indexOf(key) >= 0) { return; }
            if (utils.isNullOrUndefined(mysettings[key])) { return; }
            settings[key] = mysettings[key];
        });
    }
} catch (err) {
    logger.error('Error loading user settings file: ' + userSettingsFile)
}

// Ensure secure mode never runs with an empty/static-known JWT secret.
if (settings.secureEnabled && !settings.secretCode) {
    settings.secretCode = utils.generateSecretCode();
    logger.warn('Generated a random JWT secret in memory because secureEnabled=true and secretCode was missing. Persist it in settings for stable sessions across restarts.');
}

// Check logger
if (!settings.logDir) {
    settings.logDir = path.resolve(rootDir, '_logs');
}
if (!fs.existsSync(settings.logDir)) {
    fs.mkdirSync(settings.logDir);
}

logger.init(settings);
const version = SCADIA.version();
if (version.indexOf('beta') > 0) {
    logger.warn('SCADIA V.' + version);
} else {
    logger.info('SCADIA V.' + version);
}

// Check storage Database dir
if (!fs.existsSync(settings.dbDir)) {
    fs.mkdirSync(settings.dbDir);
}
// Check package folder
if (!fs.existsSync(settings.packageDir)) {
    fs.mkdirSync(settings.packageDir);
}
// Check reports folder
if (!fs.existsSync(settings.reportsDir)) {
    fs.mkdirSync(settings.reportsDir);
}
// Check upload file folder
settings.httpUploadFileStatic = 'resources';
settings.uploadFileDir = path.resolve(workDir, settings.uploadFileDir);
if (!fs.existsSync(settings.uploadFileDir)) {
    fs.mkdirSync(settings.uploadFileDir);
}
// Check images resources folder
settings.imagesFileDir = path.resolve(rootDir, '_images');
if (!fs.existsSync(settings.imagesFileDir)) {
    fs.mkdirSync(settings.imagesFileDir);
}
// Check widgets resources folder
settings.widgetsFileDir = path.resolve(rootDir, '_widgets');
if (!fs.existsSync(settings.widgetsFileDir)) {
    fs.mkdirSync(settings.widgetsFileDir);
}
// The built-in asset library ships WITH the software, so it is deliberately not created on
// demand: an empty folder would hide the fact that an install is missing its artwork. A
// library that is absent is reported, and the screens that use it will show blanks.
settings.assetsDir = path.join(settings.appDir, '_assets');
if (!fs.existsSync(settings.assetsDir)) {
    logger.warn("Built-in asset library not found at '" + settings.assetsDir + "': screens that use library artwork will render blanks.");
}
// Check webcam shots  folder
settings.webcamSnapShotsDir = path.resolve(rootDir, settings.webcamSnapShotsDir);
if (!fs.existsSync(settings.webcamSnapShotsDir)) {
    fs.mkdirSync(settings.webcamSnapShotsDir);
}

// Server settings
if (settings.https) {
    server = https.createServer(settings.https, app);
} else {
    server = http.createServer(app);
}
server.setMaxListeners(0);

const io = socketIO(server, {
    pingInterval: 60000,
    pingTimeout: 120000,
    allowEIO3: true,
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: false
    },
    path: BASE_PATH + '/socket.io',
});

// Check settings value
var www = path.resolve(__dirname, '../client/dist');
if (!fs.existsSync(www)) {
    www = path.resolve(__dirname, './dist');
}

settings.httpStatic = settings.httpStatic || www;

// In-memory BASE_PATH, rewrites the in-memory copy to work with read-only deployments
let indexHtmlCache = null;
const rewrittenAssets = new Map();

if (BASE_PATH) {
    try {
        const indexHtmlPath = path.join(settings.httpStatic, 'index.html');
        const desiredBase = (BASE_PATH || '') + '/';
        const withBase = fs.readFileSync(indexHtmlPath, 'utf8')
            .replace(/<base href="[^"]*"\s*\/?>/, `<base href="${desiredBase}" />`);
        const bootstrap = `<script>window.__BASE_PATH__=${JSON.stringify(BASE_PATH)};</script>`;
        indexHtmlCache = withBase.replace('</head>', `${bootstrap}</head>`);
    } catch (err) {
        logger.warn('Could not prepare <base href> from BASE_PATH: ' + err);
    }
    const collectAssets = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { collectAssets(full); }
            else if (/\.(js|css)$/.test(e.name)) {
                const src = fs.readFileSync(full, 'utf8');
                const out = src.replace(/(["'(])\/assets\//g, `$1${BASE_PATH}/assets/`);
                if (out !== src) {
                    const reqPath = BASE_PATH + '/' + path.relative(settings.httpStatic, full).split(path.sep).join('/');
                    rewrittenAssets.set(reqPath, { content: out, type: e.name.endsWith('.css') ? 'text/css' : 'application/javascript' });
                }
            }
        }
    };
    try { collectAssets(settings.httpStatic); }
    catch (err) { logger.warn('asset base-path rewrite failed: ' + err); }
}

if (parsedArgs.port !== undefined) {
    settings.uiPort = parsedArgs.port;
} else {
    if (settings.uiPort === undefined) {
        settings.uiPort = 1881;
    }
}
settings.uiHost = settings.uiHost || "0.0.0.0";

// Wait ending initialization
events.once('init-runtime-ok', function () {
    logger.info('SCADIA init in  ' + utils.endTime(startTime) + 'ms.');
    startScadia();
    initWebcamSnapshotCleanup();
});

// Init SCADIA
try {
    SCADIA.init(server, io, settings, logger, events);
} catch (err) {
    if (err.code == 'unsupported_version') {
        logger.error('Unsupported version of node.js:', process.version);
        logger.error('SCADIA requires node.js v20 or later');
    } else if (err.code == 'not_built') {
        logger.error('SCADIA has not been built. See README.md for details');
    } else {
        logger.error('Failed to start server:');
        if (err.stack) {
            logger.error(err.stack);
        } else {
            logger.error(err);
        }
    }
    process.exit(1);
}

// Http Server for client UI
const allowCrossDomain = function (req, res, next) {
    const origin = req.headers.origin;
    const allowedOrigins = settings.allowedOrigins || ["*"];

    const isOriginAllowed = (origin) => {
        if (!origin) return false;
        if (allowedOrigins.includes("*")) return true;

        const regexPattern = new RegExp(
            "^" + allowedOrigins
                .filter(p => p.includes("*"))
                .map(p => "^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$")
                .join("|") + "$"
        );
        return allowedOrigins.some(pattern => {
            if (!pattern.includes("*")) return pattern === origin;
            return regexPattern.test(origin);
        });
    };

    if (isOriginAllowed(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
        if (settings.enableRefreshCookieAuth || settings.nodeRedEnabled) {
            res.header('Access-Control-Allow-Credentials', 'true');
        }
    }

    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'x-access-token, x-auth-user, Origin, Content-Type, Accept, Skip-Auth, Skip-Error');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
};

function getCookieValue(req, name) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
        return null;
    }
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
        const [key, ...rest] = cookie.trim().split('=');
        if (key === name) {
            return decodeURIComponent(rest.join('='));
        }
    }
    return null;
}

function snapshotAuth(req, res, next) {
    if (!settings.secureEnabled) {
        return next();
    }

    const token = req.query?.token || req.headers['x-access-token'] || getCookieValue(req, 'scadia_access');
    if (!token || token === 'null') {
        return res.status(401).end();
    }

    try {
        const decoded = jwt.verify(token, authJwt.secretCode);
        if (!decoded?.id || authJwt.isGuestUser(decoded.id, decoded.groups)) {
            return res.status(401).end();
        }
        res.header('Cache-Control', 'no-store');
        return next();
    } catch {
        return res.status(401).end();
    }
}

// All the calls that are directly parsed as static http are mapped here.
// Every client route in source/client/src/app/app.routing.ts must be listed here, because
// this is the only place that answers a client route with index.html. A route the Angular
// router knows but this table does not is reachable by in-app navigation only: a reload, a
// bookmark, a shared link or a popup window hits the server directly and gets a 404 body,
// which the browser paints as a blank page. Keep the two lists in step.
const SHELL_ROUTES = [
    '/',
    '/home',
    '/home/:viewName',
    '/view',
    '/editor',
    '/lab',
    '/device',
    '/rodevice',
    '/users',
    '/userRoles',
    '/alarms',
    '/messages',
    '/notifications',
    '/scripts',
    '/recipes',
    '/calibrations',
    '/calibrations/:id',
    '/cameras',
    '/video',
    '/mes',
    '/ems',
    '/reports',
    '/language',
    '/logs',
    '/events',
    '/mapsLocations',
    '/flows',
    '/apikeys',
    '/plugins',
    '/arMarkers',
    '/ar'
];

app.use(allowCrossDomain);

if (indexHtmlCache) {
    const serveShell = (req, res) => res.type('html').send(indexHtmlCache);
    for (const shellPath of SHELL_ROUTES) {
        app.get(BASE_PATH + shellPath, serveShell);
    }
}
if (rewrittenAssets.size) {
    app.use((req, res, next) => {
        const rewritten = rewrittenAssets.get(req.path);
        rewritten ? res.type(rewritten.type).send(rewritten.content) : next();
    });
}

for (const shellPath of SHELL_ROUTES) {
    app.use(BASE_PATH + shellPath, express.static(settings.httpStatic));
}
app.use(BASE_PATH + '/' + settings.httpUploadFileStatic, express.static(settings.uploadFileDir));
app.use(BASE_PATH + '/_images', express.static(settings.imagesFileDir));
app.use(BASE_PATH + '/_widgets', express.static(settings.widgetsFileDir));
// The built-in asset library: manifest.json and the artwork it describes.
app.use(BASE_PATH + '/_assets', express.static(settings.assetsDir));
app.use(BASE_PATH + '/snapshots', snapshotAuth, express.static(settings.webcamSnapShotsDir));

var accessLogStream = fs.createWriteStream(settings.logDir + '/api.log', { flags: 'a' });
if (runtime.settings.logApiLevel !== 'none') {
    app.use(morgan('combined', {
        stream: accessLogStream,
        skip: function (req, res) { return res.statusCode < 400 }
    }));

    app.use(morgan('dev', {
        skip: function (req, res) {
            return res.statusCode < 400
        }, stream: process.stderr
    }));

    app.use(morgan('dev', {
        skip: function (req, res) {
            return res.statusCode >= 400
        }, stream: process.stdout
    }));
}

function mountSwaggerIfEnabled() {
    const swaggerEnabled = settings.swagger || settings.swaggerEnabled;
    if (!swaggerEnabled) return;

    let swaggerUi;
    let YAML;
    try {
        swaggerUi = require('swagger-ui-express');
        YAML = require('yamljs');
    } catch (err) {
        if (err && err.code !== 'MODULE_NOT_FOUND') {
            throw err;
        }
        logger.warn('[Swagger] Enabled but optional dependencies are missing; skipping /api-docs.');
        return;
    }

    const swaggerDocument = YAML.load(path.join(__dirname, 'docs', 'openapi.yaml'));
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

try {
    mountSwaggerIfEnabled();
} catch (err) {
    logger.warn('Swagger UI failed to initialize', err);
}

function getListenPath() {
    var port = settings.serverPort;
    if (port === undefined) {
        port = settings.uiPort;
    }

    var listenBasePath = BASE_PATH || '';
    var listenPath = 'http' + (settings.https ? 's' : '') + '://' +
        (settings.uiHost == '::' ? 'localhost' : (settings.uiHost == '0.0.0.0' ? '127.0.0.1' : settings.uiHost)) +
        ':' + port + listenBasePath;
    if (settings.httpStatic) {
        listenPath += '/';
    }
    return listenPath;
}

let mountNodeRedIfInstalled;
if (settings.nodeRedEnabled) {
    ({ mountNodeRedIfInstalled } = require('./integrations/node-red'));
}

// Start SCADIA
function startScadia() {
    SCADIA.start().then(async () => {
        if (settings.httpStatic) {
            server.on('error', function (err) {
                if (err.errno === 'EADDRINUSE') {
                    logger.error('server.port-in-use');
                    logger.error('server.unable-to-listen ', { listenpath: getListenPath() });
                } else {
                    if (err.stack) {
                        logger.error(err.stack);
                    } else {
                        logger.error(err);
                    }
                }
                process.exit(1);
            });

            if (settings.nodeRedEnabled && typeof mountNodeRedIfInstalled === 'function') {
                try {
                    await mountNodeRedIfInstalled({ app, server, settings, runtime, logger, authJwt, events });
                } catch (e) {
                    logger.warn('[Node-RED] Failed to initialize, continuing without it.', e);
                }
            } else if (settings.nodeRedEnabled) {
                logger.warn('[Node-RED] Enabled but integration not available; continuing without it.');
            }

            if (settings.disableServer !== false) {
                app.use(BASE_PATH + '/', SCADIA.httpApi);
            }

            server.listen(settings.uiPort, settings.uiHost, function () {
                settings.serverPort = server.address().port;
                process.title = 'SCADIA';
                logger.info('WebServer is running ' + getListenPath());
            });
        } else {
            logger.info('server.headless-mode');
        }
    }).catch(function (err) {
        logger.error('server.failed-to-start');
        if (err) {
            if (err.stack) {
                logger.error(err.stack);
            } else {
                logger.error(err);
            }
        }
    });
}

const initWebcamSnapshotCleanup = () => {
    if (!settings.webcamSnapShotsCleanup) {
        return;
    }

    schedule.scheduleJob('0 1 * * *', cleanupSnapShotsFiles);
    logger.info('Scheduled webcam snapshot cleanup at 01:00 daily.');
};

const cleanupSnapShotsFiles = async () => {
    if (!settings.webcamSnapShotsCleanup) {
        return;
    }

    try {
        const now = Date.now();
        const retentionMillis = settings.webcamSnapShotsRetain * 24 * 60 * 60 * 1000;
        const files = await fs.promises.readdir(settings.webcamSnapShotsDir);
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(settings.webcamSnapShotsDir, file);
            try {
                const stat = await fs.promises.stat(filePath);
                if (stat.mtime && (now - stat.mtimeMs > retentionMillis)) {
                    await fs.promises.unlink(filePath);
                    deletedCount++;
                }
            } catch (fileErr) {
                logger.error(`Failed to process snapshot file: ${filePath}`, fileErr);
            }
        }

        logger.info(`Snapshot cleanup completed. ${deletedCount} old file(s) deleted.`);
    } catch (err) {
        logger.error('Error during webcam snapshot cleanup', err);
    }
};

setTimeout(() => {
    events.emit('init-runtime-ok');
}, 60000);

process.on('uncaughtException', function (err) {
    logger.error(err.stack || err);
});

process.on('SIGINT', function () {
    SCADIA.stop().then(function () {
        process.exit();
    });
    logger.info('SCADIA end!');
    process.exit();
});
