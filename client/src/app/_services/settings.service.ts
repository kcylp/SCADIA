import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { TranslateService } from '@ngx-translate/core';
import { EndPointApi } from '../_helpers/endpointapi';
import { ToastrService } from 'ngx-toastr';
import { AppSettings, DaqStore, EditorSectionMessagesSettings, SmtpSettings, normalizeAppLanguage } from '../_models/settings';

@Injectable({
    providedIn: 'root'
})
export class SettingsService {

    private appSettings = new AppSettings();
    settings$ = new BehaviorSubject<AppSettings>(this.appSettings);
    loaded$ = new BehaviorSubject<boolean>(!environment.serverEnabled);
    private endPointConfig: string = EndPointApi.getURL();

    private editModeLocked = false;

    constructor(private http: HttpClient,
        private scadiaLanguage: TranslateService,
        private translateService: TranslateService,
        private toastr: ToastrService) {
    }

    init() {
        // Fallback dictionary for any key a translation happens to miss.
        this.scadiaLanguage.setDefaultLang('en');
        // Boot in the master language; refreshSettings() switches to the project setting.
        // English is only the safety net, never the first thing an operator sees.
        this.scadiaLanguage.use('zh-cn');
        // to load saved settings
        if (environment.serverEnabled) {
            this.refreshSettings().subscribe({
                error: error => console.error('settings.service err: ' + error)
            });
        }
        // this.setLanguage(this.appSettings.language);
    }

    refreshSettings(): Observable<any> {
        return this.http.get<any>(this.endPointConfig + '/api/settings').pipe(
            tap(result => {
                this.setSettings(result);
            }),
            finalize(() => this.loaded$.next(true))
        );
    }

    getSettings() {
        return this.appSettings;
    }

    setSettings(settings: AppSettings) {
        var dirty = false;
        // A project saved on a build that shipped more languages, or an operator who picked
        // one that has since been withdrawn, must not make the app request a missing file:
        // ngx-translate answers that by rendering raw keys. Clamp onto the shipped set.
        const shippedLanguage = normalizeAppLanguage(settings.language, this.appSettings.language);
        if (shippedLanguage !== this.appSettings.language) {
            this.scadiaLanguage.use(shippedLanguage);
            this.appSettings.language = shippedLanguage;
            dirty = true;
        } else if (settings.language && settings.language !== shippedLanguage) {
            dirty = true; // persist the correction back to settings
        }
        if (settings.uiPort && settings.uiPort !== this.appSettings.uiPort) {
            this.appSettings.uiPort = settings.uiPort;
            dirty = true;
        }
        if (settings.hideEditorOnboarding !== this.appSettings.hideEditorOnboarding) {
            this.appSettings.hideEditorOnboarding = !!settings.hideEditorOnboarding;
            dirty = true;
        }
        const nextEditorSectionMessages = new EditorSectionMessagesSettings(settings.editorSectionMessages);
        if (nextEditorSectionMessages.hideDevicePluginsNotice !== this.appSettings.editorSectionMessages.hideDevicePluginsNotice ||
            nextEditorSectionMessages.hideArMarkersNotice !== this.appSettings.editorSectionMessages.hideArMarkersNotice) {
            this.appSettings.editorSectionMessages = nextEditorSectionMessages;
            dirty = true;
        }
        if (settings.secureEnabled !== this.appSettings.secureEnabled ||
            settings.tokenExpiresIn !== this.appSettings.tokenExpiresIn ||
            settings.secureOnlyEditor !== this.appSettings.secureOnlyEditor ||
            settings.enableRefreshCookieAuth !== this.appSettings.enableRefreshCookieAuth ||
            settings.refreshTokenExpiresIn !== this.appSettings.refreshTokenExpiresIn) {
            this.appSettings.secureEnabled = settings.secureEnabled;
            this.appSettings.tokenExpiresIn = settings.tokenExpiresIn;
            this.appSettings.secureOnlyEditor = settings.secureOnlyEditor;
            this.appSettings.enableRefreshCookieAuth = settings.enableRefreshCookieAuth;
            this.appSettings.refreshTokenExpiresIn = settings.refreshTokenExpiresIn;
            dirty = true;
        }
        if (settings.secretCode !== undefined && settings.secretCode !== this.appSettings.secretCode) {
            this.appSettings.secretCode = settings.secretCode;
            dirty = true;
        }
        if (settings.secretCode !== undefined && settings.secretCode !== this.appSettings.secretCode) {
            this.appSettings.secretCode = settings.secretCode;
            dirty = true;
        }
        if (settings.broadcastAll !== this.appSettings.broadcastAll) {
            this.appSettings.broadcastAll = settings.broadcastAll;
            dirty = true;
        }
        if (settings.lazyViewLoading !== this.appSettings.lazyViewLoading) {
            this.appSettings.lazyViewLoading = settings.lazyViewLoading;
            dirty = true;
        }
        if (settings.smtp && !(settings.smtp.host === this.appSettings.smtp.host && settings.smtp.port === this.appSettings.smtp.port &&
                settings.smtp.mailsender === this.appSettings.smtp.mailsender && settings.smtp.username === this.appSettings.smtp.username &&
                settings.smtp.password === this.appSettings.smtp.password)) {
            this.appSettings.smtp = new SmtpSettings(settings.smtp);
            dirty = true;
        }
        if (settings.daqstore && !this.appSettings.daqstore.isEquals(settings.daqstore)) {
            this.appSettings.daqstore = new DaqStore(settings.daqstore);
            dirty = true;
        }
        if (settings.logFull !== this.appSettings.logFull) {
            this.appSettings.logFull = settings.logFull;
            dirty = true;
        }
        if (settings.alarms && settings.alarms.retention !== this.appSettings.alarms?.retention) {
            this.appSettings.alarms.retention = settings.alarms.retention ?? this.appSettings.alarms?.retention;
            dirty = true;
        }
        if (settings.logs && settings.logs.retention !== this.appSettings.logs?.retention) {
            this.appSettings.logs.retention = settings.logs.retention ?? this.appSettings.logs?.retention;
            dirty = true;
        }
        if (settings.userRole !== this.appSettings.userRole) {
            this.appSettings.userRole = settings.userRole;
            dirty = true;
        }
        if (settings.nodeRedEnabled !== this.appSettings.nodeRedEnabled) {
            this.appSettings.nodeRedEnabled = settings.nodeRedEnabled;
            dirty = true;
        }
        if (settings.nodeRedAuthMode !== undefined && settings.nodeRedAuthMode !== this.appSettings.nodeRedAuthMode) {
            this.appSettings.nodeRedAuthMode = settings.nodeRedAuthMode;
            dirty = true;
        }
        if (settings.swaggerEnabled !== this.appSettings.swaggerEnabled) {
            this.appSettings.swaggerEnabled = settings.swaggerEnabled;
            dirty = true;
        }
        if (dirty) {
            this.settings$.next(this.appSettings);
        }
        return dirty;
    }

