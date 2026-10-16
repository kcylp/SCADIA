import { Component, OnDestroy, OnInit, ElementRef, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, timeout } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { LoginComponent } from '../../login/login.component';
import { AuthService } from '../../_services/auth.service';

@Component({ selector: 'app-scene-board', templateUrl: './scene-board.component.html', styleUrls: ['./scene-board.component.css'] })
export class SceneBoardComponent implements OnInit, OnDestroy {
    scenes = [
        {id:'V1',name:'门口进入',thermal:false},{id:'V2',name:'跌倒复核',thermal:false},
        {id:'V3',name:'抽烟复核',thermal:false},{id:'V4',name:'安全帽',thermal:false},
        {id:'V5',name:'人员聚集',thermal:false},{id:'V6',name:'禁区 / 滞留',thermal:false},
        {id:'V7',name:'烟火 / 通道 / 画质',thermal:false},{id:'T1',name:'红外辅助',thermal:true}
    ];
    people = false;
    records = false;
    selectedScene = 'V1';
    ruleSets: any = {};
    ruleBusy = false;
    sourceFilter = '';
    kindFilter = '';
    cameraFilter = '';
    verdictFilter = '';
    private fixedLedgerWindow: {from:number,to:number} = null;
    reviewFilter = '';
    ackFilter = '';
    summary: any = null;
    deliveries: any[] = [];
    history: any[] = [];
    selectedAnalysis: any = null;
    loadSummary():void {
        const identity=this.identityGeneration, seq=this.ledgerSeq, query=this.ledgerQuery();
        this.subs.add(this.http.get<any>('/api/ai/scene-events/summary?'+query).subscribe({next:r=>{if(identity===this.identityGeneration && seq===this.ledgerSeq){this.summary=r;}},error:()=>{if(identity===this.identityGeneration && seq===this.ledgerSeq){this.summary=null;this.message='统计读取失败';}}}));
    }
    loadHistory():void {
        const identity=this.identityGeneration;
        this.subs.add(this.http.get<any>('/api/analysis/history').subscribe({next:r=>{if(identity===this.identityGeneration){this.history=r.rows;}},error:()=>{if(identity===this.identityGeneration){this.message='分析历史读取失败（需管理员权限）';}}}));
        this.subs.add(this.http.get<any>('/api/ai/scene-events/deliveries').subscribe({next:r=>{if(identity===this.identityGeneration){this.deliveries=r.rows;}},error:()=>{if(identity===this.identityGeneration){this.message='投递记录读取失败（需管理员权限）';}}}));
    }
    readAnalysis(id:string):void {
        const identity=this.identityGeneration;this.selectedAnalysis=null;
        this.subs.add(this.http.get<any>('/api/analysis/history/'+encodeURIComponent(id)).subscribe({next:r=>{if(identity===this.identityGeneration){this.selectedAnalysis=r.rows[0];}},error:()=>{if(identity===this.identityGeneration){this.message='分析记录读取失败';}}}));
    }
    exportAnalysis():void {
        if(!this.selectedAnalysis){return;}
        const blob=new Blob([JSON.stringify(this.selectedAnalysis,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
        a.href=url;a.download='SCADIA-分析-'+this.selectedAnalysis.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    private ledgerSeq = 0;
    private identityKey = '';
    private identityGeneration = 0;
    data: any = {};
    ledger: any = {rows:[],count:0,stats:{}};
    error = '';
    message = '';
    focus = '';
    calibrating = false;
    calibrationStep = 'points';
    calibration: any = {version:'none',gate:{enabled:true,points:[],line:[],insidePoint:null}};
    calibrationConfirmed = false;
    offset = 0;
    from = '';
    to = '';
    ledgerBusy = false;
    now = Date.now();
    frameAt: {[key:string]:number} = {};
    private images: {[key:string]:HTMLImageElement} = {};
    private retry: {[key:string]:number} = {};
    private framesBusy: {[key:string]:boolean} = {};
    private frameUrls: {[key:string]:string} = {};
    private evidenceUrls: {[key:string]:string} = {};
    private evidenceGeneration = 0;
    private evidenceBusy = new Set<string>();
    private trails: {[key:string]:{at:number,points:number[][]}} = {};
    private trailSession = '';
    private frameTimer: any;
    private timer: any;
    private raf = 0;
    private pending = false;
    private stopped = false;
    private lastDraw = 0;
    private subs = new Subscription();
    constructor(private http: HttpClient, private router: Router, private route: ActivatedRoute, private auth: AuthService, private host: ElementRef<HTMLElement>, private zone: NgZone, private dialog: MatDialog) {}
    login():void{this.dialog.open(LoginComponent).afterClosed().subscribe(ok=>{if(ok){this.refresh();this.loadLedger();}});}
    ngOnInit(): void {
        this.records = this.router.url.startsWith('/scene-records');
        this.people = this.records || this.router.url.startsWith('/people');
        this.subs.add(this.route.queryParamMap.subscribe(params=>{
            if(!this.records){return;}
            const selected=params.get('scene');
            if(selected==='all'||this.scenes.some(s=>s.id===selected)){this.selectedScene=selected;}
            for(const [key,field] of [['source','sourceFilter'],['kind','kindFilter'],['camera','cameraFilter'],['reviewStatus','reviewFilter'],['verdict','verdictFilter'],['acknowledged','ackFilter']]){this[field]=params.get(key)||'';}
            const from=Number(params.get('from')),to=Number(params.get('to'));
            if(params.has('from')&&params.has('to')&&Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&to>=from){this.fixedLedgerWindow={from,to};const dateText=(at:number)=>{const d=new Date(at);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};this.from=dateText(from);this.to=dateText(to);}
            this.selectScene(false);
        }));
        this.subs.add(this.auth.currentUser$.subscribe(user=>{
            const key=JSON.stringify([(user as any)?.username,(user as any)?.groups,(user as any)?.info]);
            if(key===this.identityKey){return;}this.identityKey=key;this.identityGeneration++;
            this.data={};this.images={};this.frameAt={};this.ledgerSeq++;this.ledgerBusy=false;this.pending=false;
            this.ledger={rows:[],count:0,stats:{}};this.clearEvidence();
            this.history=[];this.deliveries=[];this.selectedAnalysis=null;this.summary=null;this.ruleSets={};this.ruleBusy=false;
            this.refresh();if(this.people){this.loadLedger();}
        }));
        this.timer = setInterval(() => { this.now=Date.now(); if (!document.hidden) { this.refresh(); if(this.people){this.loadLedger();} } },2000);
        if (!this.people) {
            this.zone.runOutsideAngular(() => {
                this.draw(0);
                this.frameTimer=setInterval(()=>{if(!document.hidden){this.connect('visible');this.connect('thermal');}},150);
            });
        }
    }
    private connect(key: string): void {
        if(this.stopped||this.framesBusy[key]||Date.now()<(this.retry[key]||0)){return;}
        this.framesBusy[key]=true;const generation=this.identityGeneration;
        this.subs.add(this.http.get('/api/ai/scenes/frame/'+key,{observe:'response',responseType:'blob'}).pipe(timeout(5000)).subscribe({
            next:r=>{
                if(generation!==this.identityGeneration){this.framesBusy[key]=false;return;}
                const image=new Image(), url=URL.createObjectURL(r.body);
                image.onload=()=>{
                    if(this.stopped||generation!==this.identityGeneration){URL.revokeObjectURL(url);this.framesBusy[key]=false;return;}
                    if(this.frameUrls[key]){URL.revokeObjectURL(this.frameUrls[key]);}
                    this.frameUrls[key]=url;this.images[key]=image;
                    this.frameAt[key]=Number(r.headers.get('X-Frame-Time'))||0;this.framesBusy[key]=false;
                };
                image.onerror=()=>{URL.revokeObjectURL(url);this.framesBusy[key]=false;this.retry[key]=Date.now()+2000;};
                image.src=url;
            },error:()=>{this.framesBusy[key]=false;this.retry[key]=Date.now()+2000;}
        }));
    }
    refresh(): void {
        if (this.pending || this.stopped) { return; }
        this.pending=true;const generation=this.identityGeneration;
        this.subs.add(this.http.get<any>('/api/ai/scenes').pipe(timeout(7000)).subscribe({
            next: data => {
                if(generation!==this.identityGeneration){return;}
                this.data=data; this.error=''; this.pending=false;
                const session=data.visible?.sessionId||'';
                if(session!==this.trailSession){this.trails={};this.trailSession=session;}
                (data.visible?.detections||[]).forEach(d=>{
                    if(!d.region){return;}const key=String(d.id),b=d.region;
                    const trail=this.trails[key]||(this.trails[key]={at:0,points:[]});
                    if(Date.now()-trail.at>3000){trail.points=[];}
                    trail.at=Date.now();trail.points.push([b.x+b.w/2,b.y+b.h]);trail.points=trail.points.slice(-24);
                });
                Object.keys(this.trails).filter(k=>Date.now()-this.trails[k].at>3000).forEach(k=>delete this.trails[k]);
                if (!this.people) { this.zone.runOutsideAngular(() => { this.connect('visible'); this.connect('thermal'); }); }
            }, error: e => { if(generation!==this.identityGeneration){return;}this.pending=false; this.error=e.status===401||e.status===403?'登录或权限失效，请重新登录':'场景服务未响应，请检查连接后重试'; }
        }));
    }
    beginCalibration():void{
        this.calibrating=true;this.focus='V1';this.calibrationStep='points';this.calibrationConfirmed=false;
        this.subs.add(this.http.get<any>('/api/ai/scenes/calibration').pipe(timeout(7000)).subscribe({
            next:d=>{this.calibration={version:d.version,gate:{enabled:true,points:[],line:[],insidePoint:null}};this.message='依次点击门口区域四角，再选择方向线与室内参考点';},
            error:()=>{this.calibrating=false;this.message='标定需要管理员权限，或服务暂不可用';}
        }));
    }
    pickCalibration(event:MouseEvent,scene:any):void{
        if(!this.calibrating||scene.id!=='V1'){return;}
        const canvas=event.currentTarget as HTMLCanvasElement,rect=canvas.getBoundingClientRect(),image=this.images.visible;
        if(!image?.naturalWidth){this.message='等待新鲜可见光画面';return;}
        const r=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight),w=image.naturalWidth*r,h=image.naturalHeight*r;
        const p=[(event.clientX-rect.left-(rect.width-w)/2)/w,(event.clientY-rect.top-(rect.height-h)/2)/h];
        if(p.some(v=>v<0||v>1)){return;}
        const gate=this.calibration.gate;
        if(this.calibrationStep==='points'){gate.points.push(p);if(gate.points.length===4){this.calibrationStep='line';}}
        else if(this.calibrationStep==='line'){gate.line.push(p);if(gate.line.length===2){this.calibrationStep='insidePoint';}}
        else{gate.insidePoint=p;}
    }
    saveCalibration():void{
        this.subs.add(this.http.post<any>('/api/ai/scenes/calibration',{...this.calibration,confirmed:this.calibrationConfirmed}).pipe(timeout(7000)).subscribe({
            next:d=>{this.calibration=d;this.calibrating=false;this.focus='';this.message='门口标定已保存，检测服务将在2秒内读取；请实测正向和反向通行';},
            error:e=>{this.message=e.error?.message||'标定保存失败，请重新读取并核验方向';}
        }));
    }
    source(s: any): any { return this.data[s.thermal?'thermal':'visible']; }
    state(s: any): any { return this.source(s)?.scenes?.find(x=>x.sceneId===s.id); }
    fresh(s: any): boolean { return !this.error && !!this.source(s)?.updatedAt && this.now-this.source(s).updatedAt<8000; }
    entryGateLabel(): string {
        const source=this.data.visible, gate=source?.entryGate;
        if(!this.fresh(this.scenes[0])){return '进入检测暂停 · 分析离线';}
        if(source.calibrationError){return '门口标定应用异常 · 请检查';}
        if(!gate?.enabled || gate.verified!==true || !gate.calibrationVersion || gate.calibrationVersion==='none' || gate.line?.length!==2){return '门口位置待标定';}
        if(source.appliedCalibrationVersion!==gate.calibrationVersion){return '门口标定待应用';}
        return '门口进入 · 朝镜头 / 远处玻璃门均计';
    }
    statusLabel(s: any): string { return ({trial:'检测运行·待现场验收',limited:'能力受限',calibration_required:'待标定',normal:'未触发',active:'已触发',candidate:'疑似候选·待复核'})[this.state(s)?.status]||'等待结果'; }
    review(s: any): any { return this.data.reviews?.byScene?.[s.id]; }
    frameFresh(s: any): boolean { const at=this.frameAt[s.thermal?'thermal':'visible'];return !!at && this.now-at<8000; }
    reviewLabel(s: any): string { return ({running:'正在复核',completed:'复核完成',failed:'复核失败',timeout:'复核超时',unavailable:'证据不可用'})[this.review(s)?.reviewStatus]||'待复核'; }
    reviewEvidence(s: any): any {
        const current=this.review(s);
        return current?.reviewStatus==='completed'?current:this.data.reviews?.lastByScene?.[s.id];
    }
    reviewAge(s: any): string {
        const r=this.reviewEvidence(s);if(!r?.frameAt){return '';}
        const seconds=Math.max(0,Math.floor((this.now-r.frameAt)/1000));
        return (r.eventId?'事件证据 · ':'巡视画面 · ')+(seconds<60?seconds+'秒前':Math.floor(seconds/60)+'分钟前')+(!r.eventId&&seconds>90?' · 已陈旧':'');
    }
    private draw = (at: number): void => {
        if (this.stopped) { return; }
        if (!document.hidden && at-this.lastDraw>=100) {
            this.lastDraw=at;
            this.host.nativeElement.querySelectorAll<HTMLCanvasElement>('canvas[data-scene]').forEach(canvas=>{
                const scene=this.scenes.find(s=>s.id===canvas.dataset.scene);
                if (!scene) { return; }
                const key=scene.thermal?'thermal':'visible', image=this.images[key], ctx=canvas.getContext('2d');
                const w=Math.round(canvas.clientWidth), h=Math.round(canvas.clientHeight);
                if (!ctx || !w || !h) { return; }
                if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
                ctx.fillStyle='#050b14';ctx.fillRect(0,0,w,h);
                if (!image?.naturalWidth || !this.frameAt[key] || this.now-this.frameAt[key]>8000) { return; }
                const ratio=Math.min(w/image.naturalWidth,h/image.naturalHeight);
                const iw=image.naturalWidth*ratio,ih=image.naturalHeight*ratio,x=(w-iw)/2,y=(h-ih)/2;
                ctx.drawImage(image,x,y,iw,ih);
                if(scene.id==='V1'&&this.calibrating){
                    const g=this.calibration.gate;
                    [g.points,g.line].forEach((points:any[])=>{if(!points.length){return;}ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(x+p[0]*iw,y+p[1]*ih):ctx.moveTo(x+p[0]*iw,y+p[1]*ih));ctx.strokeStyle='#ffda83';ctx.lineWidth=3;ctx.stroke();points.forEach(p=>{ctx.beginPath();ctx.arc(x+p[0]*iw,y+p[1]*ih,5,0,Math.PI*2);ctx.fillStyle='#ffda83';ctx.fill();});});
                    if(g.insidePoint){ctx.fillStyle='#ffda83';ctx.fillText('室内',x+g.insidePoint[0]*iw,y+g.insidePoint[1]*ih);}
                }
                if(scene.id==='V1'&&!this.calibrating){
                    const g=this.source(scene)?.entryGate;
                    if(g?.enabled&&g.line?.length===2){
                        ctx.strokeStyle='#ffda83';ctx.lineWidth=2;ctx.beginPath();
                        g.line.forEach((p,i)=>i?ctx.lineTo(x+p[0]*iw,y+p[1]*ih):ctx.moveTo(x+p[0]*iw,y+p[1]*ih));ctx.stroke();
                    }
                    ctx.fillStyle='#ffda83';ctx.font='14px sans-serif';ctx.fillText(this.entryGateLabel(),x+10,y+22);
                }
                if(!this.fresh(scene)){return;}
                (this.state(scene)?.metrics?.regions||[]).forEach(d=>{
                    const b=d.region;ctx.strokeStyle='#ffb573';ctx.lineWidth=2;ctx.strokeRect(x+b.x*iw,y+b.y*ih,b.w*iw,b.h*ih);
                    ctx.fillStyle='#ffda83';ctx.fillText(scene.thermal?'相对热区·待复核':'火苗候选·待复核',x+b.x*iw,Math.max(y+16,y+b.y*ih-4));
                });
                if(!this.fresh(scene)){return;}
                const ids=this.state(scene)?.trackIds||[];
                (this.source(scene)?.detections||[]).filter(d=>ids.includes(String(d.id).replace(/^T/,''))).forEach(d=>{
                    const b=d.region;if(!b){return;}
                    ctx.strokeStyle='#72e2c0';ctx.lineWidth=2;ctx.strokeRect(x+b.x*iw,y+b.y*ih,b.w*iw,b.h*ih);
                    const tid=String(d.id).replace(/^T/,''),seconds=this.state(scene)?.metrics?.stationarySeconds?.[tid];
                    const label=scene.id==='V4'?'戴安全帽':scene.id==='V2'?'蹲下/跌倒疑似':scene.id==='V3'?'手口动作疑似':d.label;
                    ctx.fillStyle='#e8fff7';ctx.font='14px sans-serif';ctx.fillText(label+' '+d.id+(seconds==null?'':' · 原位 '+seconds+'s'),x+b.x*iw,Math.max(y+16,y+b.y*ih-4));
                    if(scene.id==='V1'){
                        const points=this.trails[String(d.id)]?.points||[];
                        ctx.strokeStyle='#72e2c0';ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(x+p[0]*iw,y+p[1]*ih):ctx.moveTo(x+p[0]*iw,y+p[1]*ih));ctx.stroke();
                    }
                });
            });
        }
        this.raf=requestAnimationFrame(this.draw);
    };
    selectScene(syncUrl=true):void{
        if(syncUrl&&this.records){void this.router.navigate([], {relativeTo:this.route,queryParams:{scene:this.selectedScene},queryParamsHandling:'merge',replaceUrl:true});}
        this.summary=null;
        this.ledgerSeq++;this.ledgerBusy=false;this.offset=0;this.ledger={rows:[],count:0,stats:{}};
        this.clearEvidence();
        this.loadLedger();
    }
    datesChanged():void{this.fixedLedgerWindow=null;this.summary=null;this.selectScene(false);}
    filtersChanged():void{this.summary=null;this.selectScene(false);}
    loadRules():void{
        for(const source of ['visible','thermal']){
            const generation=this.identityGeneration;
            this.subs.add(this.http.get<any>('/api/ai/scenes/rules/'+source).subscribe({next:r=>{if(generation===this.identityGeneration){this.ruleSets[source]=r;}},error:()=>{if(generation===this.identityGeneration){this.message='规则读取失败，请检查管理员权限';}}}));
        }
    }
    saveRules(source:string):void{
        if(this.ruleBusy){return;}this.ruleBusy=true;
        const generation=this.identityGeneration;
        this.subs.add(this.http.put<any>('/api/ai/scenes/rules/'+source,this.ruleSets[source]).subscribe({
            next:r=>{if(generation!==this.identityGeneration){return;}this.ruleSets[source]=r;this.ruleBusy=false;this.message='规则已保存；请核对下方worker应用版本';},
            error:e=>{if(generation!==this.identityGeneration){return;}this.ruleBusy=false;this.message=e.status===409?'规则已变更，请重新读取后编辑':'规则保存失败，请检查阈值和权限';}
        }));
    }
    ledgerQuery():string{
        const from=this.fixedLedgerWindow?.from ?? (this.from?new Date(this.from+'T00:00:00').getTime():0);
        const to=this.fixedLedgerWindow?.to ?? (this.to?new Date(this.to+'T23:59:59.999').getTime():Date.now());
        return Object.entries({scene:this.selectedScene,from:String(from),to:String(to),source:this.sourceFilter,kind:this.kindFilter,camera:this.cameraFilter,verdict:this.verdictFilter,reviewStatus:this.reviewFilter,acknowledged:this.ackFilter}).map(([key,value])=>key+'='+encodeURIComponent(value)).join('&');
    }
    analyze(row?:any):void{
        const params:any={module:'video',intent:row?'scene_event':this.selectedScene==='all'?'all_scenes':this.selectedScene};
        if(row){params.sceneId=row.sceneId;params.eventId=row.eventId;params.from=row.at;params.to=row.at+1;}
        else {params.from=this.ledger.window?.from;params.to=(this.ledger.window?.to||Date.now())+1;params.source=this.sourceFilter;params.kind=this.kindFilter;params.camera=this.cameraFilter;params.verdict=this.verdictFilter;params.reviewStatus=this.reviewFilter;params.acknowledged=this.ackFilter;}
        void this.router.navigate(['/analysis'],{queryParams:params});
    }
    exportLedger():void{
        this.subs.add(this.http.get('/api/ai/scene-events/export?'+this.ledgerQuery(),{responseType:'blob'}).subscribe({next:blob=>{
            const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='SCADIA-场景事件.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        },error:()=>this.message='导出失败，请缩小时间窗或检查权限'}));
    }
    reviewStatus(row:any):string{return ({pending:'等待复核',running:'正在复核',completed:'复核完成',failed:'复核失败',timeout:'复核超时',unavailable:'证据不可用'})[row.reviewStatus]||'尚无复核';}
    loadLedger(): void {
        if(this.ledgerBusy){return;}
        const from=this.fixedLedgerWindow?.from ?? (this.from?new Date(this.from+'T00:00:00').getTime():0);
        const to=this.fixedLedgerWindow?.to ?? (this.to?new Date(this.to+'T23:59:59.999').getTime():Date.now());
        if(!Number.isFinite(from)||!Number.isFinite(to)||to<from){this.ledgerSeq++;this.ledger={rows:[],count:0,stats:{}};this.message='结束日期不能早于开始日期';return;}
        this.ledgerBusy=true;const seq=++this.ledgerSeq;
        this.subs.add(this.http.get<any>('/api/ai/scene-events?'+this.ledgerQuery()+'&offset='+this.offset).pipe(timeout(7000)).subscribe({
            next:d=>{if(seq!==this.ledgerSeq){return;}this.ledger=d;this.ledgerBusy=false;if(['事件读取失败，请查询重试','结束日期不能早于开始日期'].includes(this.message)){this.message='';}this.loadEvidence(d.rows);},error:()=>{if(seq!==this.ledgerSeq){return;}this.message='事件读取失败，请查询重试';this.ledgerBusy=false;this.ledger={rows:[],count:0,stats:{}};this.clearEvidence();}
        }));
    }
    page(delta:number):void{if(this.ledgerBusy){return;}this.offset=Math.max(0,this.offset+delta*30);this.loadLedger();}
    private clearEvidence():void{
        this.evidenceGeneration++;this.evidenceBusy.clear();
        Object.values(this.evidenceUrls).forEach(url=>URL.revokeObjectURL(url));this.evidenceUrls={};
    }
    private loadEvidence(rows:any[]):void{
        const ids=new Set(rows.map(r=>r.eventId)),generation=this.evidenceGeneration;
        Object.keys(this.evidenceUrls).filter(id=>!ids.has(id)).forEach(id=>{URL.revokeObjectURL(this.evidenceUrls[id]);delete this.evidenceUrls[id];});
        // A normal ledger poll must not invalidate a slower image for the same event.
        rows.forEach(row=>{const id=row.eventId;if(this.evidenceUrls[id]||this.evidenceBusy.has(id)){return;}
            this.evidenceBusy.add(id);
            this.subs.add(this.http.get('/api/ai/scene-events/'+id+'/evidence',{responseType:'blob'}).pipe(timeout(7000)).subscribe({
                next:blob=>{
                    if(generation!==this.evidenceGeneration||this.stopped){return;}
                    this.evidenceBusy.delete(id);
                    if(this.ledger.rows.some(r=>r.eventId===id)){this.evidenceUrls[id]=URL.createObjectURL(blob);}
                },error:()=>{
                    if(generation!==this.evidenceGeneration||this.stopped){return;}
                    this.evidenceBusy.delete(id);
                    const current=this.ledger.rows.find(r=>r.eventId===id);if(current){current.shotError=true;}
                }
            }));
        });
    }
    shot(row:any):string{return this.evidenceUrls[row.eventId]||'';}
    ack(row:any):void{
        if(row.busy||row.ackAt){return;}row.busy=true;
        this.subs.add(this.http.post<any>('/api/ai/scene-events/'+encodeURIComponent(row.eventId)+'/ack',{}).pipe(timeout(7000)).subscribe({
            next:r=>{row.ackAt=r.ackAt;row.busy=false;this.message='已确认，服务器回读通过；现场状态仍需核实';},
            error:()=>{row.busy=false;this.message='确认未成功，请检查权限并刷新核验';}
        }));
    }
    reset():void{
        if(!window.confirm('清零所有事件统计，保留历史、抓拍和报警。是否继续？')){return;}
        this.subs.add(this.http.post<any>('/api/ai/events/reset',{}).pipe(timeout(7000)).subscribe({
            next:r=>{if(r.status==='ok'&&!r.error){this.message='全部计数已清零，历史记录保留';this.loadLedger();}else{this.message='清零未全部成功，请回读核验';}},
            error:()=>{this.message='清零失败，请检查登录和管理员权限';}
        }));
    }
    ngOnDestroy():void{
        this.stopped=true;clearInterval(this.timer);clearInterval(this.frameTimer);cancelAnimationFrame(this.raf);this.subs.unsubscribe();
        Object.values(this.frameUrls).concat(Object.values(this.evidenceUrls)).forEach(url=>URL.revokeObjectURL(url));
        Object.values(this.images).forEach(im=>{im.onload=null;im.onerror=null;im.src='';});this.images={};
    }
}
