import { AfterViewInit, Component, Inject, OnDestroy, OnInit } from '@angular/core';
import { AbstractControl, UntypedFormBuilder, UntypedFormGroup, Validators } from '@angular/forms';
import { MatDialog as MatDialog, MatDialogRef as MatDialogRef, MAT_DIALOG_DATA as MAT_DIALOG_DATA } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { Report, ReportDateRangeType, ReportIntervalType, ReportItem, ReportItemAlarms, ReportItemChart, ReportItemTable, ReportItemText, ReportItemType, ReportSchedulingType } from '../../_models/report';
import * as pdfMake from 'pdfmake/build/pdfmake';
import * as pdfFonts from 'pdfmake/build/vfs_fonts';
import { Utils } from '../../_helpers/utils';
import { ReportItemTextComponent } from './report-item-text/report-item-text.component';
import { ReportItemTableComponent } from './report-item-table/report-item-table.component';
import { ReportItemAlarmsComponent } from './report-item-alarms/report-item-alarms.component';
import { AlarmPropertyType, AlarmsType } from '../../_models/alarm';
import { ReportItemChartComponent } from './report-item-chart/report-item-chart.component';
import { ResourcesService } from '../../_services/resources.service';
import { forkJoin, Observable, of, Subject } from 'rxjs';
import { catchError, map, switchMap, takeUntil } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { EndPointApi } from '../../_helpers/endpointapi';
import { ProjectService } from '../../_services/project.service';
import { PluginService } from '../../_services/plugin.service';
import { PluginGroupType } from '../../_models/plugin';
pdfMake.vfs = pdfFonts;

@Component({
    selector: 'app-report-editor',
    templateUrl: './report-editor.component.html',
    styleUrls: ['./report-editor.component.scss']
})
export class ReportEditorComponent implements OnInit, AfterViewInit, OnDestroy {

    myForm: UntypedFormGroup;

    itemTextType = Utils.getEnumKey(ReportItemType, ReportItemType.text);
    itemTableType = Utils.getEnumKey(ReportItemType, ReportItemType.table);
    itemAlarmsType = Utils.getEnumKey(ReportItemType, ReportItemType.alarms);
    itemChartType = Utils.getEnumKey(ReportItemType, ReportItemType.chart);
    fontSize = [6, 8, 10, 12, 14, 16, 18, 20];
    report: Report;
    schedulingType = ReportSchedulingType;
    chartImageAvailable$: Observable<boolean>;
    private destroy$ = new Subject<void>();

    private imagesList = {};

    /**
     * Period boundaries, resolved by the SERVER and cached per range.
     *
     * The editor used to compute them itself, with a copy of the old calendar-midnight logic
     * that the generator has since replaced. Two implementations of the same calendar is how
     * a preview and the PDF it previews drift apart, so the client asks instead of guessing -
     * and gets the production day and shift table for free.
     */
    private periodCache = new Map<string, DateTimeRange>();
    private static readonly PERIOD_ENDPOINT = EndPointApi.getURL() + '/api/report-period';

    constructor(public dialogRef: MatDialogRef<ReportEditorComponent>,
        public dialog: MatDialog,
        private fb: UntypedFormBuilder,
        private projectService: ProjectService,
        private translateService: TranslateService,
        private resourcesService: ResourcesService,
        private pluginService: PluginService,
        private http: HttpClient,
        @Inject(MAT_DIALOG_DATA) public data: ReportEditorData) {

        const existingReportNames = this.projectService.getReports()?.filter(report => report.id !== data.report.id)?.map(report => report.name);
        this.report = data.report;
        this.myForm = this.fb.group({
            id: [this.report.id, Validators.required],
            name: [this.report.name, [Validators.required,
                (control: AbstractControl) => {
                    if (existingReportNames?.indexOf(control.value) !== -1) {
                        return { invalidName: true };
                    }
                    return null;
                }
            ]],
            receiver: [this.report.receiver],
            scheduling: [this.report.scheduling],
            marginLeft: [this.report.docproperty.pageMargins[0]],
            marginTop: [this.report.docproperty.pageMargins[1]],
            marginRight: [this.report.docproperty.pageMargins[2]],
            marginBottom: [this.report.docproperty.pageMargins[3]],
        });

        this.chartImageAvailable$ = this.pluginService.getPlugins().pipe(
            takeUntil(this.destroy$),
            map(plugins => plugins.some(plugin => plugin.type === PluginGroupType.Chart && plugin.current))
        );
    }

