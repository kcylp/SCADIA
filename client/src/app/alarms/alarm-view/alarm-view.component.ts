import { Component, OnInit, AfterViewInit, OnDestroy, Input, ViewChild, Output, EventEmitter } from '@angular/core';
import { MatTable as MatTable, MatTableDataSource as MatTableDataSource } from '@angular/material/table';
import { MatPaginator as MatPaginator } from '@angular/material/paginator';
import { MatSort } from '@angular/material/sort';
import { Subject, timer, empty } from 'rxjs';
import { takeUntil, switchMap, catchError, delay } from 'rxjs/operators';

import { HmiService } from '../../_services/hmi.service';
import { TranslateService } from '@ngx-translate/core';
import { AlarmBaseType, AlarmColumns, AlarmHistoryColumns, AlarmPriorityType, AlarmQuery, AlarmStatusType } from '../../_models/alarm';
import { FormControl, FormGroup } from '@angular/forms';

import * as moment from 'moment';
import { ConfirmDialogComponent } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';
import { MatDialog as MatDialog } from '@angular/material/dialog';
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
    dateRange: FormGroup;

    /**
     * Poll the alarm values as soon as the view is up.
     *
     * Defaults to TRUE because the routed page (#/alarms) cannot turn it on: a route renders its
     * component with no input bindings, so before this the standalone 实时报警 page ran with
     * autostart=false, ngAfterViewInit skipped startAskAlarmsValues(), and the table was empty for
     * every user no matter how many alarms were configured or firing. A page about live alarms that
     * never asks for them is not a configuration problem.
     *
     * Embedders that want to drive it themselves bind [autostart]="false" - home.component does,
     * and starts polling on its own once the alarm panel is shown (home.component.ts:372). The call
     * is idempotent (startPolling returns early when already polling).
     */
    @Input() autostart = true;
    @Input() showInContainer = false;
    @Input() fullview = true;
    @Output() showMode: EventEmitter<string> = new EventEmitter();

    dataSource = new MatTableDataSource([]);
    @ViewChild(MatTable, {static: false}) table: MatTable<any>;
    @ViewChild(MatSort, {static: false}) sort: MatSort;
    @ViewChild(MatPaginator, {static: false}) paginator: MatPaginator;

    private rxjsPollingTimer = timer(0, 2000);
    private destroy = new Subject<void>();

    constructor(private translateService: TranslateService,
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
        if (this.autostart) {
            this.startAskAlarmsValues();
        }
    }

    ngOnDestroy() {
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
                    switchMap(() =>
                        this.hmiService.getAlarmsValues().pipe(
                            catchError((er) => this.handleError(er)))
                    )).subscribe(result => {
                        this.updateAlarmsList(result);
                    });
            }
        } catch (error) {
        }
    }

    private handleError(error: any) {
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

    onAckAlarm(alarm: any) {
        this.hmiService.setAlarmAck(alarm.name).subscribe(result => {
        }, error => {
            console.error('Error setAlarmAck', error);
        });
    }

    onAckAllAlarm() {
        let dialogRef = this.dialog.open(ConfirmDialogComponent, {
            data: {
                msg: this.translateService.instant('msg.alarm-ack-all')
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
        this.hmiService.getAlarmsHistory(query).pipe(
            delay(1000)
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
        });
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
