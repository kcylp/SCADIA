import { Component, OnInit } from '@angular/core';
import { MatDialogRef as MatDialogRef } from '@angular/material/dialog';

import { SettingsService } from '../../_services/settings.service';
import { DiagnoseService } from '../../_services/diagnose.service';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';

import { AlarmsRetentionType, AppSettings, DaqStore, DaqStoreRetentionType, DaqStoreType, MailMessage, SmtpSettings, StoreCredentials, LogsSettings, AlarmsSettings, SHIPPED_APP_LANGUAGES } from '../../_models/settings';
import { Utils } from '../../_helpers/utils';

@Component({
    selector: 'app-app-settings',
    templateUrl: './app-settings.component.html',
    styleUrls: ['./app-settings.component.scss']
})
export class AppSettingsComponent implements OnInit {

    /**
     * Languages offered in this build. Driven by SHIPPED_APP_LANGUAGES so the dropdown
     * can never list a language whose file is not shipped - switching to one would render
     * raw translation keys instead of text.
     */
    languageType = SHIPPED_APP_LANGUAGES.map(value => ({ text: 'dlg.app-language-' + value, value }));

    authType = [
		{ text: 'dlg.app-auth-disabled', value: '' },
		{ text: 'dlg.app-auth-expiration-15m', value: '15m' },
		{ text: 'dlg.app-auth-expiration-1h', value: '1h' },
		{ text: 'dlg.app-auth-expiration-3h', value: '3h' },
		{ text: 'dlg.app-auth-expiration-1d', value: '1d' }
	];

    nodeRedAuthModeType = [
        { text: 'dlg.app-settings-node-red-auth-secure', value: 'secure' },
        { text: 'dlg.app-settings-node-red-auth-legacy', value: 'legacy-open' }
    ];

    settings = new AppSettings();
    originalNodeRedEnabled = false;
    originalSwaggerEnabled = false;
    originalSecureEnabled = false;
    authentication = '';
    authenticationTooltip = '';
    smtpTesting = false;
    smtpTestAddress = '';
    showPassword = false;

    daqstoreType = DaqStoreType;
    retationType = DaqStoreRetentionType;
    alarmsRetationType = AlarmsRetentionType;
    logsRetationType = DaqStoreRetentionType;
    influxDB18 = Utils.getEnumKey(DaqStoreType, DaqStoreType.influxDB18);

    constructor(private settingsService: SettingsService,
        private diagnoseService: DiagnoseService,
        private translateService: TranslateService,
        private toastr: ToastrService,
        public dialogRef: MatDialogRef<AppSettingsComponent>) { }

    ngOnInit() {
        this.settings = Utils.clone(this.settingsService.getSettings());
        for (let i = 0; i < this.languageType.length; i++) {
            this.languageType[i].text = this.translateService.instant(this.languageType[i].text);
        }
        for (let i = 0; i < this.authType.length; i++) {
            this.authType[i].text = this.translateService.instant(this.authType[i].text);
        }
        for (let i = 0; i < this.nodeRedAuthModeType.length; i++) {
            this.nodeRedAuthModeType[i].text = this.translateService.instant(this.nodeRedAuthModeType[i].text);
        }
        // The two loops directly above already used instant() for exactly this job, at exactly this
        // point in the lifecycle - so this line was the odd one out, and its value was empty until a
        // language change happened to refresh it.
        this.authenticationTooltip = this.translateService.instant('dlg.app-auth-tooltip');

        if (this.settings.secureEnabled) {
            this.authentication = this.settings.tokenExpiresIn;
        }
        this.originalSecureEnabled = this.settings.secureEnabled;
        if (Utils.isNullOrUndefined(this.settings.broadcastAll)) {
            this.settings.broadcastAll = true;
        }
        if (Utils.isNullOrUndefined(this.settings.lazyViewLoading)) {
            this.settings.lazyViewLoading = false;
        }
        if (Utils.isNullOrUndefined(this.settings.logFull)) {
            this.settings.logFull = false;
        }
        if (!this.settings.smtp) {
            this.settings.smtp = new SmtpSettings();
        }
        this.settings.daqstore = this.settings.daqstore || new DaqStore();
        if (!this.settings.daqstore.credentials) {
            this.settings.daqstore.credentials = new StoreCredentials();
        }
        if (!this.settings.alarms) {
            this.settings.alarms = new AlarmsSettings();
        }
        if (!this.settings.logs) {
            this.settings.logs = new LogsSettings();
        }
        if (Utils.isNullOrUndefined(this.settings.nodeRedEnabled)) {
            this.settings.nodeRedEnabled = false;
        }
        this.originalNodeRedEnabled = this.settings.nodeRedEnabled;
        if (Utils.isNullOrUndefined(this.settings.nodeRedAuthMode)) {
            this.settings.nodeRedAuthMode = 'secure';
        }

        if (Utils.isNullOrUndefined(this.settings.swaggerEnabled)) {
            this.settings.swaggerEnabled = false;
        }
        this.originalSwaggerEnabled = this.settings.swaggerEnabled;
    }

    onNoClick() {
        this.dialogRef.close();
    }

    onOkClick() {
        if (this.authentication && !this.originalSecureEnabled && (!this.settings.secretCode || !this.settings.secretCode.length)) {
            let msg = this.translateService.instant('msg.secret-code-required');
            this.notifyError(msg);
            return;
        }
        this.settings.secureEnabled = (this.authentication) ? true : false;
        this.settings.tokenExpiresIn = this.authentication;
        if (this.settingsService.setSettings(this.settings)) {
            this.settingsService.saveSettings();
        }
        this.dialogRef.close();
    }

    onLanguageChange(language) {
        this.settings.language = language;
    }

    onAlarmsClear() {
        this.settingsService.clearAlarms(true);
    }

    onSmtpTest() {
        this.smtpTesting = true;
        let msg = <MailMessage>{ from: this.settings.smtp.mailsender || this.settings.smtp.username, to: this.smtpTestAddress, subject: 'SCADIA', text: 'TEST' };
        this.diagnoseService.sendMail(msg, this.settings.smtp).subscribe(() => {
            this.smtpTesting = false;
            const msg = this.translateService.instant('msg.sendmail-success');
            this.toastr.success(msg);
        }, error => {
            this.smtpTesting = false;
            if (error.message) {
                this.notifyError(error.message);
            } else {
                const msg = this.translateService.instant('msg.sendmail-error');
                this.notifyError(msg);
            }
        });
    }

    isSmtpTestReady() {
        if (this.smtpTesting) {
            return false;
        }
        if (!this.settings.smtp.host || !this.settings.smtp.host.length) {
            return false;
        }
        if (!this.settings.smtp.username || !this.settings.smtp.username.length) {
            return false;
        }
        if (!this.smtpTestAddress || !this.smtpTestAddress.length) {
            return false;
        }
        return true;
    }

    keyDownStopPropagation(event) {
        event.stopPropagation();
    }

    private notifyError(error: string) {
        this.toastr.error(error, '', {
            timeOut: 3000,
            closeButton: true
            // disableTimeOut: true
        });
    }
}