    ngOnInit() {
        Object.keys(this.schedulingType).forEach(key => {
            this.translateService.get(this.schedulingType[key]).subscribe((txt: string) => { this.schedulingType[key] = txt; });
        });
    }

    ngAfterViewInit() {
        this.onReportChanged();
        this.myForm.markAsPristine();
    }

    ngOnDestroy() {
        this.destroy$.next(null);
        this.destroy$.complete();
    }

    onNoClick(): void {
        this.dialogRef.close();
    }

    onOkClick(): void {
        this.report.id = this.myForm.controls.id.value;
        this.report.name = this.myForm.controls.name.value;
        this.report.receiver = this.myForm.controls.receiver.value;
        this.report.scheduling = this.myForm.controls.scheduling.value;

        if (this.data.editmode < 0) {
            this.dialogRef.close(this.report);
        } else if (this.myForm.valid) {
            this.dialogRef.close(this.report);
        }
    }

    onSchedulingChanged() {
        this.report.content.items.forEach(item => {
            if (item.type === this.itemTableType) {
                (<ReportItemTable>item).range = this.myForm.controls.scheduling.value;
            } else if (item.type === this.itemAlarmsType) {
                (<ReportItemAlarms>item).range = this.myForm.controls.scheduling.value;
            }
        });
        this.onReportChanged();
    }

    onReportChanged() {
        this.report.docproperty.pageMargins = [this.myForm.controls.marginLeft.value,
                                                this.myForm.controls.marginTop.value,
                                                this.myForm.controls.marginRight.value,
                                                this.myForm.controls.marginBottom.value];
        this.getPdfContent(this.report).subscribe(content => {
            const pdfDocGenerator = pdfMake.createPdf(content);
            pdfDocGenerator.getDataUrl((dataUrl) => {
                const targetIframe = document.querySelector('iframe');
                if (targetIframe) {
                    targetIframe.src = dataUrl;
                    targetIframe.style.width = '100%';
                    targetIframe.style.height = '100%';
                }
            });
        });
    }

    /** Ranges an item can use, excluding as-of-now which needs no resolution. */
    private rangesUsedBy(report: Report): string[] {
        const noneRange = Utils.getEnumKey(ReportDateRangeType, ReportDateRangeType.none);
        const ranges = (report.content?.items || [])
            .filter(item => item.type === this.itemTableType || item.type === this.itemAlarmsType)
            .map(item => (<ReportItemTable | ReportItemAlarms>item).range)
            .filter(range => !!range && range !== noneRange);
        return Array.from(new Set(ranges));
    }

    /** Ask the server what a range means, once per range. */
    private resolvePeriods(ranges: string[]): Observable<void> {
        const missing = ranges.filter(range => !this.periodCache.has(range));
        if (!missing.length) {
            return of(void 0);
        }
        const calls = missing.map(range => this.http
            .get<any>(ReportEditorComponent.PERIOD_ENDPOINT, { params: { kind: range, previous: '1' } })
            .pipe(
                map(result => {
                    this.periodCache.set(range, {
                        begin: new Date(result.from),
                        // The generator reports an exclusive end; the editor shows an
                        // inclusive one, so step back the same millisecond it does.
                        end: new Date(new Date(result.to).getTime() - 1)
                    });
                }),
                catchError(err => {
                    // Surfacing nothing here would silently preview the wrong period.
                    console.error('SCADIA report period resolution failed for ' + range, err);
                    throw err;
                })
            ));
        return forkJoin(calls).pipe(map(() => void 0));
    }

    /** Resolved boundaries of a range. Falls back to as-of-now for the 'none' case. */
    private dateRangeOf(range: string): DateTimeRange {
        const resolved = this.periodCache.get(range);
        if (resolved) {
            return resolved;
        }
        return { begin: new Date(), end: new Date() };
    }

