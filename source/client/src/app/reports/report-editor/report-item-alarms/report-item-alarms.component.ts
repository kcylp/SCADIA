import { Component, Inject, OnInit } from '@angular/core';
import { MatDialogRef as MatDialogRef, MAT_DIALOG_DATA as MAT_DIALOG_DATA } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { AlarmPriorityType, AlarmPropertyType, AlarmStatusType, AlarmsType } from '../../../_models/alarm';
import { ReportDateRangeType, ReportItemAlarms } from '../../../_models/report';
import { ProjectService } from '../../../_services/project.service';
import { ReportItemTableComponent } from '../report-item-table/report-item-table.component';

@Component({
    selector: 'app-report-item-alarms',
    templateUrl: './report-item-alarms.component.html',
    styleUrls: ['./report-item-alarms.component.scss']
})
export class ReportItemAlarmsComponent implements OnInit {

    dateRangeType = ReportDateRangeType;
    alarmsType = [AlarmsType.HIGH_HIGH, AlarmsType.HIGH, AlarmsType.LOW, AlarmsType.INFO];
    alarmPropertyType = Object.values(AlarmPropertyType).map(a => a);
    alarmsList = [];
    alarmsListSelected = [];
    // 八场景任意子集选择：scene 字符串契约保持不变（'all' 或逗号分隔子集，如 'V1,T1'）。
    sceneIds = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'T1'];
    sceneSelected: { [id: string]: boolean } = {};
    sceneError = '';

    constructor(
        private projectService: ProjectService,
        public dialogRef: MatDialogRef<ReportItemTableComponent>,
        private translateService: TranslateService,
        @Inject(MAT_DIALOG_DATA) public data: ReportItemAlarms) { }

    ngOnInit() {
        Object.keys(this.dateRangeType).forEach(key => {
            this.translateService.get(this.dateRangeType[key]).subscribe((txt: string) => { this.dateRangeType[key] = txt; });
        });

        this.alarmsList = this.projectService.getAlarms().map(alarm => {
            let tag = this.projectService.getTagFromId(alarm.property?.variableId);
            return {
                name: alarm.name,
                variableName: tag?.label || tag?.name,
                variableId: alarm.property?.variableId,
            };
        });
        if (this.data.alarmFilter) {
            this.alarmsListSelected = this.alarmsList.filter(alarm => !!this.data.alarmFilter?.find(name => alarm.name === name));
        } else {
            this.alarmsListSelected = this.alarmsList;
        }
        this.readSceneSelection();
    }

    readSceneSelection(): void {
        const scene = this.data.sceneFilter?.scene;
        const selected = scene && scene !== 'all' ? scene.split(',') : this.sceneIds;
        this.sceneSelected = {};
        for (const id of this.sceneIds) {
            this.sceneSelected[id] = scene == null || scene === 'all' || selected.includes(id);
        }
    }

    onSourceChanged(value: string): void {
        this.data.sceneFilter = value === 'scene' ? { scene: 'all' } : undefined;
        this.sceneError = '';
        this.readSceneSelection();
    }

    toggleScene(id: string, checked: boolean): void {
        this.sceneSelected[id] = checked;
        this.sceneError = '';
    }

    toggleAllScenes(checked: boolean): void {
        for (const id of this.sceneIds) {
            this.sceneSelected[id] = checked;
        }
        this.sceneError = '';
    }

    allScenesSelected(): boolean {
        return this.sceneIds.every(id => this.sceneSelected[id]);
    }

    onPriorityChanged(type: AlarmsType, value: boolean) {
        this.data.priority[type] = value;
    }

    onPropertyChanged(property: AlarmPropertyType, value: boolean) {
        this.data.property[property] = value;
    }

    getPriorityValue(type: AlarmsType) {
        return this.data.priority[type];
    }

    getPropertyValue(type: AlarmPropertyType) {
        return this.data.property[type];
    }

    toggleAlarmFilterSelection(event: any) {
        this.alarmsListSelected = this.alarmsList.filter(alarm => event.checked);
    }

    onNoClick(): void {
        this.dialogRef.close();
    }

    onOkClick(): void {
        if (this.data.sceneFilter) {
            const selected = this.sceneIds.filter(id => this.sceneSelected[id]);
            if (!selected.length) {
                this.sceneError = '至少选择一个场景；全不选时请改用设备报警历史。';
                return;
            }
            this.data.sceneFilter.scene = selected.length === this.sceneIds.length ? 'all' : selected.join(',');
        }
        this.data.priorityText = {};
        Object.keys(AlarmPriorityType).forEach(key => {
            this.translateService.get(AlarmPriorityType[key]).subscribe((txt: string) => { this.data.priorityText[key] = txt; });
        });

        this.data.propertyText = {};
        Object.keys(this.data.property).forEach(key => {
            if (this.data.property[key]) {
                this.translateService.get('alarms.view-' + key).subscribe((txt: string) => { this.data.propertyText[key] = txt; });
            }
        });
        this.data.statusText = {};
        Object.keys(AlarmStatusType).forEach(key => {
            this.translateService.get(AlarmStatusType[key]).subscribe((txt: string) => { this.data.statusText[key] = txt; });
        });
        this.data.alarmFilter = this.alarmsListSelected.map(alarm => alarm.name);
        this.dialogRef.close(this.data);
    }
}
