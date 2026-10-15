/**
 * Camera / video-source domain models (开诚智枢scada 视频监控)
 */

export interface CameraVendor {
    id: string;
    label: string;
    defaultPort: number;
    defaultHttpPort: number;
    supportsMjpeg: boolean;
}

export interface CameraEndpoints {
    rtsp?: string;
    snapshot?: string;
    mjpeg?: string;
    vendor?: string;
    auth?: string;
}

export interface CameraOsdItem {
    type: 'text' | 'time' | 'value';
    label?: string;
    text?: string;
    format?: 'time' | 'date' | 'datetime' | 'weekday';
    tagId?: string | null;
    unit?: string;
    decimals?: number;
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    /** resolved server-side */
    value?: any;
    quality?: 'good' | 'bad';
}

export interface CameraOsd {
    items: CameraOsdItem[];
}

/** One AI detection box; `region` is normalised 0..1 with the origin top-left. */
export interface CameraDetection {
    id?: string | null;
    camera?: string | null;
    label: string;
    score?: number | null;
    region: { x: number; y: number; w: number; h: number };
    normalized: boolean;
    timestamp?: number;
    /** ingest transport the box arrived on: mqtt | ws | http */
    source?: string;
}

export interface CameraDetections {
    enabled?: boolean;
    camera?: string | null;
    detections: CameraDetection[];
    updatedAt?: number | null;
    ageMs?: number | null;
    expired?: boolean;
}

export interface Camera {
    id?: string;
    name: string;
    vendor: string;
    host?: string;
    port?: number;
    httpPort?: number;
    channel?: number;
    subtype?: number;
    username?: string;
    password?: string;
    hasPassword?: boolean;
    auth?: string;
    rtspTemplate?: string;
    snapshotTemplate?: string;
    mjpegTemplate?: string;
    streamMode?: string;
    previewFps?: number;
    enabled?: boolean;
    aiEnabled?: boolean;
    aiEndpoint?: string;
    statusTagId?: string | null;
    statusTagLinked?: boolean;
    osd?: CameraOsd | null;
    group?: string;
    note?: string;
    endpoints?: CameraEndpoints;
    createdAt?: string;
    updatedAt?: string;
}

export interface CamerasMeta {
    module: string;
    secureEnabled: boolean;
    streamModes: string[];
    mediaServer: { enabled: boolean; type: string | null };
}

export interface CameraProbeResult {
    vendor?: string;
    rtsp?: string;
    auth?: string;
    ok: boolean;
    snapshot?: { ok: boolean; jpeg?: boolean; bytes?: number; status?: number; error?: string };
}

export interface CameraPlayback {
    media: string;
    app: string;
    stream: string;
    /** server-side WHEP relay endpoint (keeps the media secret off the browser) */
    whep: string;
    hls: string;
    flv: string;
    rtsp: string;
}
