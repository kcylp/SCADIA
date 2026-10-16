import { Component, OnInit, AfterViewInit, OnDestroy, Input, ViewChild, Output, EventEmitter, TemplateRef } from '@angular/core';
import { MatTable as MatTable, MatTableDataSource as MatTableDataSource } from '@angular/material/table';
import { MatPaginator as MatPaginator } from '@angular/material/paginator';
import { MatSort } from '@angular/material/sort';
import { Subject, timer, empty, firstValueFrom, Subscription } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../_services/auth.service';
import { EndPointApi } from '../../_helpers/endpointapi';
import { takeUntil, switchMap, catchError, timeout, filter } from 'rxjs/operators';

import { HmiService } from '../../_services/hmi.service';
import { TranslateService } from '@ngx-translate/core';
import { AlarmBaseType, AlarmColumns, AlarmHistoryColumns, AlarmPriorityType, AlarmQuery, AlarmStatusType } from '../../_models/alarm';
import { FormControl, FormGroup } from '@angular/forms';

import * as moment from 'moment';
import { ConfirmDialogComponent } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { LanguageService } from '../../_services/language.service';

@Component({
    selector: 'app-alarm-view',
    templateUrl: './alarm-view.component.html',
    styleUrls: ['./alarm-view.component.scss']
})
export class AlarmViewComponent implements OnInit, AfterViewInit, OnDestroy {

    alarmsColumns = AlarmColumns;
    historyColumns = AlarmHistoryColumns;
    displayColumns: string[] = AlarmColumns;

    showheader = false;
    /** Date/time pattern of the current language; see SHIPPED_LOCALE_FORMATS. */
    dateTimePattern = 'yyyy.MM.dd HH:mm:ss';
    currentShowMode = 'collapse';
    alarmsPolling: any;
    statusText = AlarmStatusType;
    priorityText = AlarmPriorityType;
    alarmShowType = AlarmShowType;
    showType = AlarmShowType.alarms;
    history = [];
    alarmsLoading = false;
    message = '';
    ackPending = new Set<string>();
    evidence: any = null;
    evidenceMessage = '';
    evidenceFrames: any[] = [];
    private evidenceSubscriptions = new Subscription();
    private evidenceDialog: MatDialogRef<any>;
    private identitySubscription: Subscription;
    private identity = '';
    private identityChanged = new Subject<void>();
    @ViewChild('sceneEvidence') sceneEvidence: TemplateRef<any>;
    dateRange: FormGroup;

    @Input() autostart = false;
    @Input() showInContainer = false;
    @Input() fullview = true;
    @Output() showMode: EventEmitter<string> = new EventEmitter();

    dataSource = new MatTableDataSource([]);
    @ViewChild(MatTable, {static: false}) table: MatTable<any>;
    @ViewChild(MatSort, {static: false}) sort: MatSort;
    @ViewChild(MatPaginator, {static: false}) paginator: MatPaginator;

    private rxjsPollingTimer = timer(0, 2000);
    private destroy = new Subject<void>();

    constructor(private auth: AuthService,
                private route: ActivatedRoute,
                private http: HttpClient,
                private translateService: TranslateService,
                private dialog: MatDialog,
                private languageService: LanguageService,
                private hmiService: HmiService) {
        const today = moment();
        this.dateRange = new FormGroup({
            endDate: new FormControl(today.set({hour: 23, minute: 59, second: 59, millisecond: 999}).toDate()),
            startDate: new FormControl(today.set({hour: 0, minute: 0, second: 0, millisecond: 0}).add(-3, 'day').toDate())
        });
    }

    ngOnInit() {
        this.identitySubscription = this.auth.currentUser$.subscribe(user => {
            const identity = JSON.stringify([user?.username, user?.groups, user?.info, user?.token]);
            if (identity === this.identity) { return; }
            this.identity = identity; this.identityChanged.next(); this.alarmsLoading = false; this.message = '';
            this.dataSource.data = []; this.clearEvidence(); this.evidenceDialog?.close();
        });
        // Status and priority labels used to be translated once, in place, straight into the
        // shared enums. That made the labels of every other alarm view stale, and left this
        // one showing the previous language after the operator switched - which the unified
        // language switch made visible. They are resolved on demand now.
        this.dateTimePattern = this.languageService.localeFormat().dateTime;
        this.languageService.languageConfig$.pipe(takeUntil(this.destroy)).subscribe(() => {
            // Timestamps follow the language too: 2026.12.31 for Chinese, 12/31/2026 for
            // English, 31.12.2026 for Russian.
            this.dateTimePattern = this.languageService.localeFormat().dateTime;
        });
    }

