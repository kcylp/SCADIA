import { ActivatedRouteSnapshot, RouterStateSnapshot, Router } from '@angular/router';
import { Injectable } from '@angular/core';
import { AuthService } from './_services/auth.service';
import { ProjectService } from './_services/project.service';
import { ToastrService } from 'ngx-toastr';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { catchError, map, mergeMap, switchMap, timeout } from 'rxjs/operators';
import { LoginComponent } from './login/login.component';
import { MatDialog as MatDialog } from '@angular/material/dialog';

@Injectable()
export class AuthGuard  {
    constructor(private authService: AuthService,
        private translateService: TranslateService,
        private toastr: ToastrService,
        private projectService: ProjectService,
        private dialog: MatDialog,
        private router: Router) {
        }

    canActivate(next: ActivatedRouteSnapshot, state: RouterStateSnapshot): Observable<boolean> {
        // eslint-disable-next-line no-console
        console.log('[guard] ' + state.url + '  securityEnabled=' + this.projectService.isSecurityEnabled() + '  isAdmin=' + this.authService.isAdmin());
        if (!this.projectService.isSecurityEnabled()) {
            return of(true);
        }
        if (this.authService.isAdmin()) {
            return of(true);
        }

        /**
         * A DEAD SECURITY PROBE MUST NOT HANG THE NAVIGATION (measured 2026-10-06).
         *
         * canActivate waits for this observable, and the router waits for canActivate. If the HTTP
         * probe never answers - the ordinary way that happens is a server restarted under an open
         * tab, which is exactly when the operator reported "报表 / 系统 点不开" - the click does
         * NOTHING AT ALL: no navigation, no dialog, no message. Silence is the worst possible
         * answer, because it looks like a broken menu item.
         *
         * On failure this now answers "security is not enabled here" (false -> the caller allows the
         * route) and says so with a toast. That is safe rather than lax: every API call is still
         * authorised server-side, so a page that should not be reachable still cannot do anything -
         * it just gets there and shows its own error instead of a dead menu item.
         */
        const serverSecureEnabled$ = this.projectService.checkServer().pipe(
            timeout(5000),
            map(response => {
                if (!response?.secureEnabled) {
                    return false;
                }
                return true;
            }),
            catchError(() => {
                this.notifySaveError('msg.server-connection-failed');
                return of(false);
            })
        );
        return serverSecureEnabled$.pipe(
            switchMap(secureEnabled => {
                if (!secureEnabled) {
                    return of(true);
                } else {
                    const dialogRef = this.dialog.open(LoginComponent);
                    return dialogRef.afterClosed().pipe(
                        mergeMap(result => {
                            if (result) {
                                if (this.authService.isAdmin()) {
                                    return of(true);
                                }
                            }
                            this.notifySaveError('msg.signin-unauthorized');
							this.router.navigateByUrl('/');
                            return of(false);
                        })
                    );
                }
            })
        );
    }

    private notifySaveError(textKey: string) {
        let msg = '';
        this.translateService.get(textKey).subscribe((txt: string) => { msg = txt; });
        this.toastr.error(msg, '', {
            timeOut: 3000,
            closeButton: true,
            disableTimeOut: true
        });
    }
}