    saveSettings() {
        if (environment.serverEnabled) {
            let header = new HttpHeaders({ 'Content-Type': 'application/json' });
            this.http.post<AppSettings>(this.endPointConfig + '/api/settings', this.appSettings, { headers: header }).subscribe(result => {
            }, err => {
                this.notifySaveError(err);
            });
        }
    }

    clearAlarms(all: boolean) {
        if (environment.serverEnabled) {
            let header = new HttpHeaders({ 'Content-Type': 'application/json' });
            this.http.post<any>(this.endPointConfig + '/api/alarmsClear', { headers: header, params: all }).subscribe(result => {
                const msg = this.translateService.instant('msg.alarms-clear-success');
                this.toastr.success(msg);
            }, err => {
                console.error(err);
                this.notifySaveError(err);
            });
        }
    }

    private notifySaveError(err: any) {
        // BOTH subscribes were read synchronously a few lines later, so msg was '' and the save
        // failure toast was BLANK - including the 401 case, where the operator most needs to be told
        // what happened. The second message deliberately overrides the first on a 401.
        let msg = this.translateService.instant('msg.settings-save-error');
        if (err.status === 401) {
            msg = this.translateService.instant('msg.settings-save-unauthorized');
        }
        this.toastr.error(msg, '', {
            timeOut: 3000,
            closeButton: true,
            disableTimeOut: true
        });
    }

    //#region Editor Mode Check
    lockEditMode() {
        this.editModeLocked = true;
    }

    unlockEditMode() {
        this.editModeLocked = false;
    }

    isEditModeLocked(): boolean {
        return this.editModeLocked;
    }

    notifyEditorLocked() {
        const msg = this.translateService.instant('msg.editor-mode-locked');
        this.toastr.warning(msg, '', {
            timeOut: 3000,
            closeButton: true,
            disableTimeOut: false
        });
    }
    //#endregion
}
