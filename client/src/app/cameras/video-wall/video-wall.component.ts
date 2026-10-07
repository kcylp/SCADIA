import { Component, OnInit, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';

import { CameraService } from '../../_services/camera.service';
import { Camera } from '../../_models/camera';

export interface WallCell {
    r: number; c: number; rs: number; cs: number;
    cameraId: string | null;
}
export interface WallLayout {
    id: string; label: string; rows: number; cols: number; cells: WallCell[];
}

/**
 * Video wall — the "video monitor object" (对标展厅视频监控器).
 * Layout matrix + toolbar + PTZ control pad + camera resource list.
 * Every action degrades gracefully when the camera/vendor does not support it.
 */
@Component({
    selector: 'app-video-wall',
    templateUrl: './video-wall.component.html',
    styleUrls: ['./video-wall.component.css']
})
export class VideoWallComponent implements OnInit, OnDestroy {

    cameras: Camera[] = [];
    mediaEnabled = false;
    loading = true;

    layouts: WallLayout[] = [];
    layout: WallLayout;
    cells: WallCell[] = [];
    selectedCell = 0;

    // toolbar state
    rotate = false;
    rotateSec = 10;
    osd = true;
    detect = true;
    fullscreen = false;
    private rotateTimer: any = null;

    // control pad
    showPad = true;
    showResource = true;
    ptzSpeed = 1;
    ptz: any = { ptz: false, presets: false, cruise: false, lens: false, audio: false } as any;
    presetCount = 6;
    activePresets: number[] = [];
    cruisePath = 0;

    private sub: Subscription = new Subscription();

    constructor(
        private cameraService: CameraService,
        private translate: TranslateService,
        private toastr: ToastrService
    ) {
        this.layouts = this._buildLayouts();
        this.layout = this.layouts[1]; // default 2x2
    }

    ngOnInit() {
        this.cameraService.getMeta().subscribe(m => {
            this.mediaEnabled = !!(m && m.mediaServer && m.mediaServer.enabled);
        }, () => { this.mediaEnabled = false; });
        this.cameraService.getCameras().subscribe(res => {
            this.cameras = (res.cameras || []).filter(c => c.enabled !== false);
            this.loading = false;
            this._applyLayout(this.layout, true);
        }, err => {
            this.loading = false;
            this._error(err);
        });
    }

    ngOnDestroy() {
        this.sub.unsubscribe();
        this._stopRotate();
        if (this.fullscreen) { this._exitFullscreen(); }
    }

    // ------------------------------------------------------------- layouts

    private _buildLayouts(): WallLayout[] {
        const grid = (id: string, label: string, rows: number, cols: number, big = false): WallLayout => {
            const cells: WallCell[] = [];
            if (big) {
                // one 2x2 hero at top-left + 1x1 for the rest
                cells.push({ r: 1, c: 1, rs: 2, cs: 2, cameraId: null });
                for (let r = 1; r <= rows; r++) {
                    for (let c = 1; c <= cols; c++) {
                        const inHero = (r <= 2 && c <= 2);
                        if (!inHero) { cells.push({ r: r, c: c, rs: 1, cs: 1, cameraId: null }); }
                    }
                }
            } else {
                for (let r = 1; r <= rows; r++) {
                    for (let c = 1; c <= cols; c++) { cells.push({ r: r, c: c, rs: 1, cs: 1, cameraId: null }); }
                }
            }
            return { id, label, rows, cols, cells };
        };
        return [
            grid('1', '1×1', 1, 1),
            grid('4', '2×2', 2, 2),
            grid('6', '3×2', 2, 3),
            grid('8', '4×2', 2, 4),
            grid('9', '3×3', 3, 3),
            grid('16', '4×4', 4, 4),
            grid('1+5', '1+5', 3, 3, true)
        ];
    }

    get gridStyle(): any {
        return {
            'grid-template-columns': 'repeat(' + this.layout.cols + ', 1fr)',
            'grid-template-rows': 'repeat(' + this.layout.rows + ', 1fr)'
        };
    }

    onLayoutChange(id: string) {
        const l = this.layouts.find(x => x.id === id);
        if (l) { this._applyLayout(l, false); }
    }

    private _applyLayout(l: WallLayout, autoAssign: boolean) {
        // preserve existing assignments by index
        const prev = this.cells.map(c => c.cameraId);
        this.layout = l;
        this.cells = l.cells.map((c, i) => Object.assign({}, c, { cameraId: prev[i] || null }));
        if (autoAssign || this.cells.every(c => !c.cameraId)) {
            let k = 0;
            this.cells.forEach(cell => {
                if (!cell.cameraId && k < this.cameras.length) { cell.cameraId = this.cameras[k++].id; }
            });
        }
        if (this.selectedCell >= this.cells.length) { this.selectedCell = 0; }
        this._refreshPtz();
    }

    // ------------------------------------------------------------- helpers

    get selected(): WallCell | null {
        return this.cells[this.selectedCell] || null;
    }

    get selectedCamera(): Camera | null {
        const s = this.selected;
        if (!s || !s.cameraId) { return null; }
        return this.cameras.find(c => c.id === s.cameraId) || null;
    }

    cameraOf(cell: WallCell): Camera | null {
        if (!cell.cameraId) { return null; }
        return this.cameras.find(c => c.id === cell.cameraId) || null;
    }

    selectCell(index: number) {
        this.selectedCell = index;
        this._refreshPtz();
    }

    /** Assign a camera to the selected cell (from the resource list). */
    assignCamera(camera: Camera) {
        const cell = this.selected;
        if (!cell) { return; }
        cell.cameraId = camera.id;
        this._refreshPtz();
    }

    clearCell() {
        const cell = this.selected;
        if (cell) { cell.cameraId = null; }
        this._refreshPtz();
    }

    private _refreshPtz() {
        const cam = this.selectedCamera;
        if (!cam) {
            this.ptz = { ptz: false, presets: false, cruise: false, lens: false, audio: false };
            return;
        }
        this.cameraService.ptzCapabilities(cam.id).subscribe(
            caps => this.ptz = caps,
            () => this.ptz = { ptz: false, presets: false, cruise: false, lens: false, audio: false });
    }

    // ------------------------------------------------------------- toolbar

    toggleRotate() {
        this.rotate = !this.rotate;
        this._stopRotate();
        if (this.rotate) {
            // cycle cameras through every cell
            this.rotateTimer = setInterval(() => this._rotateStep(), Math.max(3, this.rotateSec) * 1000);
        }
    }

    private _stopRotate() {
        if (this.rotateTimer) { clearInterval(this.rotateTimer); this.rotateTimer = null; }
    }

    private _rotateStep() {
        if (!this.cameras.length) { return; }
        const ids = this.cameras.map(c => c.id);
        this.cells.forEach(cell => {
            const i = ids.indexOf(cell.cameraId as string);
            cell.cameraId = ids[(i + 1 + ids.length) % ids.length];
        });
    }

    step(delta: number) {
        const cell = this.selected;
        if (!cell) { return; }
        const ids = this.cameras.map(c => c.id);
        if (!ids.length) { return; }
        const i = ids.indexOf(cell.cameraId as string);
        cell.cameraId = ids[(i + delta + ids.length) % ids.length];
        this._refreshPtz();
    }

    toggleOsd() { this.osd = !this.osd; }

    toggleDetect() { this.detect = !this.detect; }

    toggleFullscreen(el: HTMLElement) {
        this.fullscreen = !this.fullscreen;
        if (this.fullscreen) {
            try { el.requestFullscreen(); } catch (e) { /* unsupported */ }
        } else {
            this._exitFullscreen();
        }
    }

    private _exitFullscreen() {
        try { if (document.fullscreenElement) { document.exitFullscreen(); } } catch (e) { /* ignore */ }
        this.fullscreen = false;
    }

    screenshot() {
        const cam = this.selectedCamera;
        if (!cam) { this.toastr.warning(this.translate.instant('wall.no-camera')); return; }
        // grab the current frame from the server-side snapshot proxy and save it
        this.cameraService.snapshotBlob(cam.id).subscribe(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            a.download = cam.name + '_' + ts + '.jpg';
            a.click();
            URL.revokeObjectURL(a.href);
            this.toastr.success(this.translate.instant('wall.snapshot-saved'));
        }, err => this._error(err));
    }

    // ------------------------------------------------------------- PTZ pad

    onPtz(code: string) {
        const cam = this.selectedCamera;
        if (!cam || !this.ptz.ptz) { return; }
        this.cameraService.ptzMove(cam.id, code, this.ptzSpeed).subscribe(
            () => { /* move applied */ },
            err => this._error(err));
    }

    /** press-and-hold continuous move: start on pointerdown, stop on pointerup */
    onPtzDown(code: string) { this.onPtz(code); }
    onPtzUp() { this.onPtz('stop'); }

    onPreset(index: number) {
        const cam = this.selectedCamera;
        if (!cam || !this.ptz.presets) { return; }
        this.cameraService.ptzPreset(cam.id, index, 'goto').subscribe(
            () => this.toastr.info(this.translate.instant('wall.preset-goto') + ' ' + index),
            err => this._error(err));
    }

    onPresetSet(index: number) {
        const cam = this.selectedCamera;
        if (!cam || !this.ptz.presets) { return; }
        this.cameraService.ptzPreset(cam.id, index, 'set').subscribe(
            () => { if (this.activePresets.indexOf(index) < 0) { this.activePresets.push(index); }
                    this.toastr.success(this.translate.instant('wall.preset-set') + ' ' + index); },
            err => this._error(err));
    }

    onPresetDelete(index: number) {
        const cam = this.selectedCamera;
        if (!cam || !this.ptz.presets) { return; }
        this.cameraService.ptzPreset(cam.id, index, 'delete').subscribe(
            () => { this.activePresets = this.activePresets.filter(p => p !== index);
                    this.toastr.info(this.translate.instant('wall.preset-delete') + ' ' + index); },
            err => this._error(err));
    }

    presetRange(): number[] {
        const out: number[] = [];
        for (let i = 1; i <= this.presetCount; i++) { out.push(i); }
        return out;
    }

    private _error(err: any) {
        const code = err && err.error && err.error.error ? err.error.error : '';
        const msg = err && err.error && err.error.message ? err.error.message : (err.message || err);
        this.toastr.error(code ? code + ': ' + msg : '' + msg);
    }
}