    getPdfContent(report: Report): Observable<Object>  {
        return this.resolvePeriods(this.rangesUsedBy(report)).pipe(switchMap(() => new Observable<Object>((observer) => {
            let docDefinition = {...report.docproperty };
            // Customer-facing document header; kept in step with the server-side renderer
            // (runtime/jobs/report.js). The report used to carry an earlier vendor's name,
            // which was simply wrong: this product is Kaicheng SCADIA.
            docDefinition['header'] = { text: '开诚智枢 SCADIA', style:[{fontSize: 6}]};
            docDefinition['footer'] = (currentPage, pageCount) => ({ text: currentPage.toString() + ' / ' + pageCount, style:[{alignment: 'right', fontSize: 8}]});
            // first resolve async images from server
            this.checkImages(report.content.items.filter(item => item.type === this.itemChartType)).subscribe((images: ImageItem[] ) => {
                images.forEach((item: ImageItem) => {
                    if (!this.imagesList[item.id]) {
                        this.imagesList[item.id] = item.content;
                    }
                });
                docDefinition['content'] = [];
                report.content.items.forEach((item: ReportItem) => {
                    if (item.type === this.itemTextType) {
                        const itemText = <ReportItemText>item;
                        docDefinition['content'].push({ text: itemText.text, style: [{ alignment: item.align, fontSize: item.size }] });
                    } else if (item.type === this.itemTableType) {
                        const itemTable = ReportEditorComponent.getTableContent(<ReportItemTable>item);
                        const tableDateRange = this.dateRangeOf((<ReportItemTable>item).range);
                        docDefinition['content'].push({ text: `${tableDateRange.begin.toLocaleDateString()} - ${tableDateRange.end.toLocaleDateString()}`,
                            style: [{ fontSize: item.size }] });
                        docDefinition['content'].push(itemTable);
                    } else if (item.type === this.itemAlarmsType) {
                        const itemTable = ReportEditorComponent.getAlarmsContent(<ReportItemAlarms>item);
                        const tableDateRange = this.dateRangeOf((<ReportItemAlarms>item).range);
                        docDefinition['content'].push({ text: `${tableDateRange.begin.toLocaleDateString()} - ${tableDateRange.end.toLocaleDateString()}`,
                            style: [{ fontSize: item.size }] });
                        docDefinition['content'].push(itemTable);
                    } else if (item.type === this.itemChartType) {
                        const itemChart = <ReportItemChart>item;
                        if (itemChart.chart && this.imagesList[itemChart.chart.id]) {
                            docDefinition['content'].push({
                                image: `data:image/png;base64,${this.imagesList[itemChart.chart.id]}`,
                                // if you specify both width and height - image will be stretched
                                width: itemChart.width || 500,
                                height: itemChart.height || 350,
                                // height: 70
                            });
                        }
                    }
                });
                observer.next(docDefinition);
            }, error => {
                console.error('get Resources images error: ' + error);
                observer.next(docDefinition);
            });
        })));
    }

    private checkImages(items: ReportItem[]): Observable<ImageItem[]> {
        if (items.length <= 0) {
            return of([]);
        }
        let source: Array<Observable<any>> = [];
        items.forEach((item: ReportItem) => {
            const chartItem = <ReportItemChart>item;
            if (chartItem.chart && !this.imagesList[chartItem.chart.id]) {
                source.push(this.resourcesService.generateImage(<ReportItemChart>item).pipe(
                    map(result => ({ id: (<ReportItemChart>item).chart.id, content: result }))
                ));
            }
        });
        return forkJoin(source).pipe(
            map((results) => [...results])
        );
    }

    onAddItem(type: string, index: number = 0, edit: boolean = false) {
        let item = <ReportItem>{ type: type, align: 'left', size: 10 };
        if (type === this.itemTextType) {
            item = {...item, ...<ReportItemText> { text: '' }, ... { style: [{ alignment: item.align }]}};
        } else if (type === this.itemTableType) {
            item = {...item, ...<ReportItemTable> {
                columns: [],
                interval: Utils.getEnumKey(ReportIntervalType, ReportIntervalType.hour),
                range: this.myForm.value.scheduling,
            }};
        } else if (type === this.itemAlarmsType) {
            item = {...item, ...<ReportItemAlarms> {
                priority: Utils.convertArrayToObject(Object.values(AlarmsType), true),
                property: Utils.convertArrayToObject(Object.values(AlarmPropertyType), true),
                range: this.myForm.value.scheduling,
            }};
        } else if (type === this.itemChartType) {
            item = {...item, ...<ReportItemChart> {
                range: this.myForm.value.scheduling,
                width: 500,
                height: 350,
                size: 14,
            }};
        }
        this.onEditItem(item, index, edit);
    }

