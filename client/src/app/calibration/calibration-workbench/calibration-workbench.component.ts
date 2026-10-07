import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';

import { CalibrationService } from '../../_services/calibration.service';
import { io } from 'socket.io-client';
import { EndPointApi } from '../../_helpers/endpointapi';
import { IoEventTypes } from '../../_services/hmi.service';
import { CalibrationSessionView, CalibrationPoint } from '../../_models/calibration';
import { MatDialog as MatDialog } from '@angular/material/dialog';
import { ConfirmDialogComponent } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';

/**
 * Calibration workbench — SCADA instrument surface.
 * Sampling station (live readout + trend), points table, fit regression chart,
 * approval/write workflow and the write audit trail.
 */
@Component({
    selector: 'app-calibration-workbench',
    templateUrl: './calibration-workbench.component.html',
    styleUrls: ['./calibration-workbench.component.css']
})
export class CalibrationWorkbenchComponent implements OnInit, OnDestroy {

    view: CalibrationSessionView | null = null;
    loading = true;
    meta: any = null;

    // live sampling state driven by socket events
    sampling = false;
    liveValue: number | null = null;
    liveAccepted = 0;
    liveRejected = 0;
    liveTarget = 0;

    lastSamples: any[] = [];
    newReferenceValue: number | null = null;

    private socket: any = null;
    private currentId = '';
    private sub: Subscription = new Subscription();

    constructor(
        private route: ActivatedRoute,
        private calibrationService: CalibrationService,
        private translate: TranslateService,
        private toastr: ToastrService,
        private dialog: MatDialog
    ) {
    }

    ngOnInit() {
        this.route.params.subscribe(params => {
            if (params['id']) {
                this.currentId = params['id'];
                this.load(this.currentId);
            }
        });
        this.initSocket();
    }

    ngOnDestroy() {
        this.sub.unsubscribe();
        if (this.socket) { this.socket.close(); }
    }

    get sessionId(): string { return this.currentId; }

    load(id: string) {
        this.loading = true;
        this.calibrationService.getMeta().subscribe(m => this.meta = m, () => { this.meta = null; });
        this.calibrationService.getSession(id).subscribe(view => {
            this.view = view;
            this.loading = false;
            this._updateSampleTable();
        }, err => {
            this.loading = false;
            this._error(err);
        });
    }

    private initSocket() {
        try {
            const socketUrl = new URL(EndPointApi.getURL(), location.origin);
            const socketPath = socketUrl.pathname.replace(/\/+$/, '') + '/socket.io';
            this.socket = io(socketUrl.origin, { path: socketPath, transports: ['websocket', 'polling'] });
            // The names come from IoEventTypes, not from string literals: a typo here used to
            // be invisible (the event simply never arrived), and the guard that keeps the two
            // enumerations in step can only see names that go through the enum.
            this.socket.on(IoEventTypes.CALIBRATION_SAMPLE_PROGRESS, (p: any) => this._onProgress(p));
            this.socket.on(IoEventTypes.CALIBRATION_SAMPLE_COMPLETE, (p: any) => this._onSampleDone(p, 'calibration.sample-complete'));
            this.socket.on(IoEventTypes.CALIBRATION_SAMPLE_ERROR, (p: any) => this._onSampleDone(p, 'calibration.sample-error'));
            this.socket.on(IoEventTypes.CALIBRATION_CANCELED, (p: any) => this._onSampleDone(p, 'calibration.sample-canceled'));
            this.socket.on(IoEventTypes.CALIBRATION_FIT_COMPLETE, () => this.reload());
            this.socket.on(IoEventTypes.CALIBRATION_WRITE_PROGRESS, (p: any) => {
                this.toastr.info('calibration: ' + (p.phase || p.summary || 'progress'));
            });
            this.socket.on(IoEventTypes.CALIBRATION_WRITE_COMPLETE, (p: any) => {
                this.toastr.success(this.translate.instant('calibration.write-complete') + ' (' + p.status + ')');
                this.reload();
            });
            this.socket.on(IoEventTypes.CALIBRATION_WRITE_ERROR, (p: any) => {
                this.toastr.error(this.translate.instant('calibration.write-error') +
                    (p.errorCode ? (': ' + p.errorCode) : ''));
                this.reload();
            });
        } catch (e) {
            console.warn('calibration socket init failed', e);
        }
    }

