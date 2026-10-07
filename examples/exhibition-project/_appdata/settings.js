
module.exports = {
    // Version to manage update
    // 2026-09-29: bumped 1.4 -> 2.0 to match settings.default.js.
    // The mismatch made main.js enter its "outdated settings" merge path, which used to
    // crash the server on startup (see runtime/utils.js deepMerge and the accompanying
    // test). That crash is fixed; keeping the versions equal simply avoids the path.
    version: 2.0,

    // Standard language (editor)
    language: 'zh-cn',

    // Hide the editor onboarding wizard when entering editor mode
    hideEditorOnboarding: false,

    // Per-section informational messages for editor areas
    editorSectionMessages: {
        hideDevicePluginsNotice: false
    },

    // The tcp port that the SCADIA web server is listening on
    uiPort: process.env.PORT || 1881,

    // Used to identify a directory of logger
    // Default: '_logs'
    logDir: '_logs',

    // logApiLevel Configuration for Morgan Logging
    //
    // This configuration determines the format of logging by Morgan, indirectly acting as a 'level' of logging detail.
    // The setting influences which predefined format or custom function Morgan uses to log HTTP requests.
    //
    // Possible values for logApiLevel:
    // - 'dev': Colorful and concise output for development environments, showing the method, URL, status, response length, and response time.
    // - 'combined': Apache combined log format. Very detailed, suitable for production environments.
    // - 'common': Less detailed than 'combined', omitting the referrer and user-agent.
    // - 'short': Shorter format that includes the remote address and request details.
    // - 'tiny': Minimalist format, showing just the method, URL, status, response length, and response time.
	// - 'none': Completely disables HTTP request logging to clean the console for custom debugging scripts and reduce I/O overhead.
    //
    // Default Value:
    // - 'combined': By default, logApiLevel is set to 'combined', providing detailed logs suitable for thorough tracking and analysis.
    logApiLevel: 'tiny',

    // Used to storage Database like DAQ, User
    // Default: '_db'
    dbDir: '_db',

    // DAQ Enabled
    // Default: true
    daqEnabled: true,

    // DAQ DB to Tokenizer the file and save in archive
    // Default: 24 Hours (1 Day), 0 is disabled only 1 DB file
    daqTokenizer: 24,

    // Logs retention
    logs: {
        retention: 'none'
    },

    // Tags value to be broadcast,
    // if false will be send to frontend only the tags bind to current visualized views
    // if true all configured tags will be send to frontend
    broadcastAll: false,

    // Load HMI views on demand in the frontend.
    // if false the whole project, including every view, is sent at startup
    // if true the startup project contains only view metadata and views are loaded when opened
    lazyViewLoading: false,

    // By default, server accepts connections on all IPv4 interfaces.
    // To listen on all IPv6 addresses, set uiHost to "::",
    // The following property can be used to listen on a specific interface. For
    // example, the following would only allow connections from the local machine.
    //uiHost: "127.0.0.1",

    // Used to identify a directory of static content
    // that should be served at http://localhost:1881/.
    // Default: '/client/dist'
    //httpStatic: '/usr/home/scadia/dist',

    // CORS (Cross-Origin Resource Sharing)
    // Used to enable CORS for all HTTP request
    // Please use exact origin urls for better and safe CORS (Wild Cards not Recommended)
    // "allowedOrigins": ["https://example.com", "https://dashboard.example.com"]
    // Default: ["http://localhost", "http://127.0.0.1", "http://192.168.*", "http://10.*"]
    "allowedOrigins": ["http://localhost", "http://127.0.0.1", "http://192.168.*", "http://10.*", "http://localhost:4200"],


    // The maximum size of HTTP request that will be accepted by the runtime api.
    // Default: 100mb
    //apiMaxLength: '100mb',

    // API rate limiting.
    // apiRateLimit* is intentionally generous for HMI/SCADA workloads and clients
    // behind the same proxy/NAT. authRateLimit* applies only to signin/refresh.
    apiRateLimitWindowMs: 5 * 60 * 1000,
    apiRateLimitMax: 1000,
    authRateLimitWindowMs: 5 * 60 * 1000,
    authRateLimitMax: 100,

    // Used to disable the server API used for Backend communication (Standalone application)
    // disable to use only the Editor
    //disableServer: false,

    // The following property can be used to enable HTTPS !NOT SUPPORTED NOW!
    // See http://nodejs.org/api/https.html#https_https_createserver_options_requestlistener
    // for details on its contents.
    // See the comment at the top of this file on how to load the `fs` module used by
    // this setting.
    //
    //https: {
    //    key: fs.readFileSync('privatekey.pem'),
    //    cert: fs.readFileSync('certificate.pem')
    //},

    // Used to enable security, authentication and authorization and crypt Token
    secureEnabled: true,
    secretCode: '<set-a-strong-random-secret>',
    //tokenExpiresIn: '1h',  // '1h'=1hour, 60=60seconds, '1d'=1day
    //enableRefreshCookieAuth: false, // if true, use refresh token HttpOnly cookie flow
    //refreshTokenExpiresIn: '7d' // '7d'=7days, 12h=12hours, 3600=3600seconds

    // Heartbeat interval in seconds (1-20)
    heartbeatIntervalSec: 10,

    // Enable GPIO in Raspberry
    // To enable only by Raspberry Host

    //Location to output webcam capture
    webcamSnapShotsDir: '_webcam_snapshots',
    //cleanup old snapshots Default false
    webcamSnapShotsCleanup: false,
    //snapshots retention in days
    webcamSnapShotsRetain: 7,

    swaggerEnabled: false,

    nodeRedEnabled: false,

    // Node-RED access mode: "secure" (auth required) or "legacy-open" (no auth)
    nodeRedAuthMode: "secure",

    // Node-RED: allow unsafe stdlib modules in functionGlobalContext
    // WARNING: Enabling this exposes modules like child_process/net to flows.
    nodeRedUnsafeModules: false,

    // Calibration module (开诚智枢 SCADIA 标定模块)
    // Write operations additionally require secureEnabled=true.
    calibration: {
        enabled: true,
        // master switch for ANY device write (tag or raw)
        writeEnabled: true,
        requireTwoPersonApproval: true,
        approvalTtlSeconds: 600,
        confirmationTtlSeconds: 120,
        defaultSampleCount: 8,
        defaultIntervalMs: 500,
        maxConcurrentSamplingSessions: 8,
        maxConcurrentWrites: 1,
        // raw holding-register block write: disabled until explicitly allowed
        rawWriteEnabled: false,
        rawWriteAllowlist: [
            // { deviceId: '<device-id>', start: 0, end: 31 }   // zero-based inclusive
        ],
        maxRawWriteRegisters: 123
    },


    // Media streaming gateway (视频流转发) - ZLMediaKit (browsers cannot play RTSP)
    mediaServer: {
        enabled: false,
        type: 'zlmediakit',
        apiUrl: '',
        secret: '',
        publicHost: '',
        httpPort: 8080,
        webrtcPort: 8000,
        app: 'camera'
    },

    // GB/T 28181 (国标) 设备接入 - SIP 信令服务
    gb28181: {
        enabled: true,
        sipId: '34020000002000000001',
        sipDomain: '3402000000',
        sipPassword: '12345678',
        sipPort: 5060,
        sipHost: '',
        mediaIp: '',
        mediaPort: 0,
        rtpTransport: 'UDP',
        offlineAfterMs: 180000,
        allowAnonymous: false,
        alarmTagId: ''
    },

    // AI 视频分析：检测结果接入（叠加框 + 报警联动）
    ai: {
        enabled: true,
        minScore: 0.5,
        labels: [],
        ttlMs: 5000,
        maxDetections: 50,
        detectWidth: null,
        detectHeight: null,
        alarmTagId: '',
        alarmClearMs: 15000,
        cameraMap: {},
        mqtt: {
            enabled: false,
            url: 'mqtt://127.0.0.1:1883',
            topic: 'frigate/events',
            qos: 0,
            username: '',
            password: '',
            clientId: '',
            connectTimeout: 10000,
            reconnectPeriod: 5000
        },
        ws: {
            enabled: true,
            port: 1890,
            host: '0.0.0.0'
        }
    },

    // OPC UA Server（协议互联）：把工程对外发布给 OPC UA 客户端
    opcuaServer: {
        enabled: true,
        port: 4840,
        endpoint: '/UA/SCADA',
        rootName: 'SCADA',
        applicationName: 'SCADIA OPC UA Server',
        applicationUri: 'urn:scadia:server',
        advertiseHost: '',
        allowAnonymous: true,
        users: [],
        writeEnabled: false,
        exposeDevices: true,
        exposeCameras: true,
        cameraPollMs: 5000,
        tagPollMs: 1000,
        maxConnections: 20,
        maxSessions: 20
    },
}