    onEditItem(item: ReportItem, index: number, edit: boolean) {
        let dialogRef = null;
        const dlgconfig = {
            data: Utils.clone(item),
            position: { top: '60px' }
        };

        if (item.type === this.itemTableType) {
            dialogRef = this.dialog.open(ReportItemTableComponent, dlgconfig);
        } else if (item.type === this.itemAlarmsType) {
            dialogRef = this.dialog.open(ReportItemAlarmsComponent, dlgconfig);
        } else if (item.type === this.itemChartType) {
            dialogRef = this.dialog.open(ReportItemChartComponent, dlgconfig);
        } else  {
            dialogRef = this.dialog.open(ReportItemTextComponent, dlgconfig);
        }


        dialogRef.afterClosed().subscribe(result => {
            if (result) {
                if (index <= this.report.content.items.length) {
                    if (edit) {
                        this.checkToRemoveImage(index);
                        this.report.content.items.splice(index, 1, result);
                    } else {
                        this.report.content.items.splice(index, 0, result);
                    }
                } else {
                    this.report.content.items.push(result);
                }
                this.onReportChanged();
            }
        });
    }

    onDeleteItem(index: number) {
        this.checkToRemoveImage(index);
        this.report.content.items.splice(index, 1);
        this.onReportChanged();
    }

    onAlignItem(item: ReportItem, align: string) {
        item.align = align;
        this.onReportChanged();
    }

    onFontSizeItem(index: number, item: ReportItem, size: number) {
        item.size = size;
        this.checkToRemoveImage(index);
        this.onReportChanged();
    }

    static getTableContent(item: ReportItemTable) {
        let content = { layout: 'lightHorizontalLines', fontSize: item.size }; // optional
        let header = item.columns.map<any>(col => ({ text: col.label || col.tag.label || col.tag.name, bold: true, style: [{ alignment: col.align }] }));
        let values = item.columns.map(col => col.tag.address || '...');
        content['table'] = {
            // headers are automatically repeated if the table spans over multiple pages
            // you can declare how many rows should be treated as headers
            headerRows: 1,
            widths: item.columns.map(col => col.width), //[ '*', 'auto', 100],
            body: [
                header,
                values
            ]
        };
        return content;
    }

    static getAlarmsContent(item: ReportItemAlarms) {
        let content = { layout: 'lightHorizontalLines', fontSize: item.size }; // optional
        let header = Object.values(item.propertyText).map<any>(col => ({ text: col, bold: true, style: [{ alignment: 'left' }] }));
        let values = Object.values(item.propertyText).map(col => '...');
        content['table'] = {
            // headers are automatically repeated if the table spans over multiple pages
            // you can declare how many rows should be treated as headers
            headerRows: 1,
            widths: Object.values(item.propertyText).map(col => '*'), //[ '*', 'auto', 100],
            body: [
                header,
                values
            ]
        };
        return content;
    }

    private checkToRemoveImage(index: number) {
        if (this.report.content.items[index] && this.report.content.items[index].type === this.itemChartType) {
            const reportChart = <ReportItemChart>this.report.content.items[index];
            if (reportChart.chart) {
                delete this.imagesList[reportChart.chart.id];
            }
        }
    }

    // The range logic that used to live here (calendar midnight, inclusive 23:59:59, its own
    // idea of which week is last week) is gone. The server resolves periods - see
    // resolvePeriods() above - so the preview can no longer disagree with the PDF.
}

interface DateTimeRange {
    begin: Date;
    end: Date;
}

interface ImageItem {
    id: string;
    content: string;
}

export interface ReportEditorData {
    report: Report;
    editmode: number;
}
