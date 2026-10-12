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
     * notifyError translates the key with no params and appends the detail afterwards, which is fine
     * for "Upload failed: <reason>" but wrong for a key that already carries a placeholder: the raw
     * text would show the placeholder and the value would trail after the sentence. Passing the
     * params to the translator keeps the placeholder inside the sentence and keeps word order up to
     * the translation (used by 'editor.image-too-large', which names the size limit).
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
