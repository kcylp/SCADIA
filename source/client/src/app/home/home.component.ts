/* eslint-disable @angular-eslint/component-class-suffix */
/* eslint-disable @angular-eslint/component-selector */
import { Component, Inject, OnInit, AfterViewInit, OnDestroy, ViewChild, ChangeDetectorRef, ElementRef, HostListener } from '@angular/core';
import { MatDialog as MatDialog, MatDialogRef as MatDialogRef, MAT_DIALOG_DATA as MAT_DIALOG_DATA } from '@angular/material/dialog';
import { interval, Observable, Subject, Subscription } from 'rxjs';
import { MatSidenav } from '@angular/material/sidenav';
import { ActivatedRoute, Router } from '@angular/router';

import { SidenavComponent } from '../sidenav/sidenav.component';
import { ScadiaViewComponent } from '../scadia-view/scadia-view.component';
import { CardsViewComponent } from '../cards-view/cards-view.component';

import { HmiService, ScriptOpenCard, ScriptSetView } from '../_services/hmi.service';
import { ProjectService } from '../_services/project.service';
import { AuthService } from '../_services/auth.service';
import { GaugesManager } from '../gauges/gauges.component';
import { Hmi, View, ViewType, NaviModeType, NotificationModeType, ZoomModeType, HeaderSettings, LinkType, HeaderItem, Variable, GaugeStatus, GaugeSettings, GaugeEventType, LoginOverlayColorType, GaugeEvent } from '../_models/hmi';
import { LoginComponent } from '../login/login.component';
import { AlarmViewComponent } from '../alarms/alarm-view/alarm-view.component';
import { Utils } from '../_helpers/utils';
import { GridOptions } from '../cards-view/cards-view.component';
import { AlarmStatus, AlarmActionsType } from '../_models/alarm';

import { GridsterConfig } from 'angular-gridster2';

import panzoom from 'panzoom';
import { filter, takeUntil } from 'rxjs/operators';
import { HtmlButtonComponent } from '../gauges/controls/html-button/html-button.component';
import { User } from '../_models/user';
import { UserInfo } from '../users/user-edit/user-edit.component';
import { Intervals } from '../_helpers/intervals';
import { Script, ScriptMode } from '../_models/script';
import { ScriptService } from '../_services/script.service';
// declare var panzoom: any;

import { ToastrService } from 'ngx-toastr';
import { LanguageService, LanguageConfiguration } from '../_services/language.service';
import { Language } from '../_models/language';

