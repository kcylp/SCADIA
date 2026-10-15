import { Component, OnDestroy, OnInit, ElementRef, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subscription, timeout } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { LoginComponent } from '../../login/login.component';

@Component({ selector: 'app-scene-board', templateUrl: './scene-board.component.html', styleUrls: ['./scene-board.component.css'] })
export class SceneBoardComponent implements OnInit, OnDestroy {
    scenes = [
        {id:'V1',name:'门口进入',thermal:false},{id:'V2',name:'跌倒复核',thermal:false},
        {id:'V3',name:'抽烟复核',thermal:false},{id:'V4',name:'安全帽',thermal:false},
        {id:'V5',name:'人员聚集',thermal:false},{id:'V6',name:'禁区 / 滞留',thermal:false},
        {id:'V7',name:'烟火 / 通道 / 画质',thermal:false},{id:'T1',name:'红外辅助',thermal:true}
    ];
    people = false;
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
    private trails: {[key:string]:{at:number,points:number[][]}} = {};
    private trailSession = '';
    private frameTimer: any;
    private timer: any;
    private raf = 0;
    private pending = false;
    private stopped = false;
    private lastDraw = 0;
    private subs = new Subscription();
    constructor(private http: HttpClient, private router: Router, private host: ElementRef<HTMLElement>, private zone: NgZone, private dialog: MatDialog) {}
    login():void{this.dialog.open(LoginComponent).afterClosed().subscribe(ok=>{if(ok){this.refresh();this.loadLedger();}});}
    ngOnInit(): void {
        this.people = this.router.url.startsWith('/people');
        this.refresh(); if(this.people){this.loadLedger();}
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
        this.framesBusy[key]=true;
        this.subs.add(this.http.get('/api/ai/scenes/frame/'+key,{observe:'response',responseType:'blob'}).pipe(timeout(5000)).subscribe({
            next:r=>{
                const image=new Image(), url=URL.createObjectURL(r.body);
                image.onload=()=>{
                    if(this.stopped){URL.revokeObjectURL(url);return;}
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
        this.pending=true;
        this.subs.add(this.http.get<any>('/api/ai/scenes').pipe(timeout(7000)).subscribe({
            next: data => {
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
            }, error: e => { this.pending=false; this.error=e.status===401||e.status===403?'登录或权限失效，请重新登录':'场景服务未响应，请检查连接后重试'; }
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
                    ctx.fillStyle='#ffda83';ctx.font='14px sans-serif';ctx.fillText('← 右向左进入 · '+(g?.enabled?'方向线已应用':'门口位置待标定'),x+10,y+22);
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
    loadLedger(): void {
        if(this.ledgerBusy){return;}
        const from=this.from?new Date(this.from+'T00:00:00').getTime():0;
        const to=this.to?new Date(this.to+'T23:59:59.999').getTime():Date.now();
        if(to<from){this.message='结束日期不能早于开始日期';return;}
        this.ledgerBusy=true;
        this.subs.add(this.http.get<any>('/api/ai/scene-events?scene=V1&offset='+this.offset+'&from='+from+'&to='+to).pipe(timeout(7000)).subscribe({
            next:d=>{this.ledger=d;this.ledgerBusy=false;if(this.message==='事件读取失败，请查询重试'){this.message='';}this.loadEvidence(d.rows);},error:()=>{this.message='事件读取失败，请查询重试';this.ledgerBusy=false;}
        }));
    }
    page(delta:number):void{this.offset=Math.max(0,this.offset+delta*30);this.loadLedger();}
    private loadEvidence(rows:any[]):void{
        const ids=new Set(rows.map(r=>r.eventId));
        Object.keys(this.evidenceUrls).filter(id=>!ids.has(id)).forEach(id=>{URL.revokeObjectURL(this.evidenceUrls[id]);delete this.evidenceUrls[id];});
        rows.forEach(row=>{if(this.evidenceUrls[row.eventId]){return;}
            this.subs.add(this.http.get('/api/ai/scene-events/'+row.eventId+'/evidence',{responseType:'blob'}).pipe(timeout(7000)).subscribe({
                next:blob=>{this.evidenceUrls[row.eventId]=URL.createObjectURL(blob);},error:()=>{row.shotError=true;}
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
