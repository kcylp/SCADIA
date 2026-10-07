import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';

@Injectable({
    providedIn: 'root'
})
export class ToastNotifierService {

    constructor(
        private translateService: TranslateService,
        private toastr: ToastrService) {

    }

    notifyError(msgKey: string, err = '', closeButton = true, disableTimeOut = true) {
        this.translateService.get(msgKey).subscribe((txt: string) => {
            this.toastr.error(`${txt} ${err}`, '', {
                timeOut: 3000,
                closeButton: closeButton,
                disableTimeOut: disableTimeOut
            });
        });
    }

    /**
     * Same channel, for a message whose key has PARAMETERS.
     *
     * `notifyError` translates the key with no params and appends the detail afterwards, which is
     * fine for "Upload failed: <reason>" but wrong for the keys that already carry a placeholder -
     * 'msg.project-load-error' is "Unable to read '{{value}}'", so the raw text would show the
     * placeholder and the file name would trail after it. Passing the params to the translator
     * keeps the placeholder inside the sentence, and keeps word order up to the translation.
     *
     * @param msgKey translation key
     * @param params interpolation values for that key
     */
    notifyErrorText(msgKey: string, params: Record<string, unknown> = {},
                    closeButton = true, disableTimeOut = true) {
        this.translateService.get(msgKey, params).subscribe((txt: string) => {
            this.toastr.error(txt, '', {
                timeOut: 3000,
                closeButton: closeButton,
                disableTimeOut: disableTimeOut
            });
        });
    }
}