@Component({
    selector: 'app-home',
    templateUrl: './home.component.html',
    styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit, AfterViewInit, OnDestroy {

    @ViewChild('sidenav', { static: false }) sidenav: SidenavComponent;
    @ViewChild('matsidenav', { static: false }) matsidenav: MatSidenav;
    @ViewChild('scadiaview', { static: false }) scadiaview: ScadiaViewComponent;
    @ViewChild('cardsview', { static: false }) cardsview: CardsViewComponent;
    @ViewChild('alarmsview', { static: false }) alarmsview: AlarmViewComponent;
    @ViewChild('container', { static: false }) container: ElementRef;
    @ViewChild('header', { static: false }) header: ElementRef;

    iframes: IiFrame[] = [];
    isLoading = true;
    homeView: View = new View();
    hmi: Hmi = new Hmi();
    showSidenav = 'over';
    homeLink = '';
    showHomeLink = false;
    securityEnabled = false;
    backgroudColor = 'unset';
    title = '';
    alarms = { show: false, count: 0, mode: '' };
    infos = { show: false, count: 0, mode: '' };
    // 90-AF: bundled demo projects for the home-header switcher (manifest from /_demos).
    demos: any[] = [];
    headerButtonMode = NotificationModeType;
    layoutHeader = new HeaderSettings();
    /** Configured header metrics, never mutated, so the UI scale stays idempotent. */
    private layoutHeaderBase: HeaderSettings = null;
    showNavigation = true;
    viewAsAlarms = LinkType.alarms;
    alarmPanelWidth = '100%';
    cardViewType = ViewType.cards;
    mapsViewType = ViewType.maps;
    gridOptions = <GridsterConfig>new GridOptions();
    intervalsScript = new Intervals();
    currentDateTime: Date = new Date();
    private headerItemsMap = new Map<string, HeaderItem[]>();
    private subscriptionLoad: Subscription;
    private subscriptionAlarmsStatus: Subscription;
    private subscriptiongoTo: Subscription;
    private subscriptionOpen: Subscription;
    private destroy$ = new Subject<void>();
    /** Browser-fullscreen state for the runtime header button, kept in sync through the API event. */
    isFullscreen = false;

    /**
     * Fullscreen state comes from the API, not from the button: the operator can also leave with Esc
     * or F11, and a button that still reads "exit" afterwards would be a lie. Arrow property so
     * add/removeEventListener use the same reference.
     */
    private readonly onFullscreenChange = () => {
        this.isFullscreen = !!document.fullscreenElement;
    };
    loggedUser$: Observable<User>;
    language$: Observable<LanguageConfiguration>;
    readonly defaultHeaderHeight = HeaderSettings.DefaultHeight;

    constructor(private projectService: ProjectService,
        private changeDetector: ChangeDetectorRef,
        public dialog: MatDialog,
        private router: Router,
        private route: ActivatedRoute,
        private hmiService: HmiService,
        private toastr: ToastrService,
        private scriptService: ScriptService,
        private languageService: LanguageService,
        private authService: AuthService,
        public gaugesManager: GaugesManager) {
        this.gridOptions.draggable = { enabled: false };
        this.gridOptions.resizable = { enabled: false };
    }

    /**
     * 90-AF: switch to one of the bundled demo projects (home header menu). Same
     * import path as the editor's open-project: setProject + reload.
     */
    onSwitchDemo(demo: any) {
        if (!demo || !demo.file) { return; }
        fetch('/_demos/' + demo.file)
            .then(r => { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
            .then(prj => { this.projectService.setProject(prj, true); })
            .catch(err => { console.error('demo switch failed: ' + err); });
    }

    /** 90-AH: open the user manual (web copy of the shipped CHM) in a new tab. */
    onOpenManual() {
        window.open('/_help/index.htm', '_blank');
    }

    ngOnInit() {
        // 90-AF: list the bundled demo projects served from /_demos.
        fetch('/_demos/demos.json').then(r => r.json()).then(list => {
            this.demos = Array.isArray(list) ? list : [];
        }).catch(() => { /* no demos served - menu stays empty */ });
        try {
            document.addEventListener('fullscreenchange', this.onFullscreenChange);
            this.subscriptionLoad = this.projectService.onLoadHmi.subscribe(() => {
                if (this.projectService.getHmi()) {
                    this.loadHmi();
                    this.initScheduledScripts();
                    this.checkDateTimeTimer();
                }
            }, error => {
                console.error(`Error loadHMI: ${error}`);
            });
            this.subscriptionAlarmsStatus = this.hmiService.onAlarmsStatus.subscribe(event => {
                this.setAlarmsStatus(event);
            });
            this.subscriptiongoTo = this.hmiService.onGoTo.subscribe((viewToGo: ScriptSetView) => {
                this.onGoToPage(this.projectService.getViewId(viewToGo.viewName), viewToGo.force);
            });
            this.subscriptionOpen = this.hmiService.onOpen.subscribe((viewToOpen: ScriptOpenCard) => {
                const viewId = this.projectService.getViewId(viewToOpen.viewName);
                this.scadiaview.onOpenCard(viewId, null, viewId, viewToOpen.options);
            });

            this.language$ = this.languageService.languageConfig$;
            this.loggedUser$ = this.authService.currentUser$;

            this.gaugesManager.onchange.pipe(
                takeUntil(this.destroy$),
                filter(varTag => this.headerItemsMap.has(varTag.id))
            ).subscribe(varTag => {
                this.processValueInHeaderItem(varTag);
            });
        } catch (err) {
            console.error(err);
        }
    }

    ngAfterViewInit() {
        try {
            // TODO
            setTimeout(() => {
                this.projectService.notifyToLoadHmi();
            }, 0);
            this.hmiService.askAlarmsStatus();
            this.changeDetector.detectChanges();
        }
        catch (err) {
            console.error(err);
        }
    }

    /**
     * Toggle browser fullscreen from the runtime header.
     *
     * It lives here, and not only in app-header, because app-header is hidden on /home
     * (AppComponent.isHidden()): a button that exists only there is invisible on every screen the
     * operator actually watches. The browser chrome disappears - which is what the delivery asked
     * for - while the app's own menu and header stay usable.
     */
    onToggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                document.documentElement.requestFullscreen();
            }
        } catch (err) {
            console.error('home.onToggleFullscreen failed', err);
        }
    }

    ngOnDestroy() {
        try {
            document.removeEventListener('fullscreenchange', this.onFullscreenChange);
            if (this.subscriptionLoad) {
                this.subscriptionLoad.unsubscribe();
            }
            if (this.subscriptionAlarmsStatus) {
                this.subscriptionAlarmsStatus.unsubscribe();
            }
            if (this.subscriptionOpen) {
                this.subscriptionOpen.unsubscribe();
            }
            if (this.subscriptiongoTo) {
                this.subscriptiongoTo.unsubscribe();
            }
            this.destroy$.next(null);
            this.destroy$.complete();
            this.intervalsScript.clearIntervals();
        } catch (e) {
        }
    }

    private checkDateTimeTimer(): void {
        if (this.hmi.layout?.header?.dateTimeDisplay) {
            interval(1000).pipe(
                takeUntil(this.destroy$)
            ).subscribe(() => {
                this.currentDateTime = new Date();
            });
        }
    }

    private initScheduledScripts() {
        this.intervalsScript.clearIntervals();
        this.projectService.getScripts()?.forEach((script: Script) => {
            if (script.mode === ScriptMode.CLIENT && script.scheduling?.interval > 0) {
                this.intervalsScript.addInterval(
                    script.scheduling.interval * 1000,
                    this.scriptService.evalScript,
                    script,
                    this.scriptService
                );
            }
        });
    }

    async onGoToPage(viewId: string, force: boolean = false, options: any = {}) {
        if (viewId === this.viewAsAlarms) {
            this.onAlarmsShowMode('expand');
            this.checkToCloseSideNav();
        } else if (!this.homeView || viewId !== this.homeView?.id || force || this.scadiaview?.view?.id !== viewId || this.hasPageOptions(options)) {
            const view = await this.projectService.ensureViewLoaded(viewId);
            this.setIframe();
            this.showHomeLink = false;
            this.changeDetector.detectChanges();
            if (view) {
                this.homeView = view;
                this.changeDetector.detectChanges();
                this.setBackground();
                if (this.homeView.type !== this.cardViewType && this.homeView.type !== this.mapsViewType) {
                    this.checkZoom();
                    // A project without an hmi.layout is legal (the layout row is optional):
                    // reading this.hmi.layout here unguarded threw and aborted the whole page
                    // open, leaving the loading overlay up forever.
                    if (this.scadiaview) {
                        this.scadiaview.hmi.layout = this.hmi?.layout ?? null;
                        this.applyPageOptions(options);
                        this.scadiaview.loadHmi(this.homeView);
                    } else {
                        console.warn('home: view component not ready, deferring load of ' + this.homeView.id);
                    }
                } else if (this.cardsview) {
                    this.cardsview.reload();
                }
            }
            this.onAlarmsShowMode('close');
            this.checkToCloseSideNav();
        }
    }

    private hasPageOptions(options: any): boolean {
        return !!(options?.variablesMapping || options?.sourceDeviceId);
    }

    private applyPageOptions(options: any = {}) {
        if (!this.scadiaview) {
            return;
        }
        this.scadiaview.sourceDeviceId = options?.sourceDeviceId;
        this.scadiaview.loadVariableMapping(options?.variablesMapping ?? []);
    }

    onGoToLink(event: string) {
        if (event.indexOf('://') >= 0 || event[0] == '/') {
            this.showHomeLink = true;
            this.changeDetector.detectChanges();
            this.setIframe(event);

        } else {
            /**
             * ABSOLUTE navigation, on purpose - this is the fix for "报表/系统 点不开".
             *
             * `router.navigate(['reports'])` is RELATIVE to the route that is active right now. On
             * /home it happens to resolve to /reports, which is why it looks fine in a quick test.
             * From any deeper route it does not: this app has the view route `/home/:viewName`, and
             * from a screen route the same call resolves to "/home/reports" - which MATCHES that
             * route and quietly tries to open a screen called "reports". Nothing navigates, nothing
             * errors, no message: the menu item simply looks dead, while the very same URL typed
             * into the address bar works (measured 2026-10-06 - the operator reported exactly that
             * pair of symptoms).
             *
             * Menu links name APPLICATION routes, so they are rooted here, and `navigateByUrl` uses
             * the string as-is - the same thing the address bar does.
             */
            const target = '/' + String(event).replace(/^\/+/, '');
            // eslint-disable-next-line no-console
            console.log('[nav] route -> ' + target + '  (from ' + this.router.url + ')');
            this.router.navigateByUrl(target).then(ok => {
                // ok === false means a route guard refused the navigation. Saying so turns a dead
                // click into a visible fact (the operator sees "报表 点不开" otherwise).
                // eslint-disable-next-line no-console
                console.log('[nav] navigate ' + target + ' -> ' + ok + '  now at ' + this.router.url);
                if (!ok) {
                    this.toastr.error('无法打开 ' + target + '（被权限守卫拦下）', '', { timeOut: 5000 });
                }
            }).catch(err => {
                // eslint-disable-next-line no-console
                console.error('[nav] Route ' + event + ' navigation failed: ' + (err && err.message ? err.message : err));
            });
        }
        this.checkToCloseSideNav();
    }

    setIframe(link: string = null) {
        this.homeView = null;
        let currentLink: string;
        this.iframes.forEach(iframe => {
            if (!iframe.hide) {
                currentLink = iframe.link;
            }
            iframe.hide = true;
        });
        if (link) {
            let iframe = this.iframes.find(f => f.link === link);
            if (!iframe) {
                this.iframes.push({ link: link, hide: false });
            } else {
                iframe.hide = false;
                if (currentLink === link) {     // to refresh
                    iframe.link = '';
                    this.changeDetector.detectChanges();
                    iframe.link = link;
                }
            }
        }
    }

    checkToCloseSideNav() {
        if (this.hmi.layout) {
            let nvoid = NaviModeType[this.hmi.layout.navigation.mode];
            if (nvoid !== NaviModeType.fix && this.matsidenav) {
                this.matsidenav.close();
            }
        }
    }

    onLogin() {
        let cuser = this.authService.getUser();
        if (cuser) {
            let dialogRef = this.dialog.open(DialogUserInfo, {
                id: 'myuserinfo',
                // minWidth: '250px',
                position: { top: '50px', right: '15px' },
                backdropClass: 'user-info',
                data: cuser
            });
            dialogRef.afterClosed().subscribe(result => {
                if (result) {
                    this.authService.signOut();
                    this.projectService.reload();
                }
            });
        } else {
            let dialogConfig = {
                data: {},
                disableClose: true,
                autoFocus: false,
                ...(this.hmi.layout.loginoverlaycolor && this.hmi.layout.loginoverlaycolor !== LoginOverlayColorType.none) && {
                    backdropClass: this.hmi.layout.loginoverlaycolor === LoginOverlayColorType.black ? 'backdrop-black' : 'backdrop-white'
                }
            };

            let dialogRef = this.dialog.open(LoginComponent, dialogConfig);
            dialogRef.afterClosed().subscribe(result => {
                const userInfo = new UserInfo(this.authService.getUser()?.info);
                if (userInfo.start) {
                    this.onGoToPage(userInfo.start);
                }
            });
        }
    }

    askValue() {
        this.hmiService.askDeviceValues();
    }

    askStatus() {
        this.hmiService.askDeviceStatus();
    }

    isLoggedIn() {
        return (this.authService.getUser()) ? true : false;
    }

    onAlarmsShowMode(mode: string) {
        if (Utils.getEnumKey(NaviModeType, NaviModeType.fix) === this.hmi.layout.navigation.mode && this.matsidenav) {
            this.alarmPanelWidth = `calc(100% - ${this.matsidenav._getWidth()}px)`;
        }
        let ele = document.getElementById('alarms-panel');
        if (mode === 'expand') {
            ele.classList.add('is-full-active');
            // ele.classList.remove('is-active');
            this.alarmsview.startAskAlarmsValues();
        } else if (mode === 'collapse') {
            ele.classList.add('is-active');
            ele.classList.remove('is-full-active');
            this.alarmsview.startAskAlarmsValues();
        } else {
            // ele.classList.toggle("is-active");
            ele.classList.remove('is-active');
            ele.classList.remove('is-full-active');
        }
    }

    onSetLanguage(language: Language) {
        this.languageService.setCurrentLanguage(language);
        window.location.reload();
    }

    private processValueInHeaderItem(varTag: Variable) {
        this.headerItemsMap.get(varTag.id)?.forEach(item => {
            if (item.status.variablesValue[varTag.id] !== varTag.value) {
                HtmlButtonComponent.processValue(
                    <GaugeSettings>{ property: item.property },
                    item.element ?? Utils.findElementByIdRecursive(this.header.nativeElement, item.id),
                    varTag,
                    item.status,
                    item.type === 'label'
                );
            }
            item.status.variablesValue[varTag.id] = varTag.value;
        });
    }

    private goTo(destination: string) {
        this.router.navigate([destination]);//, this.ID]);
    }

    private async loadHmi() {
        try {
            await this.loadHmiInner();
        } catch (err) {
            // Defence in depth: whatever went wrong, the operator must get a usable screen
            // rather than a spinner that never ends.
            console.error('loadHmi failed', err);
        } finally {
            this.isLoading = false;
        }
    }

    private async loadHmiInner() {
        let hmi = this.projectService.getHmi();
        if (hmi) {
            this.hmi = hmi;
        }
        if (this.hmi && this.hmi.views && this.hmi.views.length > 0) {
            let viewToShow = null;
            if (this.hmi.layout?.start) {
                viewToShow = this.hmi.views.find(x => x.id === this.hmi.layout.start);
            }
            if (!viewToShow) {
                viewToShow = this.hmi.views[0];
            }
            let startView = this.hmi.views.find(x => x.name === this.route.snapshot.queryParamMap.get('viewName')?.trim());
            if (startView) {
                viewToShow = startView;
            }
            // A failing view fetch must NOT strand the user on the loading overlay: it used
            // to reject the whole loadHmi() chain, so isLoading was never cleared and the
            // progress bar stayed up forever with an empty screen underneath. Report it and
            // carry on with whatever we already have.
            try {
                const loaded = await this.projectService.ensureViewLoaded(viewToShow.id);
                if (loaded) {
                    viewToShow = loaded;
                } else {
                    this.toastr.error('view "' + viewToShow.name + '" could not be loaded', '', { timeOut: 5000 });
                }
            } catch (err) {
                console.error('loadHmi: failed to load view ' + viewToShow?.id, err);
                this.toastr.error('view "' + (viewToShow && viewToShow.name) + '" could not be loaded', '', { timeOut: 5000 });
            }
            this.homeView = viewToShow;
            this.setBackground();
            // check sidenav
            this.showSidenav = null;
            // Wall / kiosk presentation always shows the canvas alone.
            if (Utils.isKioskMode()) {
                this.showNavigation = false;
            }
            if (this.hmi.layout && Utils.Boolify(this.hmi.layout.hidenavigation)) {
                this.showNavigation = false;
            }
            // The side navigation is decided OUTSIDE the layout guard, on purpose. A project
            // without a layout row is legal, and it used to mean no menu at all: every line
            // below sat inside 'if (this.hmi.layout)', so the software shipped twenty-five
            // routes while the left bar offered three. With no configured mode the built-in
            // navigation applies, opening over the canvas so it costs the operator nothing.
            let navMode = this.hmi.layout?.navigation?.mode;
            let nvoid = navMode ? NaviModeType[navMode] : NaviModeType.over;
            if (nvoid !== NaviModeType.void) {
                if (nvoid === NaviModeType.fix) {
                    this.showSidenav = 'side';
                    if (this.matsidenav) { this.matsidenav.open(); }
                } else if (nvoid === NaviModeType.push) {
                    this.showSidenav = 'push';
                } else {
                    this.showSidenav = 'over';
                }
                this.sidenav.setLayout(this.hmi.layout);
            }
            if (this.hmi.layout) {
                if (this.hmi.layout.header) {
                    this.title = this.hmi.layout.header.title;
                    if (this.hmi.layout.header.alarms) {
                        this.alarms.mode = this.hmi.layout.header.alarms;
                    }
                    if (this.hmi.layout.header.infos) {
                        this.infos.mode = this.hmi.layout.header.infos;
                    }
                    this.checkHeaderButton();
                    this.layoutHeader = Utils.clone(this.hmi.layout.header);
                    this.layoutHeaderBase = Utils.clone(this.hmi.layout.header);
                    this.changeDetector.detectChanges();
                    this.loadHeaderItems();
                }
                this.checkZoom();
            }
        }
        if (!this.layoutHeaderBase) {
            // Projects saved without a layout section still have a header (the defaults).
            this.layoutHeaderBase = Utils.clone(this.layoutHeader) ?? new HeaderSettings();
        }
        this.applyUiScale();
        if (this.homeView && this.scadiaview) {
            this.scadiaview.hmi.layout = this.hmi.layout;
            this.scadiaview.loadHmi(this.homeView);
        }
        // isLoading is cleared in loadHmi()'s finally block, so it is cleared even on error.
        this.securityEnabled = this.projectService.isSecurityEnabled();
        if (this.securityEnabled && !this.isLoggedIn() && this.hmi?.layout?.loginonstart) {
            this.onLogin();
        }
    }

    /**
     * Manual zoom (pan/zoom) on the whole home canvas. When it is enabled the scale is
     * owned by the user, so ScadiaViewComponent leaves the canvas at 1:1 (see resolveScaleMode).
     */
    /**
     * Grow the operator chrome on very large screens (4K, ultrawide walls) where the design
     * sizes for the header and menus would be unreadable. Scaling the header numbers here is
     * enough: #container is positioned from layoutHeader.height, so the dashboard area - and
     * therefore the view fitting - follows automatically.
     */
    private applyUiScale() {
        const scale = Utils.computeUiScale(this.hmi?.layout);
        Utils.applyUiScale(scale);
        if (!this.layoutHeaderBase) {
            return;
        }
        // Always derive from the configured base: applying the factor to the already scaled
        // values would compound every time the window crosses a breakpoint.
        const base = this.layoutHeaderBase;
        this.layoutHeader.height = Math.round((base.height || HeaderSettings.DefaultHeight) * scale);
        this.layoutHeader.buttonHeight = Math.round((base.buttonHeight || HeaderSettings.DefaultButtonHeight) * scale);
        this.layoutHeader.fontSize = Math.round((base.fontSize || 13) * scale);
    }

    /**
     * Crossing between monitors of different sizes must not leave the chrome at the old scale.
     * The dashboard itself re-fits on its own through its ResizeObserver.
     */
    @HostListener('window:resize')
    onWindowResize() {
        if (!this.layoutHeaderBase) {
            return;
        }
        this.applyUiScale();
        this.changeDetector.detectChanges();
    }

    private checkZoom() {
        if (this.hmi.layout?.zoom && ZoomModeType[this.hmi.layout.zoom] === ZoomModeType.enabled) {
            setTimeout(() => {
                let element: HTMLElement = document.querySelector('#home');
                if (element && panzoom) {
                    panzoom(element, {
                        bounds: true,
                        boundsPadding: 0.05,
                    });
                }
                this.container.nativeElement.style.overflow = 'hidden';
            }, 1000);
        }
    }

    private loadHeaderItems() {
        this.headerItemsMap.clear();
        if (!this.showNavigation) {
            return;
        }
        this.layoutHeader.items?.forEach(item => {
            item.status = item.status ?? new GaugeStatus();
            item.status.onlyChange = true;
            item.status.variablesValue = {};
            item.element = Utils.findElementByIdRecursive(this.header.nativeElement, item.id);
            (item as any).text = this.languageService.getTranslation(item.property?.text) ?? item.property?.text;
            const signalsIds = HtmlButtonComponent.getSignals(item.property);
            signalsIds.forEach(sigId => {
                if (!this.headerItemsMap.has(sigId)) {
                    this.headerItemsMap.set(sigId, []);
                }
                this.headerItemsMap.get(sigId).push(item);
            });
            const settingsProperty = new GaugeSettings(null, HtmlButtonComponent.TypeTag);
            settingsProperty.property = item.property;
            this.onBindMouseEvents(item.element, settingsProperty);
        });
        this.hmiService.homeTagsSubscribe(Array.from(this.headerItemsMap.keys()));
    }

    private onBindMouseEvents(element: HTMLElement, ga: GaugeSettings) {
        if (element) {
            let clickEvents = this.gaugesManager.getBindMouseEvent(ga, GaugeEventType.click);
            if (clickEvents?.length > 0) {
                element.onclick = (ev: MouseEvent) => {
                    this.handleMouseEvent(ga, ev, clickEvents);
                };
                element.ontouchstart = (ev) => {
                    this.handleMouseEvent(ga, ev, clickEvents);
                };

            }
            let mouseDownEvents = this.gaugesManager.getBindMouseEvent(ga, GaugeEventType.mousedown);
            if (mouseDownEvents?.length > 0) {
                element.onmousedown = (ev) => {
                    this.handleMouseEvent(ga, ev, mouseDownEvents);
                };
            }
            let mouseUpEvents = this.gaugesManager.getBindMouseEvent(ga, GaugeEventType.mouseup);
            if (mouseUpEvents?.length > 0) {
                element.onmouseup = (ev) => {
                    this.handleMouseEvent(ga, ev, mouseUpEvents);
                };
            }
        }
    }

    private handleMouseEvent(
        ga: GaugeSettings,
        ev: Event,
        events: GaugeEvent[]
    ) {
        const homeEvents = events.filter(event => event.action === 'onpage');
        homeEvents.forEach(event => {
            this.onGoToPage(event.actparam, this.hasPageOptions(event.actoptions), event.actoptions);
        });
        const scadiaViewEvents = events.filter(event => event.action !== 'onpage');
        let scadiaviewRef = this.scadiaview ?? this.cardsview?.getScadiaView(0);
        if (!scadiaviewRef) {
            return;
        }
        if (scadiaViewEvents.length > 0) {
            scadiaviewRef.runEvents(scadiaviewRef, ga, ev, scadiaViewEvents);
        }
    }

    private setBackground() {
        if (this.homeView?.profile) {
            this.backgroudColor = this.homeView.profile.bkcolor;
        }
    }

    private checkHeaderButton() {
        let fix = <NotificationModeType>Object.keys(NotificationModeType)[Object.values(NotificationModeType).indexOf(NotificationModeType.fix)];
        let float = <NotificationModeType>Object.keys(NotificationModeType)[Object.values(NotificationModeType).indexOf(NotificationModeType.float)];
        if (this.alarms.mode === fix || (this.alarms.mode === float && this.alarms.count > 0)) {
            this.alarms.show = true;
        }
        else {
            this.alarms.show = false;
        }
        if (this.infos.mode === fix || (this.infos.mode === float && this.infos.count > 0)) {
            this.infos.show = true;
        } else {
            this.infos.show = false;
        }
    }

    private setAlarmsStatus(status: AlarmStatus) {
        if (status) {
            this.alarms.count = status.highhigh + status.high + status.low;
            this.infos.count = status.info;
            this.checkHeaderButton();
            this.checkActions(status.actions);
        }
    }

    private checkActions(actions: any[]) {
        if (actions) {
            actions.forEach(act => {
                if (act.type === Utils.getEnumKey(AlarmActionsType, AlarmActionsType.popup)) {
                    this.scadiaview.openDialog(null, act.params, {});
                } else if (act.type === Utils.getEnumKey(AlarmActionsType, AlarmActionsType.setView)) {
                    this.onGoToPage(act.params);
                } else if (act.type === Utils.getEnumKey(AlarmActionsType, AlarmActionsType.toastMessage)) {
                    var msg = act.params;
                    // Check if the toast with the same message is already being displayed
                    const resetOnDuplicate = true;  // Reset the duplicate toast
                    // Use findDuplicate to check if the toast already exists
                    const duplicateToast = this.toastr.findDuplicate('', msg, resetOnDuplicate, false);
                    if (!duplicateToast) {
                        const toastType = act.options?.type ?? 'info';
                        // If no duplicate exists, show the toast
                        this.toastr[toastType](msg, '', {
                            timeOut: 3000,
                            closeButton: true,
                            disableTimeOut: true
                        });
                    }
                }
            });
        }
    }
}

export interface IiFrame {
    link: string;
    hide: boolean;
}

@Component({
    selector: 'user-info',
    templateUrl: 'userinfo.dialog.html',
})
export class DialogUserInfo {
    constructor(
        public dialogRef: MatDialogRef<DialogUserInfo>,
        @Inject(MAT_DIALOG_DATA) public data: any) { }

    onOkClick(): void {
        this.dialogRef.close(true);
    }
}