    ngAfterViewInit() {
        this.displayColumns = this.alarmsColumns;
        this.dataSource.paginator = this.paginator;
        this.dataSource.sort = this.sort;
        this.table.renderRows();
        if (this.autostart || this.route.snapshot.routeConfig?.path === 'alarms') {
            this.startAskAlarmsValues();
        }
    }

    ngOnDestroy() {
        this.identitySubscription?.unsubscribe(); this.identityChanged.next(); this.identityChanged.complete();
        this.clearEvidence();
        this.evidenceDialog?.close();
        this.stopAskAlarmsValues();
    }

    startAskAlarmsValues() {
        this.startPolling();
    }

    stopAskAlarmsValues() {
        this.stopPolling();
    }

    private stopPolling() {
        this.alarmsPolling = 0;
        this.destroy.next(null);
        this.destroy.complete();
    }

    private startPolling() {
        try {
            if (!this.alarmsPolling) {
                this.alarmsPolling = 1;
                this.destroy = new Subject();
                this.rxjsPollingTimer.pipe(takeUntil(this.destroy),
                    switchMap(() => {
                        const identity = this.identity;
                        return this.hmiService.getAlarmsValues().pipe(
                            filter(() => identity === this.identity), catchError((er) => this.handleError(er)));
                    })).subscribe(result => {
                        this.updateAlarmsList(result);
                    });
            }
        } catch (error) {
        }
    }

    private handleError(error: any) {
        this.message = error.status === 401 || error.status === 403 ? '登录或权限不足，请重新登录。' : '报警读取失败，请检查连接；当前显示上次数据。';
        return empty();
    }

    updateAlarmsList(alr: AlarmBaseType[]) {
        if (this.showType === AlarmShowType.alarms) {
            alr.forEach(alr => {
                alr.text = this.formatAlarmText(alr.text, alr.value);
                alr.group = this.languageService.getTranslation(alr.group) ?? alr.group;
                alr.status = this.getStatus(alr.status);
                alr.type = this.getPriority(alr.type);
            });
            this.dataSource.data = alr;
        }
    }

    /** Resolve a status code to its label in the language that is current right now. */
    getStatus(status: string) {
        const key = this.statusText[status];
        return key ? this.translateService.instant(key) : status;
    }

    /** Resolve a priority code to its label in the language that is current right now. */
    getPriority(type: string) {
        const key = this.priorityText[type];
        return key ? this.translateService.instant(key) : type;
    }

    async onAckAlarm(alarm: any) {
        if (this.ackPending.has(alarm.name)) { return; }
        this.ackPending.add(alarm.name);
        const identity = this.identity;
        try {
            if (alarm.eventId) {
                await firstValueFrom(this.http.post(EndPointApi.getURL() + '/api/alarmack', { params: alarm.name, expectedOntime: Number(alarm.ontime) }).pipe(timeout(8000), takeUntil(this.destroy)));
                if (identity !== this.identity) { return; }
                const saved = await firstValueFrom(this.http.get<any>(EndPointApi.getURL() + '/api/ai/scene-events/' + alarm.eventId + '/evidence-manifest').pipe(timeout(8000), takeUntil(this.destroy)));
                if (identity !== this.identity) { return; }
                if (saved.eventId !== alarm.eventId || saved.at !== alarm.ontime || !saved.ackAt) { throw new Error('事件确认回读失败，请刷新核验'); }
                this.message = '已确认，事件账本回读通过；历史与证据继续保留。';
            } else {
                await firstValueFrom(this.hmiService.setAlarmAck(alarm.name).pipe(timeout(8000), takeUntil(this.destroy)));
                if (identity === this.identity) { this.message = '确认已提交，请核验报警状态。'; }
            }
        } catch (error) { if (identity !== this.identity) { return; } this.message = error.status === 401 || error.status === 403 ? '登录或权限不足，请重新登录后重试。' : '确认失败或回读未完成，请刷新核验后重试。'; }
        finally { this.ackPending.delete(alarm.name); }
    }

    openEvidence(alarm: any) {
        this.clearEvidence();
        this.evidence = alarm;
        const ref = this.evidenceDialog = this.dialog.open(this.sceneEvidence, { width: '960px', maxWidth: '94vw', maxHeight: '88vh', autoFocus: true });
        ref.afterClosed().subscribe(() => { this.clearEvidence(); this.evidence = null; this.evidenceDialog = null; });
        this.loadEvidence();
    }

    private clearEvidence() {
        this.evidenceSubscriptions.unsubscribe(); this.evidenceSubscriptions = new Subscription();
        this.evidenceFrames.forEach(frame => { if (frame.url) { URL.revokeObjectURL(frame.url); } });
        this.evidenceFrames = [];
    }

