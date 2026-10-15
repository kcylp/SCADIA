
module.exports = {
    // Version to manage update
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
    //secureEnabled: true,
    //secretCode: '<set-a-strong-random-secret>',
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

    // Calibration module (开诚智枢 标定模块)
    // Write operations additionally require secureEnabled=true.
    calibration: {
        enabled: true,
        // master switch for ANY device write (tag or raw)
        writeEnabled: false,
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

    // Media streaming gateway (视频流转发)
    // Browsers cannot play RTSP directly; ZLMediaKit pulls the camera RTSP and
    // republishes it as WebRTC (low latency) / HLS / HTTP-FLV for the client.
    mediaServer: {
        enabled: false,
        type: 'zlmediakit',
        // ZLMediaKit HTTP API base, e.g. http://127.0.0.1:8080
        apiUrl: '',
        // ZLMediaKit 'secret' (config.ini -> api.secret)
        secret: '',
        // Address the BROWSER uses to reach ZLMediaKit (may differ from apiUrl)
        publicHost: '',
        httpPort: 8080,
        webrtcPort: 8000,
        app: 'camera'
    },

    // GB/T 28181 (国标) device access
    // The platform registers GB28181 devices (IPC/NVR/下级平台) over SIP, keeps
    // their catalog, forwards PTZ commands and invites the live stream into
    // ZLMediaKit (openRtpServer) for browser playback.
    gb28181: {
        enabled: false,
        // Platform (this server) SIP identity — type code 20 marks a SIP server.
        sipId: '34020000002000000001',
        sipDomain: '3402000000',
        // Default device SIP password; the platform only accepts registers that
        // digest-authenticate against it.
        sipPassword: '12345678',
        sipPort: 5060,
        // Local IP announced in Via/Contact/SDP. Empty = auto-detect.
        sipHost: '',
        // IP the device must send RTP/PS to (usually the ZLMediaKit host). Empty = sipHost.
        mediaIp: '',
        // 0 = let ZLMediaKit pick a free port
        mediaPort: 0,
        // UDP | TCP-PASSIVE | TCP-ACTIVE
        rtpTransport: 'UDP',
        // A device that stops sending keepalives within this window is marked offline
        offlineAfterMs: 180000,
        // Lab only: accept REGISTER without digest auth (never enable in production)
        allowAnonymous: false,
        // Optional SCADIA tag fed with the alarm state of GB28181 devices
        alarmTagId: ''
    },

    // AI video analytics (视频智能分析).
    // Supports VLX-Seek (fine-grained perception), VLX-Flow (streaming video),
    // VLX-VR (video reasoning), VLX-Go (embodied navigation), and external
    // detection engines (Frigate-style). Results are pushed in over MQTT,
    // WebSocket or HTTP; the platform overlays the boxes and can raise an alarm.
    ai: {
        enabled: false,
        // Ignore detections below this confidence (0..1)
        minScore: 0.5,
        // Empty = accept every label, otherwise a whitelist e.g. ['person','car']
        labels: [],
        // A box disappears this long after the last update (the object left the frame)
        ttlMs: 5000,
        // Max boxes kept per camera per update
        maxDetections: 50,
        // Engine detect-resolution, used to normalise pixel boxes it reports.
        // Leave null when the engine sends normalised coordinates or its own size.
        detectWidth: null,
        detectHeight: null,
        // Optional SCADIA tag raised to 1 on a detection and cleared after alarmClearMs
        alarmTagId: '',
        alarmClearMs: 15000,
        // Engine camera name -> our camera id, when the names do not already match
        cameraMap: {
            // 'frigate_cam_1': 'cam_ab12cd34ef56'
        },
        // MQTT ingest (Frigate publishes to frigate/events by default)
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
        // WebSocket ingest: engines connect and push one JSON payload per frame
        ws: {
            enabled: false,
            // 0 = let the OS choose (tests / side-by-side instances)
            port: 1890,
            host: '0.0.0.0'
        }
    },

    // OPC UA Server (协议互联): publish this project to OPC UA clients.
    // Third-party HMIs / MES / the mine's systems can browse and subscribe to the
    // live tags, camera state and AI alarms over opc.tcp.
    opcuaServer: {
        enabled: false,
        port: 4840,
        endpoint: '/UA/SCADA',
        rootName: 'SCADA',
        // Identity advertised to OPC UA clients. This is what a third-party MES/HMI shows
        // in its own server list, so it must carry THIS product's identity — 'kcylp' is the
        // upstream author and belongs in package.json, not on the wire.
        applicationName: 'Kaicheng SCADIA OPC UA Server',
        applicationUri: 'urn:kaicheng:scadia',
        // Host advertised in the endpoint URL. Empty = first non-internal IPv4.
        advertiseHost: '',
        // Plant-LAN deployment: anonymous is the common case. Set false and list
        // users below to require credentials.
        allowAnonymous: true,
        users: [
            // { username: 'operator', password: 'change-me' }
        ],
        // Refuse client writes to tags unless explicitly allowed.
        writeEnabled: false,
        exposeDevices: true,
        exposeCameras: true,
        cameraPollMs: 5000,
        // Tag scan cadence: how often published tags are re-read. This is the
        // read-freshness floor for drivers that do not emit change events.
        tagPollMs: 1000,
        maxConnections: 20,
        maxSessions: 20
    },
}
