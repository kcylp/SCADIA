import { Component, Inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';

import { CameraService } from '../../_services/camera.service';
import { Camera, CameraVendor } from '../../_models/camera';

/**
 * Camera editor dialog — vendor-template driven.
 * Picking a vendor fills the documented URL templates (海康/大华/宇视/ONVIF),
 * then "测试" probes the camera for a real JPEG frame before saving.
 */
@Component({
    selector: 'app-camera-editor',
    templateUrl: './camera-editor.component.html',
    styleUrls: ['./camera-editor.component.css']
})
export class CameraEditorComponent implements OnInit {

    camera: Partial<Camera>;
    isNew: boolean;
    vendors: CameraVendor[] = [];
    saving = false;
    probing = false;
    probeResult: any = null;
    /** preview camera bound to app-camera-view (only after a successful probe/save) */
    previewCamera: Camera | null = null;
    mediaEnabled = false;
    showTemplates = false;
    /** OSD draft items (edited in the form) */
    osdItems: any[] = [];
    osdPreview: any[] = [];

    constructor(
        private dialogRef: MatDialogRef<CameraEditorComponent>,
        private cameraService: CameraService,
        private translate: TranslateService,
        private toastr: ToastrService,
        @Inject(MAT_DIALOG_DATA) public data: { camera: Camera | null }
    ) {
        this.isNew = !data || !data.camera;
        this.camera = this.isNew ? this._blank() : Object.assign({}, data.camera);
        this.osdItems = (this.camera.osd && this.camera.osd['items'])
            ? this.camera.osd['items'].map(i => Object.assign({}, i)) : [];
    }

    // ------------------------------------------------------------ OSD editor

    addOsdItem() {
        this.osdItems.push({
            type: 'text', label: '', text: '', format: 'time',
            tagId: null, unit: '', decimals: 2, position: 'top-left'
        });
        this._syncOsd();
    }

    removeOsdItem(index: number) {
        this.osdItems.splice(index, 1);
        this._syncOsd();
    }

    onOsdTypeChange(item: any) {
        if (item.type === 'time' && !item.format) { item.format = 'time'; }
        if (item.type === 'value' && !item.decimals) { item.decimals = 2; }
        this._syncOsd();
    }

    onOsdPosChange() { this._syncOsd(); }

    private _syncOsd() {
        this.camera.osd = this.osdItems.length ? { items: this.osdItems } : null;
        this.refreshOsdPreview();
    }

    /** Live preview of OSD text with current tag values (saved camera only). */
    refreshOsdPreview() {
        if (!this.camera.id || !this.osdItems.length) { this.osdPreview = []; return; }
        this.cameraService.getOsd(this.camera.id).subscribe(
            res => { this.osdPreview = (res && res.items) || []; },
            () => { this.osdPreview = []; });
    }

    ngOnInit() {
        this.cameraService.getVendors().subscribe(r => {
            this.vendors = r.vendors || [];
            if (this.isNew && this.vendors.length) { this.onVendorChange(this.camera.vendor || 'hikvision'); }
        }, () => { /* keep the form usable without presets */ });
        this.cameraService.getMeta().subscribe(m => {
            this.mediaEnabled = !!(m && m.mediaServer && m.mediaServer.enabled);
        }, () => { this.mediaEnabled = false; });
        if (!this.isNew && this.camera.id) {
            this.refreshPreview();
            this.refreshOsdPreview();
        }
    }

    private _blank(): Partial<Camera> {
        return {
            name: '',
            vendor: 'hikvision',
            host: '',
            port: 554,
            httpPort: 80,
            channel: 1,
            subtype: 0,
            username: 'admin',
            password: '',
            streamMode: 'snapshot',
            previewFps: 4,
            enabled: true,
            aiEnabled: false,
            statusTagId: null,
            osd: null,
            group: '',
            note: ''
        };
    }

    // ------------------------------------------------------------- helpers

    get selectedVendor(): CameraVendor | null {
        return this.vendors.find(v => v.id === this.camera.vendor) || null;
    }

    get isCustom(): boolean {
        return this.camera.vendor === 'custom';
    }

    /** Apply vendor defaults (ports) when the vendor changes. */
    onVendorChange(vendorId: string) {
        this.camera.vendor = vendorId;
        const v = this.vendors.find(x => x.id === vendorId);
        if (v) {
            if (!this.camera.port) { this.camera.port = v.defaultPort; }
            if (!this.camera.httpPort) { this.camera.httpPort = v.defaultHttpPort; }
        }
        this.probeResult = null;
    }

    /** Preview endpoints from the vendor templates (credentials masked server-side). */
    get endpointPreview(): any {
        if (!this.camera || !this.camera.vendor) { return null; }
        return this.camera.endpoints || null;
    }

    // ------------------------------------------------------------- actions

    onProbe() {
        if (!this.validate(true)) { return; }
        this.probing = true;
        this.probeResult = null;
        this.cameraService.probePayload(this.camera).subscribe(res => {
            this.probing = false;
            this.probeResult = res;
            if (res && res.ok) {
                this.toastr.success(this.translate.instant('camera.test-ok'));
                if (this.camera.id) { this.refreshPreview(); }
            } else {
                const code = res && res.snapshot && res.snapshot.error ? res.snapshot.error : 'unreachable';
                this.toastr.error(this.translate.instant('camera.test-fail') + ': ' + code);
            }
        }, err => {
            this.probing = false;
            const code = err && err.error && err.error.error ? err.error.error : 'unreachable';
            this.toastr.error(this.translate.instant('camera.test-fail') + ': ' + code);
        });
    }

    onSave() {
        if (!this.validate(false)) { return; }
        this.saving = true;
        const op = this.isNew || !this.camera.id
            ? this.cameraService.create(this.camera)
            : this.cameraService.update(this.camera.id, this.camera);
        op.subscribe(saved => {
            this.saving = false;
            this.camera = Object.assign({}, saved);
            this.isNew = false;
            this.toastr.success(this.translate.instant('camera.saved'));
            this.dialogRef.close(true);
        }, err => {
            this.saving = false;
            const code = err && err.error && err.error.error ? err.error.error : '';
            const msg = err && err.error && err.error.message ? err.error.message : err.message;
            this.toastr.error(code ? code + ': ' + msg : '' + msg);
        });
    }

    onClose() {
        this.dialogRef.close(false);
    }

    private refreshPreview() {
        if (this.camera && this.camera.id) {
            this.cameraService.getCamera(this.camera.id).subscribe(c => { this.previewCamera = c; }, () => { /* ignore */ });
        }
    }

    private validate(forProbe: boolean): boolean {
        if (!this.camera.name || !this.camera.name.trim()) {
            this.toastr.warning(this.translate.instant('camera.err-name'));
            return false;
        }
        if (this.isCustom) {
            if (!this.camera.rtspTemplate && !this.camera.snapshotTemplate) {
                this.toastr.warning(this.translate.instant('camera.err-custom'));
                return false;
            }
        } else if (!this.camera.host || !this.camera.host.trim()) {
            this.toastr.warning(this.translate.instant('camera.err-host'));
            return false;
        }
        if (forProbe && !this.camera.password && !this.camera.hasPassword) {
            this.toastr.warning(this.translate.instant('camera.err-password'));
            return false;
        }
        return true;
    }
}
