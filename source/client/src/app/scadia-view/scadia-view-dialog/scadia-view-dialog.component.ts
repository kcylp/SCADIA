import { Component, Inject, OnInit } from '@angular/core';
import { Hmi, View } from '../../_models/hmi';
import { GaugesManager } from '../../gauges/gauges.component';
import { MAT_DIALOG_DATA as MAT_DIALOG_DATA, MatDialogRef as MatDialogRef } from '@angular/material/dialog';
import { ProjectService } from '../../_services/project.service';

@Component({
    selector: 'app-scadia-view-dialog',
    templateUrl: './scadia-view-dialog.component.html',
    styleUrls: ['./scadia-view-dialog.component.scss']
})
export class ScadiaViewDialogComponent implements OnInit {

    view: View;
    hmi: Hmi;
    gaugesManager: GaugesManager;
    variablesMapping = [];

    constructor(public dialogRef: MatDialogRef<ScadiaViewDialogComponent>,
                private projectService: ProjectService,
                @Inject(MAT_DIALOG_DATA) public data: ScadiaViewDialogData) {
    }

    ngOnInit() {
        this.hmi = this.projectService.getHmi();
    }

    onCloseDialog() {
        this.dialogRef.close();
    }
}

export interface ScadiaViewDialogData {
    disableDefaultClose: boolean;
    bkColor: string;
    gaugesManager: GaugesManager;
    view: View;
    variablesMapping: [];
    sourceDeviceId?: string;
}
