import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

import { EndPointApi } from '../_helpers/endpointapi';
import { Camera, CameraVendor, CamerasMeta, CameraProbeResult, CameraPlayback, CameraDetections } from '../_models/camera';

@Injectable({
    providedIn: 'root'
})
export class CameraService {

    private base: string = EndPointApi.getURL() + '/api/cameras';

    constructor(private http: HttpClient) {
    }

    getMeta(): Observable<CamerasMeta> {
        return this.http.get<CamerasMeta>(this.base + '-meta');
    }

    getVendors(): Observable<{ vendors: CameraVendor[] }> {
        return this.http.get<{ vendors: CameraVendor[] }>(this.base + '/vendors');
    }

    getCameras(): Observable<{ cameras: Camera[] }> {
        return this.http.get<{ cameras: Camera[] }>(this.base);
    }

    getCamera(id: string): Observable<Camera> {
        return this.http.get<Camera>(this.base + '/' + id);
    }

    create(camera: Partial<Camera>): Observable<Camera> {
        return this.http.post<Camera>(this.base, camera);
    }

    update(id: string, camera: Partial<Camera>): Observable<Camera> {
        return this.http.put<Camera>(this.base + '/' + id, camera);
    }

    remove(id: string): Observable<{ result: string }> {
        return this.http.delete<{ result: string }>(this.base + '/' + id);
    }

    probe(id: string): Observable<CameraProbeResult> {
        return this.http.post<CameraProbeResult>(this.base + '/' + id + '/probe', {});
    }

    /** Test an unsaved payload (editor "测试" button). */
    probePayload(camera: Partial<Camera>): Observable<CameraProbeResult> {
        return this.http.post<CameraProbeResult>(this.base + '/probe', camera);
    }

    /** One JPEG frame, fetched with auth headers (used for previews). */
    snapshotBlob(id: string): Observable<Blob> {
        return this.http.get(this.base + '/' + id + '/snapshot', { responseType: 'blob' });
    }

    /** Resolve browser-playable stream URLs (starts the media-server proxy). */
    playback(id: string): Observable<CameraPlayback> {
        return this.http.get<CameraPlayback>(this.base + '/' + id + '/play');
    }

    stopPlayback(id: string): Observable<{ result: string }> {
        return this.http.post<{ result: string }>(this.base + '/' + id + '/play/stop', {});
    }

    /**
     * WHEP signalling via OUR api. The media server `secret` stays server-side
     * and CORS is avoided; the SDP answer comes back as text.
     */
    whep(id: string, offer: string): Observable<string> {
        return this.http.post(this.base + '/' + id + '/whep', offer, {
            headers: new HttpHeaders({ 'Content-Type': 'application/sdp' }),
            responseType: 'text'
        });
    }

    mediaHealth(): Observable<{ configured: boolean; ok: boolean; count?: number; error?: string }> {
        return this.http.get<{ configured: boolean; ok: boolean; count?: number; error?: string }>(
            EndPointApi.getURL() + '/api/media/health');
    }

    // ------------------------------------------------------------------- PTZ

    ptzCapabilities(id: string): Observable<{ ptz: boolean; presets: boolean; cruise: boolean; lens: boolean; audio: boolean; vendor: string }> {
        return this.http.get<any>(this.base + '/' + id + '/ptz/capabilities');
    }

    ptzMove(id: string, code: string, speed = 1): Observable<any> {
        return this.http.post(this.base + '/' + id + '/ptz', { code, speed });
    }

    ptzPreset(id: string, preset: number, op: 'goto' | 'set' | 'delete' = 'goto'): Observable<any> {
        return this.http.post(this.base + '/' + id + '/ptz/preset', { preset, op });
    }

    // ------------------------------------------------------- 视数融合 (fusion)

    /** OSD overlay content with LIVE SCADIA tag values (server-resolved). */
    getOsd(id: string): Observable<{ cameraId: string; items: any[]; online: boolean; ts: number }> {
        return this.http.get<{ cameraId: string; items: any[]; online: boolean; ts: number }>(this.base + '/' + id + '/osd');
    }

    getCameraStatus(id: string): Observable<{ online: boolean; lastCheck?: number; error?: string }> {
        return this.http.get<{ online: boolean; lastCheck?: number; error?: string }>(this.base + '/' + id + '/status');
    }

    fusionStatus(): Observable<{ status: any }> {
        return this.http.get<{ status: any }>(EndPointApi.getURL() + '/api/fusion/status');
    }

    fusionPoll(): Observable<{ polled: number; results: any[] }> {
        return this.http.post<{ polled: number; results: any[] }>(EndPointApi.getURL() + '/api/fusion/poll', {});
    }

    /** Push a video-side event into a SCADIA tag (报警联动). */
    fusionEvent(tagId: string, value: number | boolean): Observable<{ tagId: string; value: number }> {
        return this.http.post<{ tagId: string; value: number }>(EndPointApi.getURL() + '/api/fusion/event', { tagId, value });
    }

    // -------------------------------------------------- AI 视频分析 (analytics)

    /** Live AI detection boxes for one camera (already normalised server-side). */
    getDetections(id: string): Observable<CameraDetections> {
        return this.http.get<CameraDetections>(
            EndPointApi.getURL() + '/api/ai/detections?camera=' + encodeURIComponent(id));
    }

    aiStatus(): Observable<any> {
        return this.http.get<any>(EndPointApi.getURL() + '/api/ai/status');
    }
}
