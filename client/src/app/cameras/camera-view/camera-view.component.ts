import { Component, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild, ElementRef } from '@angular/core';

import { CameraService } from '../../_services/camera.service';
import { Camera, CameraDetection } from '../../_models/camera';

/**
 * Live camera tile.
 * - when the media gateway is available: WebRTC (low latency) via ZLMediaKit
 * - otherwise: server-side JPEG snapshot polling (works with any camera, no plugin)
 * Falls back to an informative placeholder on error so the console never breaks.
 *
 * OSD (视数融合): when the camera has OSD items configured, they are resolved
 * server-side (live SCADIA tag values) and overlaid on the video.
 */
@Component({
    selector: 'app-camera-view',
    templateUrl: './camera-view.component.html',
    styleUrls: ['./camera-view.component.css']
})
export class CameraViewComponent implements OnChanges, OnDestroy {

    @Input() camera: Camera;
    @Input() mediaEnabled = false;
    @Input() fps = 4;
    /** 'auto' | 'snapshot' | 'webrtc' */
    @Input() mode: 'auto' | 'snapshot' | 'webrtc' = 'auto';
    /** show the server-resolved OSD overlay */
    @Input() showOsd = true;
    /** draw live AI detection boxes (polled only for AI-enabled cameras) */
    @Input() showDetections = true;

    @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

    objectUrl: string | null = null;
    state: 'idle' | 'connecting' | 'live' | 'error' = 'idle';
    errorCode = '';
    usingWebrtc = false;

    /** OSD overlay: 4 corner buckets from the server-resolved feed */
    osd: { 'top-left': any[]; 'top-right': any[]; 'bottom-left': any[]; 'bottom-right': any[] } =
        { 'top-left': [], 'top-right': [], 'bottom-left': [], 'bottom-right': [] };

    /** AI detection boxes (normalised 0..1), drawn over the video */
    detections: CameraDetection[] = [];

    private timer: any = null;
    private osdTimer: any = null;
    private detTimer: any = null;
    private pc: RTCPeerConnection | null = null;

    constructor(private cameraService: CameraService) {
    }

    ngOnChanges(changes: SimpleChanges) {
        if (changes['camera'] || changes['mediaEnabled'] || changes['mode']) {
            this.stop();
            if (this.camera && this.camera.id && this.camera.enabled !== false) {
                this.start();
            }
        }
    }
    ngOnDestroy() {
        this.stop();
    }

    private wantsWebrtc(): boolean {
        if (this.mode === 'snapshot') { return false; }
        if (this.mode === 'webrtc') { return true; }
        return this.mediaEnabled;
    }

    start() {
        if (this.wantsWebrtc()) {
            this._startWebrtc();
        } else {
            this._startSnapshot();
        }
        this._startOsd();
        this._startDetections();
    }

    retry() {
        this.stop();
        this.start();
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.osdTimer) { clearInterval(this.osdTimer); this.osdTimer = null; }
        if (this.detTimer) { clearInterval(this.detTimer); this.detTimer = null; }
        if (this.pc) {
            try { this.pc.close(); } catch (e) { /* ignore */ }
            this.pc = null;
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
        if (this.videoEl && this.videoEl.nativeElement) {
            try { this.videoEl.nativeElement.srcObject = null; } catch (e) { /* ignore */ }
        }
        this.osd = { 'top-left': [], 'top-right': [], 'bottom-left': [], 'bottom-right': [] };
        this.detections = [];
        this.state = 'idle';
    }

    // ------------------------------------------------- OSD (视数融合 overlay)

    /** Poll the server-resolved OSD (live SCADIA tag values) and bucket by corner. */
    private _startOsd() {
        if (!this.showOsd || !this.camera || !this.camera.id) { return; }
        const hasOsd = this.camera.osd && this.camera.osd['items'] && this.camera.osd['items'].length;
        if (!hasOsd) { return; }
        const tick = () => {
            this.cameraService.getOsd(this.camera.id).subscribe(
                res => this._bucketOsd(res),
                () => { /* keep the last OSD on transient errors */ });
        };
        tick();
        this.osdTimer = setInterval(tick, 1000);
    }

