import { Component, OnDestroy, OnInit, ViewChild, ElementRef } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { LoginComponent } from './login/login.component';
import { AuthService } from './_services/auth.service';
import { ProjectService } from './_services/project.service';
import { defaultNavigation } from './_models/default-navigation';
import { NaviItem } from './_models/hmi';

@Component({
    selector: 'app-workspace-shell',
    templateUrl: './workspace-shell.component.html',
    styleUrls: ['./workspace-shell.component.scss']
})
export class WorkspaceShellComponent implements OnInit, OnDestroy {
    groups: NaviItem[] = [];
    expanded = new Set<string>();
    drawer = false;
    compact = false;
    title = '';
    url = '';
    status = '正在读取运行状态';
    @ViewChild('menuButton') menuButton: ElementRef<HTMLButtonElement>;
    private subs = new Subscription();
    private timer: any;
    private polling = false;
    private stopped = false;
    private abort = new AbortController();
    constructor(private router: Router, public auth: AuthService, private project: ProjectService, private dialog: MatDialog) {}
    ngOnInit(): void {
        this.buildMenu();
        this.subs.add(this.router.events.subscribe(e => { if (e instanceof NavigationEnd) { this.updateRoute(); this.closeDrawer(); } }));
        this.subs.add(this.project.onLoadHmi.subscribe(() => this.buildMenu()));
        this.updateRoute();
        this.poll(); this.timer = setInterval(() => { if (!document.hidden) { this.poll(); } }, 5000);
    }
    private buildMenu(): void {
        const groups = defaultNavigation();
        groups[0].children = [{id:'n-home',text:'首页',icon:'home',view:'',link:'monitor-home'}] as NaviItem[];
        const monitor = groups.find(g => g.id === 'g-monitor');
        monitor.text = '实时监控';
        monitor.children.find(n => n.id === 'n-scenes').text = 'AI检测';
        monitor.children.find(n => n.id === 'n-alarms').text = '报警中心';
        const extra = (id: string, text: string, icon: string, link: string) => ({id,text,icon,link} as NaviItem);
        if (this.project.getViewFromId('v_zc_g6')) { monitor.children.push(extra('n-shots','抓拍证据','photo_library','home/v_zc_g6')); }
        const data = groups.find(g => g.id === 'g-data');
        if (this.project.getViewFromId('v_zc_g2')) { data.children.unshift(extra('n-stats','数据统计','bar_chart','home/v_zc_g2')); }
        data.children.unshift(extra('n-analysis','AI综合分析','query_stats','analysis'));
        data.children.push(extra('n-analysis-window','独立分析窗口','open_in_new','ai-analysis'));
        groups.splice(3,0,{id:'g-production',text:'生产与能源',icon:'factory',children:[extra('n-mes','MES看板','precision_manufacturing','mes'),extra('n-ems','EMS看板','bolt','ems')]} as NaviItem);
        const system = groups.find(g => g.id === 'g-system');
        system.children.push(extra('n-models','模型服务配置','settings_suggest','analysis?config=1'));
        system.children.push(extra('n-events','事件日志','event_note','events'));
        monitor.children.push(extra('n-resources','相机资源墙','video_settings','video-resources'));
        this.groups = groups;
        this.updateRoute();
    }
    href(item: NaviItem): string { return '/' + (item.link || 'home').replace(/^\/+/, ''); }
    active(item: NaviItem): boolean { return this.url === this.href(item) || (!this.href(item).includes('?') && this.url.startsWith(this.href(item) + '/')); }
    private updateRoute(): void {
        this.url = this.router.url;
        const current = this.groups.flatMap(g => g.children || []).find(n => this.active(n));
        this.title = current?.text || '工程工作台';
        this.groups.filter(g => g.children?.some(n => this.active(n))).forEach(g => this.expanded.add(g.id));
    }
    toggle(id: string): void { this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id); }
    canShow(item: NaviItem): boolean {
        const adminOnly = ['n-models','n-users','n-roles','n-language','n-plugins','n-apikeys','n-scripts','n-editor','n-lab'];
        return !adminOnly.includes(item.id) || this.auth.isAdmin();
    }
    closeDrawer(focus = true): void { this.drawer = false; if (focus) { this.menuButton?.nativeElement.focus(); } }
    login(): void { this.dialog.open(LoginComponent).afterClosed().subscribe(() => this.poll()); }
    signout(): void { this.auth.signOut(); }
    openAnalysis(event: MouseEvent): void {
        event.preventDefault();
        const w = window.open('/ai-analysis', 'scadia-ai-analysis', 'popup,width=1180,height=820,resizable=yes,scrollbars=yes');
        if (w) { w.focus(); } else { this.router.navigateByUrl('/analysis'); }
        this.closeDrawer(false);
    }
    fullscreen(): void {
        const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
        p.catch(() => { this.status = '浏览器未允许全屏，请使用浏览器全屏操作'; });
    }
    private async poll(): Promise<void> {
        if (this.polling || this.stopped) { return; }
        this.polling = true;
        const headers: Record<string,string> = {};
        if (this.auth.getUserToken()) { headers['x-access-token'] = this.auth.getUserToken(); }
        try {
            const timeout = setTimeout(() => this.abort.abort(), 6000);
            let r: Response;
            try { r = await fetch('/api/ai/scenes', {headers,signal:this.abort.signal}); }
            finally { clearTimeout(timeout); if (!this.stopped) { this.abort = new AbortController(); } }
            if (!r.ok) { this.status = r.status === 401 || r.status === 403 ? '请登录以读取运行状态' : '运行状态读取失败'; return; }
            const d = await r.json(), now = Date.now();
            const fresh = (v: any) => !!v?.updatedAt && now - v.updatedAt < 8000;
            this.status = '可见光分析' + (fresh(d.visible) ? '更新' : '离线') + ' · 红外分析' + (fresh(d.thermal) ? '更新' : '离线');
        } catch (_) { if (!this.stopped) { this.status = '运行状态暂不可用'; } }
        finally { this.polling = false; }
    }
    ngOnDestroy(): void { this.stopped = true; clearInterval(this.timer); this.abort.abort(); this.subs.unsubscribe(); }
}
