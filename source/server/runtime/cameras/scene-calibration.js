'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const bad = m => Object.assign(new Error(m), {code:'AI_BAD_PAYLOAD'});
const point = p => Array.isArray(p) && p.length===2 && p.every(v=>typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1);
const EPS = 1e-9;
const cross = (a,b,p) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
const onSegment = (a,b,p) => Math.abs(cross(a,b,p))<=EPS && p.every((v,i)=>v>=Math.min(a[i],b[i])-EPS && v<=Math.max(a[i],b[i])+EPS);
function intersects(a,b,c,d) {
    const ab=[cross(a,b,c),cross(a,b,d)], cd=[cross(c,d,a),cross(c,d,b)];
    return ab[0]*ab[1]<-EPS*EPS && cd[0]*cd[1]<-EPS*EPS ||
        onSegment(a,b,c)||onSegment(a,b,d)||onSegment(c,d,a)||onSegment(c,d,b);
}
function contains(p,points,boundary=true) {
    let hit=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++) {
        const a=points[j], b=points[i];
        if(onSegment(a,b,p)){return boundary;}
        if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]){hit=!hit;}
    }
    return hit;
}
function polygon(p) {
    if(!Array.isArray(p)||p.length<3||p.length>32||!p.every(point)){throw bad('区域需3–32个有效点');}
    for(let i=0;i<p.length;i++) {
        for(let j=i+1;j<p.length;j++) {
            if(Math.hypot(p[i][0]-p[j][0],p[i][1]-p[j][1])<=EPS){throw bad('区域不能有重复顶点');}
            if(j!==i+1 && !(i===0 && j===p.length-1) && intersects(p[i],p[(i+1)%p.length],p[j],p[(j+1)%p.length])){throw bad('区域不能自交或重叠');}
        }
        if(Math.abs(cross(p[i],p[(i+1)%p.length],p[(i+2)%p.length]))<=EPS){throw bad('区域存在退化边角');}
    }
    const area=Math.abs(p.reduce((a,v,i)=>a+v[0]*p[(i+1)%p.length][1]-v[1]*p[(i+1)%p.length][0],0))/2;
    if(area<.0001){throw bad('区域面积过小');}
    return p;
}
function segmentInside(a,b,points) {
    if(!contains(a,points)||!contains(b,points)){return false;}
    // Check every boundary-delimited interval, not only endpoints or a few samples:
    // a threshold can otherwise bridge a narrow notch in a concave ROI.
    const dx=b[0]-a[0],dy=b[1]-a[1],cuts=[0,1];
    for(let i=0;i<points.length;i++) {
        const c=points[i],d=points[(i+1)%points.length],ex=d[0]-c[0],ey=d[1]-c[1];
        const den=dx*ey-dy*ex;
        if(Math.abs(den)>EPS) {
            const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den;
            const u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den;
            if(t>=0 && t<=1 && u>=0 && u<=1){cuts.push(t);}
        } else if(Math.abs(cross(a,b,c))<=EPS) {
            for(const p of [c,d]) {
                const t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy);
                if(t>0 && t<1){cuts.push(t);}
            }
        }
    }
    cuts.sort((x,y)=>x-y);
    return cuts.slice(1).every((t,i)=>{
        const mid=(t+cuts[i])/2;
        return contains([a[0]+dx*mid,a[1]+dy*mid],points);
    });
}
function validate(body) {
    const gate=body?.gate;
    if(!gate||typeof gate.enabled!=='boolean'){throw bad('缺少门口标定');}
    if(!gate.enabled){return {enabled:false,verified:false};}
    polygon(gate.points);
    if(!Array.isArray(gate.line)||gate.line.length!==2||!gate.line.every(point)||!point(gate.insidePoint)){throw bad('需要方向线两点及室内参考点');}
    const [a,b]=gate.line, p=gate.insidePoint;
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    if(length<.01||Math.abs((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))/length<.01){throw bad('方向线或室内参考点退化');}
    if(!segmentInside(a,b,gate.points)||!contains(p,gate.points,false)){throw bad('方向线和室内参考点必须位于门口区域内');}
    const distances=gate.points.map(v=>cross(a,b,v)/length);
    if(Math.min(...distances)>=-.015 || Math.max(...distances)<=.015 || Math.abs(cross(a,b,p))/length<=.015){throw bad('门槛两侧需留出稳定检测空间');}
    if(body.confirmed!==true){throw bad('需确认门口和方向，不得使用默认标定');}
    return {enabled:true,verified:true,points:gate.points,line:gate.line,insidePoint:gate.insidePoint,
        stableFrames:3,margin:.015,maxGapSeconds:2};
}
class Calibration {
    constructor(workDir){this.file=path.join(workDir,'ai-tracker.json');this.busy=false;}
    read(){const cfg=JSON.parse(fs.readFileSync(this.file,'utf8'));return {version:cfg.entryGate?.calibrationVersion||'none',gate:cfg.entryGate||{enabled:false},source:'visible'};}
    save(body,user){
        if(this.busy){throw bad('正在保存，请稍后重试');}this.busy=true;
        try{
            const gate=validate(body),cfg=JSON.parse(fs.readFileSync(this.file,'utf8'));
            if(body.version!==(cfg.entryGate?.calibrationVersion||'none')){throw bad('标定已被其他操作更新，请重新读取');}
            cfg.entryGate={...gate,calibrationVersion:randomUUID(),calibratedAt:Date.now(),calibratedBy:user};
            const tmp=this.file+'.'+randomUUID()+'.tmp';
            try{fs.writeFileSync(tmp,JSON.stringify(cfg,null,2));fs.renameSync(tmp,this.file);}
            finally{if(fs.existsSync(tmp)){fs.unlinkSync(tmp);}}
            return this.read();
        }finally{this.busy=false;}
    }
}
module.exports={Calibration,validate};