    private _bucketOsd(res: any) {
        const buckets: any = { 'top-left': [], 'top-right': [], 'bottom-left': [], 'bottom-right': [] };
        const items = (res && res.items) || [];
        items.forEach((i: any) => {
            const pos = buckets[i.position] ? i.position : 'top-left';
            buckets[pos].push(i);
        });
        this.osd = buckets;
    }

    // ------------------------------------------- AI detection boxes (A9)

    /**
     * Poll the live AI boxes. Only AI-enabled cameras are polled: a wall of 16
     * tiles would otherwise issue requests for cameras that will never have an
     * engine attached.
     */
    private _startDetections() {
        if (!this.showDetections || !this.camera || !this.camera.id || this.camera.aiEnabled !== true) { return; }
        const tick = () => {
            this.cameraService.getDetections(this.camera.id).subscribe(
                res => this._applyDetections(res),
                () => { /* keep the last boxes on a transient error */ });
        };
        tick();
        this.detTimer = setInterval(tick, 1000);
    }

    private _applyDetections(res: any) {
        const items: CameraDetection[] = (res && res.detections) || [];
        // Only placeable boxes are drawn; the server already drops un-normalised
        // ones, this is a second guard so a stale/crafted payload cannot paint.
        this.detections = items.filter(d => d && d.normalized && d.region && d.label);
    }

    /** Box caption: engine label plus confidence, e.g. `person 91%`. */
    boxLabel(d: CameraDetection): string {
        if (d.score === null || d.score === undefined) { return d.label; }
        return d.label + ' ' + Math.round(d.score * 100) + '%';
    }

    // ------------------------------------------------------- snapshot polling

    private _startSnapshot() {
        this.usingWebrtc = false;
        this.state = 'connecting';
        const interval = Math.max(200, Math.round(1000 / Math.max(1, this.fps)));
        const tick = () => {
            if (!this.camera || !this.camera.id) { return; }
            this.cameraService.snapshotBlob(this.camera.id).subscribe(blob => {
                const url = URL.createObjectURL(blob);
                const prev = this.objectUrl;
                this.objectUrl = url;
                this.state = 'live';
                this.errorCode = '';
                if (prev) { URL.revokeObjectURL(prev); }
            }, err => {
                this.state = 'error';
                this.errorCode = (err && err.error && err.error.error) || (err && err.status ? ('HTTP ' + err.status) : 'unreachable');
            });
        };
        tick();
        this.timer = setInterval(tick, interval);
    }

    // ---------------------------------------------------------------- webrtc

    private async _startWebrtc() {
        this.usingWebrtc = true;
        this.state = 'connecting';
        try {
            // start the stream proxy (ZLMediaKit pulls the camera RTSP)
            await this.cameraService.playback(this.camera.id).toPromise();
            const pc = new RTCPeerConnection({ iceServers: [] });
            this.pc = pc;
            pc.addTransceiver('video', { direction: 'recvonly' });
            pc.addTransceiver('audio', { direction: 'recvonly' });
            pc.ontrack = (ev: RTCTrackEvent) => {
                const el = this.videoEl && this.videoEl.nativeElement;
                if (el && ev.streams && ev.streams[0]) {
                    el.srcObject = ev.streams[0];
                    el.play().catch(() => { /* autoplay may be blocked */ });
                    this.state = 'live';
                }
            };
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            // WHEP via our API (server adds the media secret; no CORS, no leak)
            const sdpOffer = pc.localDescription ? pc.localDescription.sdp : offer.sdp;
            const answer = await this.cameraService.whep(this.camera.id, sdpOffer).toPromise();
            if (!answer) { throw new Error('empty SDP answer'); }
            await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        } catch (err) {
            this.state = 'error';
            this.errorCode = (err && err.error && err.error.error) || (err && err.message) || 'webrtc-failed';
            // graceful degradation to snapshot polling
            this._startSnapshot();
        }
    }
}
