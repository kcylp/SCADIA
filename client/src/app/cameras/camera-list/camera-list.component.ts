import { Component, OnInit, OnDestroy } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';

import { CameraService } from '../../_services/camera.service';
import { Camera, CamerasMeta } from '../../_models/camera';
import { CameraEditorComponent } from '../camera-editor/camera-editor.component';
import { ConfirmDialogComponent } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';

/**
 * Camera console: SCADA-style overview of configured video sources.
 */
@Component({
    selector: 'app-camera-list',
    templateUrl: './camera-list.component.html',
    styleUrls: ['./camera-list.component.css']
})
export class CameraListComponent implements OnInit, OnDestroy {

    cameras: Camera[] = [];
    meta: CamerasMeta | null = null;
    mediaHealth: any = null;
    loading = false;
    /** camera expanded in the live preview */
    selected: Camera | null = null;
    private sub: Subscription = new Subscription();

    constructor(
        private cameraService: CameraService,
        private dialog: MatDialog,
        private translate: TranslateService,
        private toastr: ToastrService
    ) {
    }

    ngOnInit() {
        this.load();
    }

    ngOnDestroy() {
        this.sub.unsubscribe();
    }

    load() {
        this.loading = true;
        this.cameraService.getMeta().subscribe(m => this.meta = m, () => { this.meta = null; });
        this.cameraService.mediaHealth().subscribe(h => this.mediaHealth = h, () => { this.mediaHealth = null; });
        this.cameraService.getCameras().subscribe(res => {
            this.cameras = res.cameras || [];
            this.loading = false;
            if (!this.selected && this.cameras.length) {
                this.selected = this.cameras[0];
            }
        }, err => {
            this.loading = false;
            this._error(err);
        });
    }

    // ------------------------------------------------------------- helpers

    get onlineCount(): number {
        return this.cameras.filter(c => c.enabled !== false).length;
    }

    get aiCount(): number {
        return this.cameras.filter(c => c.aiEnabled).length;
    }

    get vendorLabel(): string {
        return this.selected && this.selected.endpoints ? (this.selected.endpoints.vendor || this.selected.vendor) : '';
    }

    onSelect(camera: Camera) {
        this.selected = camera;
    }

    onAdd() {
        const ref = this.dialog.open(CameraEditorComponent, {
            width: '880px',
            maxWidth: '96vw',
            disableClose: true,
            data: { camera: null }
        });
        this.sub.add(ref.afterClosed().subscribe(changed => { if (changed) { this.load(); } }));
    }

    onEdit(camera: Camera) {
        const ref = this.dialog.open(CameraEditorComponent, {
            width: '880px',
            maxWidth: '96vw',
            disableClose: true,
            data: { camera }
        });
        this.sub.add(ref.afterClosed().subscribe(changed => { if (changed) { this.load(); } }));
    }

    onProbe(camera: Camera) {
        this.toastr.info(this.translate.instant('camera.testing'));
        this.cameraService.probe(camera.id).subscribe(res => {
            if (res && res.ok) {
                this.toastr.success(this.translate.instant('camera.test-ok') +
                    (res.snapshot && res.snapshot.bytes ? (' · ' + res.snapshot.bytes + 'B') : ''));
            } else {
                const code = res && res.snapshot && res.snapshot.error ? res.snapshot.error : 'unreachable';
                this.toastr.error(this.translate.instant('camera.test-fail') + ': ' + code);
            }
        }, err => this._error(err));
    }

    onRemove(camera: Camera) {
        const ref = this.dialog.open(ConfirmDialogComponent, {
            data: { title: 'msg.delete-element-title', text: camera.name }
        });
        this.sub.add(ref.afterClosed().subscribe(result => {
            if (result === 'ok') {
                this.cameraService.remove(camera.id).subscribe(() => {
                    if (this.selected && this.selected.id === camera.id) { this.selected = null; }
                    this.load();
                }, err => this._error(err));
            }
        }));
    }

    private _error(err: any) {
        const msg = err && err.error && err.error.message ? err.error.message : (err.message || err);
        const code = err && err.error && err.error.error ? err.error.error : '';
        this.toastr.error(code ? code + ': ' + msg : '' + msg);
    }
}