    private _onProgress(p: any) {
        if (!this.view || p.sessionId !== this.view.session.id) { return; }
        this.sampling = true;
        this.liveAccepted = p.accepted || 0;
        this.liveRejected = p.rejected || 0;
        this.liveTarget = p.target || 0;
        if (p.latestValue !== null && p.latestValue !== undefined) {
            this.liveValue = p.latestValue;
        }
    }

    private _onSampleDone(p: any, msgKey: string) {
        if (!this.view || p.sessionId !== this.view.session.id) { return; }
        this.sampling = false;
        if (p.errorCode === 'CAL_SAMPLE_UNSTABLE') {
            this.toastr.warning(this.translate.instant('calibration.sample-unstable'));
        } else {
            this.toastr.info(this.translate.instant(msgKey));
        }
        this.reload();
    }

    private _updateSampleTable() {
        const last = this.view && this.view.points.length ? this.view.points[this.view.points.length - 1] : null;
        this.lastSamples = last && last.samples ? last.samples.slice().reverse().slice(0, 40) : [];
        if (last && last.stats && last.stats.mean !== null && !this.sampling) {
            this.liveValue = last.stats.mean;
        }
    }

    reload() {
        if (this.currentId) { this.load(this.currentId); }
    }

    // ------------------------------------------------------------- helpers

    statusLabel(status: string): string {
        return this.translate.instant('calibration.st.' + status);
    }

    statusTone(status: string): string {
        switch (status) {
            case 'applied': case 'approved': return 'ok';
            case 'failed': return 'alarm';
            case 'uncertain': case 'awaiting-approval': return 'warn';
            case 'sampling': case 'writing': case 'verifying': return 'info';
            default: return 'idle';
        }
    }

    get unit(): string {
        return (this.view && this.view.profile && this.view.profile.sourceUnit) || '';
    }

    // ------------------------------------------------------------- permissions

    canSample(): boolean {
        return !!this.view && !this.sampling &&
            ['draft', 'ready', 'fitted'].indexOf(this.view.session.status) >= 0;
    }

    canFit(): boolean {
        return !!this.view && !this.sampling && ['ready', 'fitted'].indexOf(this.view.session.status) >= 0 &&
            this.view.points.length >= 2 &&
            this.view.points.every(p => p.stats && p.stats.mean !== null && p.stats.mean !== undefined);
    }

    canSubmit(): boolean {
        return !!this.view && !this.sampling && this.view.session.status === 'fitted' &&
            !!this.view.session.fit && !!this.view.session.fit.qualityPassed;
    }

    canApprove(): boolean {
        return !!this.view && this.view.session.status === 'awaiting-approval';
    }

    canApply(): boolean {
        return !!this.view && this.view.session.status === 'approved';
    }

    isFinal(): boolean {
        return !!this.view && ['applied', 'failed', 'uncertain', 'canceled'].indexOf(this.view.session.status) >= 0;
    }

    // ------------------------------------------------------------- actions

    onAddPointAndSample() {
        if (!this.view) { return; }
        if (this.newReferenceValue === null || !Number.isFinite(Number(this.newReferenceValue))) {
            this.toastr.warning(this.translate.instant('calibration.need-reference'));
            return;
        }
        this.calibrationService.addPoint(this.view.session.id, Number(this.newReferenceValue), this.view.session.revision)
            .subscribe((created: any) => {
                this.newReferenceValue = null;
                if (created && created.id) { this._startSample(created.id); } else { this.reload(); }
            }, err => this._error(err));
    }

    onResample(point: CalibrationPoint) { this._startSample(point.id); }

    private _startSample(pointId: string) {
        if (!this.view) { return; }
        this.sampling = true;
        this.liveAccepted = 0;
        this.liveRejected = 0;
        this.liveTarget = 0;
        this.calibrationService.startSample(this.view.session.id, pointId, this.view.session.revision)
            .subscribe(() => this.reload(), err => {
                this.sampling = false;
                this._error(err);
            });
    }

    onCancelSample() {
        if (!this.view) { return; }
        this.calibrationService.cancelSample(this.view.session.id)
            .subscribe(() => { this.sampling = false; }, () => { this.sampling = false; });
    }