    loadEvidence() {
        this.clearEvidence();
        const alarm = this.evidence;
        this.evidenceMessage = '正在读取历史证据…';
        const base = EndPointApi.getURL() + '/api/ai/scene-events/' + alarm.eventId;
        this.evidenceSubscriptions.add(this.http.get<any>(base + '/evidence-manifest').pipe(timeout(8000)).subscribe({
            next: event => {
                if (event.eventId !== alarm.eventId || Number(event.at) !== Number(alarm.ontime) || !Array.isArray(event.frames)) { this.evidenceMessage = '事件身份不匹配，请刷新重试。'; return; }
                this.evidenceMessage = (event.ackAt ? '人工已确认' : '人工尚未确认') + '；复核：' + (event.review?.verdict || event.reviewStatus || '尚无结果') + (event.review?.text ? ' · ' + event.review.text : '') + '。共登记 ' + event.frames.length + ' 帧。';
                this.evidenceFrames = event.frames.map(frame => ({ at: frame.at, error: frame.available ? '' : '原图缺失', url: '', loading: frame.available }));
                event.frames.forEach((frame, i) => {
                    const item = this.evidenceFrames[i];
                    if (!frame.available) { return; }
                    if (frame.url !== '/api/ai/scene-events/' + alarm.eventId + '/evidence?frame=' + i) { item.error = '证据身份不匹配'; item.loading = false; return; }
                    this.evidenceSubscriptions.add(this.http.get(EndPointApi.getURL() + frame.url, { responseType: 'blob' }).pipe(timeout(8000)).subscribe({
                        next: blob => { item.url = URL.createObjectURL(blob); item.loading = false; },
                        error: () => { item.error = '图片读取失败，请刷新证据重试'; item.loading = false; }
                    }));
                });
            },
            error: e => { this.evidenceMessage = e.status === 401 || e.status === 403 ? '登录或权限不足，请重新登录。' : '历史证据读取失败，请刷新重试。'; }
        }));
    }

    onAckAllAlarm() {
        let dialogRef = this.dialog.open(ConfirmDialogComponent, {
            data: {
                msg: this.translateService.instant('msg.alarm-ack-all') + '（仅变量报警；场景事件请逐条确认）'
            },
            position: {
                top: '60px'
            }
        });

        dialogRef.afterClosed().subscribe(result => {
            if (result) {
                this.hmiService.setAlarmAck(null).subscribe(result => {
                }, error => {
                    console.error('Error onAckAllAlarm', error);
                });
            }
        });
    }

    onShowMode(mode: string) {
        this.currentShowMode = mode;
        this.showMode.emit(this.currentShowMode);
    }

    onClose() {
        this.onShowAlarms();
        this.currentShowMode = 'collapse';
        this.showMode.emit('close');
        this.stopAskAlarmsValues();
    }

    onShowAlarms() {
        this.showType = AlarmShowType.alarms;
        this.startAskAlarmsValues();
        this.displayColumns = this.alarmsColumns;
    }

    onShowAlarmsHistory() {
        console.log(new Date(this.dateRange.value.startDate), new Date(this.dateRange.value.endDate));
        this.showType = AlarmShowType.history;
        this.displayColumns = this.historyColumns;
        let query: AlarmQuery = <AlarmQuery>{
            start: new Date(new Date(this.dateRange.value.startDate).setHours(0, 0, 0, 0)),
            end: new Date(new Date(this.dateRange.value.endDate).setHours(23, 59, 59, 999))
        };
        this.alarmsLoading = true;
        const identity = this.identity;
        this.hmiService.getAlarmsHistory(query).pipe(
            timeout(8000), takeUntil(this.destroy), takeUntil(this.identityChanged), filter(() => identity === this.identity)
        ).subscribe(result => {
            if (result) {
                result.forEach(alr => {
                    alr.text = this.formatAlarmText(alr.text, alr.value);
                    // The live list translated the group but the history path did not, so a
                    // Russian operator reading yesterday's alarms saw the Chinese group name.
                    alr.group = this.languageService.getTranslation(alr.group) ?? alr.group;
                    alr.status = this.getStatus(alr.status);
                    alr.type = this.getPriority(alr.type);
                });
                this.dataSource.data = result;
            }
		    this.alarmsLoading = false;
        }, () => { this.alarmsLoading = false; this.message = '报警历史读取失败，请检查登录与连接后重试。'; });
    }

    private formatAlarmText(text: string, value: any): string {
        const translatedText = this.languageService.getTranslation(text) ?? text;
        if (translatedText && value !== undefined && value !== null) {
            return translatedText.split('%d').join(String(value));
        }
        return translatedText;
    }
}

export enum AlarmShowType {
    alarms,
    history
}
