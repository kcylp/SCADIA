import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';
import { Observable } from 'rxjs';
import { RcgiService } from './rcgi/rcgi.service';
import { ResourceStorageService } from './rcgi/resource-storage.service';

@Injectable({
    providedIn: 'root'
})
export class CommandService {

	private server: ResourceStorageService;

    constructor(
		private rcgiService: RcgiService,
        private translateService: TranslateService,
        private toastr: ToastrService) {

        this.server = rcgiService.rcgi;
    }

    getReportFile(reportName: string): Observable<Blob> {
        return  this.server.downloadFile(reportName, CommanType.reportDownload);
    }

    private notifyError(err: any) {
        const msg = this.translateService.instant('msg.report-build-error');
        this.toastr.error(msg, '', {
            timeOut: 3000,
            closeButton: true,
            disableTimeOut: true
        });
    }
}

export enum CommanType {
    reportDownload = 'REPORT-DOWNLOAD'
};