    onDeletePoint(point: CalibrationPoint) {
        if (!this.view) { return; }
        this.calibrationService.deletePoint(this.view.session.id, point.id, this.view.session.revision)
            .subscribe(() => this.reload(), err => this._error(err));
    }

    onFit() {
        if (!this.view) { return; }
        this.calibrationService.fit(this.view.session.id, this.view.session.revision)
            .subscribe(() => this.reload(), err => this._error(err));
    }

    onSubmit() {
        if (!this.view) { return; }
        this.calibrationService.submit(this.view.session.id, this.view.session.revision)
            .subscribe(() => this.reload(), err => this._error(err));
    }

    onApprove() {
        if (!this.view) { return; }
        this.calibrationService.approve(this.view.session.id, this.view.session.revision, this.view.session.fitHash || '')
            .subscribe(() => this.reload(), err => this._error(err));
    }

    onReject() {
        if (!this.view) { return; }
        this.calibrationService.reject(this.view.session.id, '')
            .subscribe(() => this.reload(), err => this._error(err));
    }

    /**
     * Confirm the write, then apply it.
     *
     * Was a bare `confirm()` with a \n-joined summary (R5). Writing to an instrument is the one
     * irreversible action in this page, so the confirmation is worth showing properly: themed,
     * translatable, and not suppressed in an embedded view.
     */
    onConfirmAndApply() {
        if (!this.view) { return; }
        const summary = this._writeSummary();
        this.dialog.open(ConfirmDialogComponent, {
            data: { msg: this.translate.instant('calibration.confirm-write') + '  ' + summary },
            position: { top: '60px' }
        }).afterClosed().subscribe((confirmed: boolean) => {
            if (!confirmed || !this.view) { return; }
            this.calibrationService.confirm(this.view.session.id, this.view.session.revision, this.view.session.fitHash || '')
                .subscribe(token => {
                    const key = this._uuid();
                    this.calibrationService.apply(this.view!.session.id, {
                        revision: this.view!.session.revision,
                        fitHash: this.view!.session.fitHash || '',
                        confirmationToken: token.confirmationToken
                    }, key).subscribe(() => this.reload(), err => this._error(err));
                }, err => this._error(err));
        });
    }

    onCancelSession() {
        if (!this.view) { return; }
        this.calibrationService.cancelSession(this.view.session.id, this.view.session.revision)
            .subscribe(() => this.reload(), err => this._error(err));
    }

