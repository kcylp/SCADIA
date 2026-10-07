import { Component, OnInit, OnDestroy } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';

import { CalibrationService } from '../../_services/calibration.service';
import { CalibrationProfile, CalibrationSession, CalibrationStatus } from '../../_models/calibration';
import { ConfirmDialogComponent } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';

/**
 * Calibration console: a SCADA-style overview of profiles and sessions.
 */
@Component({
    selector: 'app-calibration-list',
    templateUrl: './calibration-list.component.html',
    styleUrls: ['./calibration-list.component.css']
})
export class CalibrationListComponent implements OnInit, OnDestroy {

    profiles: CalibrationProfile[] = [];
    sessions: CalibrationSession[] = [];
    loading = false;
    meta: any = null;
    private subscription = new Subscription();

    constructor(
        private calibrationService: CalibrationService,
        private router: Router,
        private dialog: MatDialog,
        private translate: TranslateService,
        private toastr: ToastrService
    ) {
    }

    ngOnInit() {
        this.load();
    }

    ngOnDestroy() {
        this.subscription.unsubscribe();
    }

    load() {
        this.loading = true;
        this.calibrationService.getMeta().subscribe(meta => {
            this.meta = meta;
        }, () => { this.meta = null; });
        this.calibrationService.getProfiles().subscribe(result => {
            this.profiles = result.profiles || [];
            this.calibrationService.getSessions().subscribe(res => {
                this.sessions = (res.sessions || []).slice(0, 100);
                this.loading = false;
            }, err => {
                this.loading = false;
                this._error(err);
            });
        }, err => {
            this.loading = false;
            this._error(err);
        });
    }

    // ------------------------------------------------------------- KPI counts

    get activeCount(): number {
        return this.sessions.filter(s =>
            ['draft', 'sampling', 'ready', 'fitted', 'approved', 'writing', 'verifying'].indexOf(s.status) >= 0).length;
    }

    get awaitingCount(): number {
        return this.sessions.filter(s => s.status === 'awaiting-approval').length;
    }

    get doneCount(): number {
        return this.sessions.filter(s => s.status === 'applied').length;
    }

    get failedCount(): number {
        return this.sessions.filter(s => s.status === 'failed' || s.status === 'uncertain').length;
    }

    // ------------------------------------------------------------- helpers

    statusLabel(status: CalibrationStatus | string): string {
        return this.translate.instant('calibration.st.' + status);
    }

    /** LED/pill severity for a calibration status */
    statusTone(status: string): string {
        switch (status) {
            case 'applied': return 'ok';
            case 'failed': return 'alarm';
            case 'uncertain': return 'warn';
            case 'awaiting-approval': return 'warn';
            case 'approved': return 'ok';
            case 'sampling':
            case 'writing':
            case 'verifying': return 'info';
            case 'canceled': return 'idle';
            default: return 'idle';
        }
    }

    profileName(profileId: string): string {
        const p = this.profiles.find(x => x.id === profileId);
        return p ? p.name : profileId;
    }

    // ------------------------------------------------------------- actions

    onCreateSession(profile: CalibrationProfile) {
        this.calibrationService.createSession(profile.id).subscribe(session => {
            this.router.navigate(['/calibrations', session.id]);
        }, err => this._error(err));
    }

    onOpenSession(session: CalibrationSession) {
        this.router.navigate(['/calibrations', session.id]);
    }

    onRemoveSession(session: CalibrationSession) {
        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
            data: { title: 'msg.delete-element-title', text: session.id }
        });
        this.subscription.add(dialogRef.afterClosed().subscribe(result => {
            if (result === 'ok') {
                this.calibrationService.cancelSession(session.id, session.revision).subscribe(() => {
                    this.load();
                }, err => this._error(err));
            }
        }));
    }

    onDeleteProfile(profile: CalibrationProfile) {
        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
            data: { title: 'msg.delete-element-title', text: profile.name }
        });
        this.subscription.add(dialogRef.afterClosed().subscribe(result => {
            if (result === 'ok') {
                this.calibrationService.deleteProfile(profile.id).subscribe(() => {
                    this.load();
                }, err => this._error(err));
            }
        }));
    }

    private _error(err: any) {
        const msg = err && err.error && err.error.message ? err.error.message : (err.message || err);
        if (err && err.error && err.error.error) {
            this.toastr.error(`${err.error.error}: ${msg}`);
        } else {
            this.toastr.error('' + msg);
        }
    }
}
