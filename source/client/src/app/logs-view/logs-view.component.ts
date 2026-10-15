import { Component, AfterViewInit, ViewChild, ElementRef } from '@angular/core';

import { UntypedFormControl } from '@angular/forms';
import { MatTable as MatTable, MatTableDataSource as MatTableDataSource } from '@angular/material/table';
import { MatPaginator as MatPaginator } from '@angular/material/paginator';
import { MatSort } from '@angular/material/sort';

import { DiagnoseService } from '../_services/diagnose.service';
import { AppService } from '../_services/app.service';
import { LogsRequest } from '../_models/diagnose';

@Component({
    selector: 'app-logs-view',
    templateUrl: './logs-view.component.html',
    styleUrls: ['./logs-view.component.css']
})
export class LogsViewComponent implements AfterViewInit {

    @ViewChild(MatTable, {static: false}) table: MatTable<any>;
    @ViewChild(MatSort, {static: false}) sort: MatSort;
    @ViewChild(MatPaginator, {static: false}) paginator: MatPaginator;
    @ViewChild('workPanel', {static: false}) workPanel: ElementRef;
    @ViewChild('textContent', {static: false}) textContent: ElementRef;

    dataSource = new MatTableDataSource([]);
    ontimeFilter = new UntypedFormControl();
    typeFilter = new UntypedFormControl();
    sourceFilter = new UntypedFormControl();
    textFilter = new UntypedFormControl();

    filteredValues = {
        ontime: '', source: '', type: '', text: ''
    };

    readonly displayColumns = ['ontime', 'type', 'source', 'text'];
    tableView = false;
    content = '';
    logs = { selected: 'scadia.log', files: [] };

    constructor(private diagnoseService: DiagnoseService,
                private appService: AppService) { }

    ngAfterViewInit() {
        this.diagnoseService.getLogsDir().subscribe(result => {
            this.logs.files = result;
        }, err => {
            console.error('get Logs err: ' + err);
        });

        this.loadLogs(this.logs.selected);
    }

    loadLogs(logfile: string) {
        this.appService.showLoading(true);
        this.diagnoseService.getLogs(<LogsRequest>{ file: logfile }).subscribe(result => {
            this.content = this.renderLogBody(result.body);
            this.appService.showLoading(false);
        }, err => {
            this.appService.showLoading(false);
            console.error('get Logs err: ' + err);
        });
    }

    // A log file can be hundreds of thousands of characters, and rendering it as a single
    // innerHTML string froze the whole page (batch 90-AD: measured 213,112 chars in one render,
    // from a log of only 2,077 lines - a line cap alone is toothless for long lines).
    // Cap by characters first, lines second; diagnose pages are read tail-first.
    renderLogBody(body: string): string {
        const MAX_RENDERED_CHARS = 50000;
        const MAX_RENDERED_LINES = 2000;
        let text = (body || '').replace(/\r/g, '');
        let note = '';
        if (text.length > MAX_RENDERED_CHARS) {
            const omitted = text.length - MAX_RENDERED_CHARS;
            text = text.slice(-MAX_RENDERED_CHARS);
            const firstBreak = text.indexOf('\n');
            if (firstBreak > 0) { text = text.slice(firstBreak + 1); }
            note = '... ' + omitted + ' earlier character(s) omitted - rendering the tail ...<br />';
        }
        const lines = text.split('\n');
        if (lines.length > MAX_RENDERED_LINES) {
            note += '... ' + (lines.length - MAX_RENDERED_LINES) + ' earlier line(s) omitted ...<br />';
            text = lines.slice(-MAX_RENDERED_LINES).join('\n');
        }
        return note + text.replace(new RegExp('\n', 'g'), '<br />');
    }

    scrollToTop() {
        if (this.tableView && this.workPanel) {
            this.workPanel.nativeElement.scrollTop = 0;
        } else if (!this.tableView && this.textContent) {
            this.textContent.nativeElement.scrollTop = 0;
        }
    }

    scrollToBottom() {
        if (this.tableView && this.workPanel) {
            this.workPanel.nativeElement.scrollTop = this.workPanel.nativeElement.scrollHeight;
        } else if (!this.tableView && this.textContent) {
            this.textContent.nativeElement.scrollTop = this.textContent.nativeElement.scrollHeight;
        }
    }
}