    onExport(format: 'json' | 'csv') {
        if (!this.view) { return; }
        this.calibrationService.exportSession(this.view.session.id, format).subscribe((blob: Blob) => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = this.view!.session.id + '.' + format;
            a.click();
            URL.revokeObjectURL(a.href);
        }, err => this._error(err));
    }

    private _writeSummary(): string {
        const w = this.view && this.view.profile ? this.view.profile.write : null;
        if (!w) { return ''; }
        const fit = this.view!.session.fit;
        if (w.mode === 'tags') {
            const tw: any = w;
            return this.translate.instant('calibration.write-mode') + ': tags\n' +
                'gain  <- ' + tw.gainTagId + ' = ' + (fit ? fit.gain : '?') + '\n' +
                'offset<- ' + tw.offsetTagId + ' = ' + (fit ? fit.offset : '?');
        }
        const rw: any = w;
        return this.translate.instant('calibration.write-mode') + ': raw-block\n' +
            'device ' + rw.deviceId + ' @' + rw.startAddress + ' (base ' + rw.addressBase + ') ' +
            rw.numericType + ' ' + rw.wordOrder;
    }

    private _uuid(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    private _error(err: any) {
        const msg = err && err.error && err.error.message ? err.error.message : (err.message || err);
        const code = err && err.error && err.error.error ? err.error.error : '';
        if (code === 'CAL_REVISION_CONFLICT') {
            this.toastr.warning(this.translate.instant('calibration.revision-conflict'));
            this.reload();
        } else if (code === 'CAL_SECURITY_DISABLED') {
            this.toastr.error(this.translate.instant('calibration.security-disabled'));
        } else {
            this.toastr.error(code ? code + ': ' + msg : '' + msg);
        }
    }

    // ------------------------------------------------------------- charts

    /** Linear-regression scatter + fit line, in SVG user units. */
    get regChart(): any {
        const fit = this.view && this.view.session.fit;
        if (!fit || !fit.residuals || !fit.residuals.length) { return null; }
        const W = 560, H = 320, P = 48;

        const xs = fit.residuals.map(r => r.raw);
        const dMin = Math.min(...xs), dMax = Math.max(...xs);
        let xMin = dMin, xMax = dMax;
        if (xMax - xMin < 1e-9) { xMin -= 1; xMax += 1; }
        const xPad = (xMax - xMin) * 0.14;
        xMin -= xPad; xMax += xPad;

        const yAt = (x: number) => fit.gain * x + fit.offset;
        const yCand = fit.residuals.map(r => r.reference).concat([yAt(dMin), yAt(dMax)]);
        let yMin = Math.min(...yCand), yMax = Math.max(...yCand);
        if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
        const yPad = (yMax - yMin) * 0.12;
        yMin -= yPad; yMax += yPad;

        const sx = (x: number) => P + (x - xMin) / (xMax - xMin) * (W - 2 * P);
        const sy = (y: number) => H - P - (y - yMin) / (yMax - yMin) * (H - 2 * P);

        const points = fit.residuals.map(r => ({
            cx: sx(r.raw), cy: sy(r.reference),
            raw: r.raw, ref: r.reference, res: r.residual
        }));

        const xTicks = this._ticks(xMin, xMax, 5).map(t => ({ x: sx(t), label: this._fmt(t) }));
        const yTicks = this._ticks(yMin, yMax, 5).map(t => ({ y: sy(t), label: this._fmt(t) }));

        return {
            W, H, P,
            points,
            line: { x1: sx(dMin), y1: sy(yAt(dMin)), x2: sx(dMax), y2: sy(yAt(dMax)) },
            xTicks, yTicks,
            plot: { x: P, y: P, w: W - 2 * P, h: H - 2 * P }
        };
    }

    /** Chronological sample trend for the most recent point (SVG user units). */
    get trendChart(): any {
        if (!this.lastSamples || this.lastSamples.length < 2) { return null; }
        const series = this.lastSamples.slice().reverse(); // chronological, newest last
        const W = 560, H = 180, P = 34;

        const vals = series.map(s => s.value).filter(v => v !== null && v !== undefined) as number[];
        if (vals.length < 2) { return null; }
        let vMin = Math.min(...vals), vMax = Math.max(...vals);
        if (vMax - vMin < 1e-9) { vMin -= 1; vMax += 1; }
        const pad = (vMax - vMin) * 0.15;
        vMin -= pad; vMax += pad;

        const n = series.length;
        const sx = (i: number) => P + (n <= 1 ? 0 : i / (n - 1)) * (W - 2 * P);
        const sy = (v: number) => H - P - (v - vMin) / (vMax - vMin) * (H - 2 * P);

        const dots: any[] = [];
        const path: string[] = [];
        series.forEach((s, i) => {
            if (s.value === null || s.value === undefined) { return; }
            const cx = sx(i), cy = sy(s.value);
            dots.push({ cx, cy, ok: !!s.accepted, value: s.value });
            path.push((path.length ? 'L' : 'M') + cx.toFixed(1) + ' ' + cy.toFixed(1));
        });

        const lastPoint = this.view.points.length ? this.view.points[this.view.points.length - 1] : null;
        const mean = lastPoint && lastPoint.stats ? lastPoint.stats.mean : null;

        return {
            W, H, P,
            dots,
            d: path.join(' '),
            meanY: mean !== null && mean !== undefined ? sy(mean) : null,
            meanLabel: mean !== null && mean !== undefined ? this._fmt(mean) : '',
            plot: { x: P, y: P, w: W - 2 * P, h: H - 2 * P }
        };
    }

    get residualRows(): any[] {
        const fit = this.view && this.view.session.fit;
        return fit && fit.residuals ? fit.residuals : [];
    }

    private _ticks(min: number, max: number, count: number): number[] {
        const out: number[] = [];
        for (let i = 0; i <= count; i++) { out.push(min + (max - min) * i / count); }
        return out;
    }

    private _fmt(v: number): string {
        if (!Number.isFinite(v)) { return ''; }
        const a = Math.abs(v);
        if (a !== 0 && (a < 0.01 || a >= 100000)) { return v.toExponential(1); }
        return (Math.round(v * 1000) / 1000).toString();
    }
}
