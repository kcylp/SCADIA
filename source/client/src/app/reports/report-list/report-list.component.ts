import { animate, state, style, transition, trigger } from '@angular/animations';
import { AfterViewInit, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { MatDialog as MatDialog } from '@angular/material/dialog';
import { MatSort } from '@angular/material/sort';
import { MatTable as MatTable, MatTableDataSource as MatTableDataSource } from '@angular/material/table';
import { TranslateService } from '@ngx-translate/core';
import { Subscription, concatMap, timer } from 'rxjs';
import { Utils } from '../../_helpers/utils';
import { Report, ReportSchedulingType, REPORT_PREFIX } from '../../_models/report';
import { CommandService } from '../../_services/command.service';
import { ProjectService } from '../../_services/project.service';
import { ReportEditorComponent, ReportEditorData } from '../report-editor/report-editor.component';
import * as FileSaver from 'file-saver';
import { ReportsService } from '../../_services/reports.service';
import { AuthService } from '../../_services/auth.service';
import { EndPointApi } from '../../_helpers/endpointapi';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../gui-helpers/confirm-dialog/confirm-dialog.component';

@Component({
    selector: 'app-report-list',
    templateUrl: './report-list.component.html',
    styleUrls: ['./report-list.component.css'],
    animations: [
        trigger('detailExpand', [
          state('collapsed', style({height: '0px', minHeight: '0'})),
          state('expanded', style({height: '*'})),
          transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
        ]),
      ],
})
export class ReportListComponent implements OnInit, AfterViewInit, OnDestroy {

    displayedColumns = ['select', 'name', 'receiver', 'scheduling', 'type', 'expand', 'create', 'remove'];
    dataSource = new MatTableDataSource([]);

    private subscriptionLoad: Subscription;
    private schedulingType = ReportSchedulingType;
    expandedElement: Report | null;
    currentDetails: string[];

    // 账号活动台账（登录/失败/注销/退出）——报表页的第二个视图。
    view: 'reports' | 'activity' = 'reports';
    activityRows: any[] = [];
    activityTotal = 0;
    activityLimit = 50;
    activityOffset = 0;
    activityLoading = false;
    activityError = '';
    activityNote = '';
    actionOptions = [
        { id: '', label: '全部动作' },
        { id: 'login', label: '登录' },
        { id: 'login_failed', label: '登录失败' },
        { id: 'logout', label: '注销' },
        { id: 'exit', label: '退出（关闭页面）' },
        { id: 'session_timeout', label: '会话超时' }
    ];
    filters = { from: '', to: '', username: '', action: '' };
    readonly activityColumns = ['time', 'username', 'fullname', 'action', 'result', 'clientIp'];

    @ViewChild(MatTable, {static: false}) table: MatTable<any>;
    @ViewChild(MatSort, {static: false}) sort: MatSort;

    constructor(public dialog: MatDialog,
        private translateService: TranslateService,
        private projectService: ProjectService,
        private commandService: CommandService,
        private reportsService: ReportsService,
        private http: HttpClient,
        private authService: AuthService) { }

    get isAdmin(): boolean {
        return this.authService.isAdmin();
    }

    get activityPage(): number {
        return Math.floor(this.activityOffset / this.activityLimit) + 1;
    }

    get activityPages(): number {
        return Math.max(Math.ceil(this.activityTotal / this.activityLimit), 1);
    }

    ngOnInit() {
        this.loadReports();
        this.subscriptionLoad = this.projectService.onLoadHmi.subscribe(res => {
            this.loadReports();
        });
        this.resetActivityWindow();

        Object.keys(this.schedulingType).forEach(key => {
            this.translateService.get(this.schedulingType[key]).subscribe((txt: string) => { this.schedulingType[key] = txt; });
        });
    }

    ngAfterViewInit() {
        this.dataSource.sort = this.sort;
    }

    ngOnDestroy() {
        try {
            if (this.subscriptionLoad) {
                this.subscriptionLoad.unsubscribe();
            }
        } catch (e) {
        }
    }

    getScheduling(scheduling: ReportSchedulingType) {
        return this.schedulingType[scheduling] || '';
    }

    onAddReport() {
        this.editReport(new Report(Utils.getGUID(REPORT_PREFIX)), 1);
    }

    onEditReport(report: Report) {
        this.editReport(report, 0);
    }

    onStartReport(report: Report) {
        // 生成请求被接受后，由真实终态（completed/failed）驱动刷新文件列表；
        // 不再用固定 5 秒定时器把上一次产物当作本次结果展示。
        this.reportsService.buildReport(report, () => {
            this.loadDetails(report);
        }).subscribe(() => { }, () => { });
    }

    onRemoveReport(report: Report) {
        this.editReport(report, -1);
    }

    editReport(report: Report, toAdd: number) {
        let dlgwidth = (toAdd < 0) ? 'auto' : '80%';
		let mreport: Report = JSON.parse(JSON.stringify(report));
        let dialogRef = this.dialog.open(ReportEditorComponent, {
            data: <ReportEditorData> {
                report: mreport,
                editmode: toAdd
            },
            width: dlgwidth,
            position: { top: '80px' }
        });
        dialogRef.afterClosed().subscribe(result => {
            if (result) {
                if (toAdd < 0) {
                    this.projectService.removeReport(result).subscribe(result => {
                        this.loadReports();
                    });
				} else {
                    this.projectService.setReport(result, report).subscribe(() => {
                        this.loadReports();
                    });
                }
            }
        });
    }

    private loadReports() {
        this.dataSource.data = this.projectService.getReports().sort((a: Report, b: Report) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }

    toogleDetails(element: Report) {
        this.expandedElement = this.expandedElement === element ? null : element;
        this.loadDetails(this.expandedElement);
    }

    loadDetails(element: Report) {
        this.currentDetails = [];
        if (element) {
            this.reportsService.getReportsDir(element).subscribe(result => {
                this.currentDetails = result;
            }, err => {
                console.error('loadDetails err: ' + err);
            });
        }
    }

    onDownloadDetail(file: string) {
        this.commandService.getReportFile(file).subscribe(content => {
            let blob = new Blob([content], { type: 'application/pdf' });
            FileSaver.saveAs(blob, file);
        }, err => {
            console.error('Download Report File err:', err);
        });
    }

    onRemoveFile(file: string, report: Report) {
        let dialogRef = this.dialog.open(ConfirmDialogComponent, {
            position: { top: '60px' },
            data: <ConfirmDialogData> { msg: this.translateService.instant('msg.file-remove', { value: file }) }
        });

        dialogRef.afterClosed().subscribe((result) => {
            if (result) {
                this.reportsService.removeReportFile(file).pipe(
                    concatMap(() => timer(2000))
                ).subscribe(() => {
                    this.loadDetails(report);
                });
            }
        });
    }

    // ---------------------------------------------------------------- 账号活动台账

    showReports() {
        this.view = 'reports';
    }

    showActivity() {
        this.view = 'activity';
        if (!this.activityRows.length && !this.activityLoading) {
            this.loadActivity(0);
        }
    }

    private toLocalInput(ms: number): string {
        const d = new Date(ms);
        return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }

    private resetActivityWindow() {
        const now = Date.now();
        this.filters.from = this.toLocalInput(now - 7 * 86400000);
        this.filters.to = this.toLocalInput(now);
    }

    loadActivity(offset = 0) {
        const from = this.filters.from ? new Date(this.filters.from).getTime() : null;
        const to = this.filters.to ? new Date(this.filters.to).getTime() : null;
        if ((from && !Number.isFinite(from)) || (to && !Number.isFinite(to))) {
            this.activityError = '时间格式无效，请重新选择起止时间';
            return;
        }
        if (from && to && from >= to) {
            this.activityError = '开始时间必须早于结束时间';
            return;
        }
        const params = new URLSearchParams();
        if (from) { params.set('from', String(from)); }
        if (to) { params.set('to', String(to)); }
        if (this.filters.username.trim()) { params.set('username', this.filters.username.trim()); }
        if (this.filters.action) { params.set('action', this.filters.action); }
        params.set('limit', String(this.activityLimit));
        params.set('offset', String(Math.max(offset, 0)));
        this.activityLoading = true;
        this.activityError = '';
        const headers = new HttpHeaders({ 'Skip-Error': 'true' });
        this.http.get<any>(EndPointApi.getURL() + '/api/accounts/activity?' + params.toString(), { headers }).subscribe({
            next: (result) => {
                this.activityRows = result?.rows || [];
                this.activityTotal = result?.total || 0;
                this.activityOffset = result?.offset || 0;
                this.activityNote = (result?.limitations || []).join(' ');
                this.activityLoading = false;
            },
            error: (err) => {
                this.activityRows = [];
                this.activityTotal = 0;
                this.activityLoading = false;
                this.activityError = err?.status === 403
                    ? '仅管理员可查看账号活动'
                    : (err?.error?.message || '账号活动读取失败');
            }
        });
    }

    prevActivityPage() {
        this.loadActivity(Math.max(this.activityOffset - this.activityLimit, 0));
    }

    nextActivityPage() {
        if (this.activityOffset + this.activityLimit < this.activityTotal) {
            this.loadActivity(this.activityOffset + this.activityLimit);
        }
    }

    activityAction(action: string): string {
        const found = this.actionOptions.find(o => o.id === action);
        return found ? found.label : (action || '');
    }

    activityResult(result: string): string {
        return result === 'denied' ? '拒绝' : result === 'ok' ? '成功' : (result || '');
    }

    activityTime(at: number): string {
        return at ? new Date(at).toLocaleString() : '';
    }

    exportActivity() {
        if (!this.activityRows.length) {
            return;
        }
        const rows = [['时间', '账号', '姓名', '动作', '结果', '来源 IP']];
        for (const row of this.activityRows) {
            rows.push([this.activityTime(row.at), row.username, row.fullname, this.activityAction(row.action), this.activityResult(row.result), row.clientIp]);
        }
        const csv = rows.map(cols => cols.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        FileSaver.saveAs(blob, 'account-activity-' + new Date().toISOString().slice(0, 10) + '.csv');
    }
}

