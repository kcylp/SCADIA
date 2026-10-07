/* eslint-disable @angular-eslint/component-class-suffix */
/* eslint-disable @angular-eslint/component-selector */
import { Component, Inject, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { MatDialog as MatDialog, MatDialogRef as MatDialogRef, MAT_DIALOG_DATA as MAT_DIALOG_DATA } from '@angular/material/dialog';

import { environment } from '../../environments/environment';

import { SetupComponent } from '../editor/setup/setup.component';

import { ProjectService, SaveMode } from '../_services/project.service';
import { ThemeService } from '../_services/theme.service';
import { ToastNotifierService } from '../_services/toast-notifier.service';
import { ConfirmDialogComponent } from '../gui-helpers/confirm-dialog/confirm-dialog.component';

import { HelpData, DEVICE_READONLY } from '../_models/hmi';
import { TutorialComponent } from '../help/tutorial/tutorial.component';
import { TranslateService } from '@ngx-translate/core';
import { EditNameComponent } from '../gui-helpers/edit-name/edit-name.component';

const editorModeRouteKey = ['/editor', '/device', '/messages', '/language', '/users', '/userRoles', '/notifications', '/scripts', '/recipes', '/reports', '/materials', '/logs', '/events', '/mapsLocations', '/arMarkers', '/flows', '/apikeys', '/plugins', '/calibrations', '/cameras', '/video'];
const saveFromEditorRouteKey = ['/device', '/messages', '/language', '/users', '/userRoles', '/notifications', '/scripts', '/reports', '/materials', '/logs', '/events', '/mapsLocations', '/arMarkers', '/flows', '/apikeys', '/plugins'];

@Component({
    selector: 'app-header',
    templateUrl: 'header.component.html',
    styleUrls: ['header.component.scss']
})
export class HeaderComponent implements AfterViewInit, OnDestroy {

    @ViewChild('sidenav', {static: false})sidenav: any;
    @ViewChild('tutorial', {static: false}) tutorial: TutorialComponent;
    @ViewChild('fileImportInput', {static: false}) fileImportInput: any;

    darkTheme = true;
    editorMode = false;
    saveFromEditor = false;
    private subscriptionShowHelp: Subscription;
    private subscriptionLoad: Subscription;

    constructor(private router: Router,
                public dialog: MatDialog,
                private translateService: TranslateService,
                private themeService: ThemeService,
                private toastNotifier: ToastNotifierService,
                private projectService: ProjectService
    ) {
        this.router.events.pipe(
            filter(val => val instanceof NavigationEnd),
        ).subscribe((routeKey: NavigationEnd) => {
            const urlWithoutParams = routeKey.url.split('?')[0];
            this.editorMode = editorModeRouteKey.includes(urlWithoutParams) ? true : false;
            this.saveFromEditor = saveFromEditorRouteKey.includes(urlWithoutParams) ? true : false;
            if (this.router.url.indexOf(DEVICE_READONLY) >= 0) {
                this.editorMode = false;
            }
        });

        // this.router.events.subscribe(()=> {
        //     this.editorMode = (this.router.url.indexOf('editor') >= 0 ||  this.router.url.indexOf('device') >= 0 ||
        //                         this.router.url.indexOf('users') >= 0 || this.router.url.indexOf('text') >= 0 ||
        //                         this.router.url.indexOf('messages') >= 0 || this.router.url.indexOf('events') >= 0 ||
        //                         this.router.url.indexOf('notifications') >= 0 || this.router.url.indexOf('scripts') >= 0 ||
        //                         this.router.url.indexOf('reports') >= 0) ? true : false;
        //     this.savededitor = (this.router.url.indexOf('device') >= 0 || this.router.url.indexOf('users') >= 0 ||
        //                         this.router.url.indexOf('text') >= 0 || this.router.url.indexOf('messages') >= 0 ||
        //                         this.router.url.indexOf('events') >= 0 || this.router.url.indexOf('notifications') >= 0 ||
        //                         this.router.url.indexOf('scripts') >= 0 || this.router.url.indexOf('reports') >= 0) ? true : false;

        //     if (this.router.url.indexOf(DEVICE_READONLY) >= 0) {
        //         this.editorMode = false;
        //     }
        // });
        this.themeService.setTheme(this.projectService.getLayoutTheme());
    }

    ngAfterViewInit() {
        this.subscriptionLoad = this.projectService.onLoadHmi.subscribe(load => {
            let theme = this.projectService.getLayoutTheme();
            this.darkTheme = (theme !== ThemeService.ThemeType.Default);
            this.themeService.setTheme(this.projectService.getLayoutTheme());
        }, error => {
            console.error('Error loadHMI');
        });
    }

    ngOnDestroy() {
        try {
            if (this.subscriptionShowHelp) {
                this.subscriptionShowHelp.unsubscribe();
            }
            if (this.subscriptionLoad) {
                this.subscriptionLoad.unsubscribe();
            }
        } catch (e) {
        }
      }

    public onClick(targetElement) {
        this.sidenav.close();
    }

    onShowHelp(page) {
        let data = new HelpData();
        data.page = page;
        data.tag = 'device';
        this.showHelp(data);
    }

    onSetup() {
        this.projectService.saveProject(SaveMode.Current);
        let dialogRef = this.dialog.open(SetupComponent, {
            position: { top: '60px' },
        });
    }

    onGoToCalibrations() {
        this.router.navigate(['/calibrations']);
    }

    onGoToCameras() {
        this.router.navigate(['/cameras']);
    }

    onGoToVideoWall() {
        this.router.navigate(['/video']);
    }

    showHelp(data: HelpData) {
        if (data.page === 'help') {
            this.tutorial.show = true;
        } else if (data.page === 'info') {
            this.showInfo();
        }
    }

    showInfo() {
        let dialogRef = this.dialog.open(DialogInfo, {
            data: { name: 'Info', version: environment.version }
        });

        dialogRef.afterClosed().subscribe(result => {
        });
    }

    goTo(destination: string) {
        this.router.navigate([destination]);//, this.ID]);
    }

    onChangeTheme() {
        this.darkTheme = !this.darkTheme;
        let theme = ThemeService.ThemeType.Default;
        if (this.darkTheme) {
            theme = ThemeService.ThemeType.Dark;
        }
        this.themeService.setTheme(theme);
        this.projectService.setLayoutTheme(theme);
    }

    //#region Project Events
    /**
     * Ask before leaving the current project, then start a new one.
     *
     * Was `window.confirm()`: a blocking native dialog that ignores the app's theme, cannot be
     * translated through the app's own pipeline at the moment it is shown, and is suppressed
     * outright by some browsers inside an iframe. The project already ships ConfirmDialogComponent
     * for exactly this (R5).
     */
    onNewProject() {
        try {
            const dialogRef = this.dialog.open(ConfirmDialogComponent, {
                data: { msg: this.translateService.instant('msg.project-save-ask') },
                position: { top: '60px' }
            });
            dialogRef.afterClosed().subscribe((confirmed: boolean) => {
                if (confirmed) {
                    this.projectService.setNewProject();
                    this.onRenameProject();
                }
            });
        } catch (err) {
            console.error('header.onNewProject failed', err);
        }
    }

    /**
     * Aave Project as JSON file and Download in Browser
     */
    onSaveProjectAs() {
        try {
            if (this.saveFromEditor) {
                this.projectService.saveAs();
            } else {
                this.projectService.saveProject(SaveMode.SaveAs);
            }
        } catch (e) {

        }
    }

    onOpenProject() {
        let ele = document.getElementById('projectFileUpload') as HTMLElement;
        ele.click();
    }

    /**
     * open Project event file loaded
     * @param event file resource
     */
    onFileChangeListener(event) {
        let input = event.target;
        let reader = new FileReader();
        reader.onload = (data) => {
            let prj = JSON.parse(reader.result.toString());
            this.projectService.setProject(prj, true);
        };

        // Arrow function on purpose: the old `function()` form had its own `this`, which is why the
        // translation line above it stayed commented out. Toast + the existing i18n key (R5).
        reader.onerror = () => {
            this.toastNotifier.notifyErrorText('msg.project-load-error', { value: input.files[0].name });
        };
        reader.readAsText(input.files[0]);
        this.fileImportInput.nativeElement.value = null;
    }

    /**
     * save Project and Download in Browser
     */
    onSaveProject() {
        try {
            if (this.saveFromEditor) {
                this.projectService.save();
            } else {
                this.projectService.saveProject(SaveMode.Save);
            }
        } catch (e) {
            console.error(e);
        }
    }

    /**
     * rename the project
     */
    onRenameProject() {
        // The async subscribe had not fired when the dialog was opened on the next statement, so the
        // rename dialog showed an EMPTY title. User-triggered, so instant() is correct.
        const title = this.translateService.instant('project.name');
        let dialogRef = this.dialog.open(EditNameComponent, {
            position: { top: '60px' },
            data: { name: this.projectService.getProjectName(), title: title }
        });
        dialogRef.afterClosed().subscribe(result => {
            if (result && result.name !== this.projectService.getProjectName()) {
                this.projectService.setProjectName(result.name.replace(/ /g,''));
            }
        });
    }
    //#endregion
}


@Component({
    selector: 'dialog-info',
    templateUrl: 'info.dialog.html',
})
export class DialogInfo {
    constructor(
        public dialogRef: MatDialogRef<DialogInfo>,
        @Inject(MAT_DIALOG_DATA) public data: any) { }

    onNoClick(): void {
        this.dialogRef.close();
    }
}
