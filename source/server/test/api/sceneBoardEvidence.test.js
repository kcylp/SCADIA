'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

// Run the shipped component's request callbacks without an Angular/browser runtime.
function board() {
    const pending = [], exports = {}, created = [];
    let identity;
    const source = fs.readFileSync(path.join(__dirname, '../../../client/src/app/cameras/scene-board/scene-board.component.ts'), 'utf8');
    const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2020, experimentalDecorators:true}}).outputText;
    const sandbox = {exports, console, Date, Set, URL:{createObjectURL(blob){created.push(blob);return 'blob:'+created.length;},revokeObjectURL(){}},
        setInterval(){return 1;},clearInterval(){},cancelAnimationFrame(){},
        require(name) {
            if(name === '@angular/core') return {Component:()=>type=>type};
            if(name === 'rxjs') return {Subscription:class {add(){} unsubscribe(){}},timeout:()=>null};
            if(name === '../../login/login.component') return {LoginComponent:class {}};
            throw new Error('Unexpected runtime dependency: '+name);
        }};
    vm.runInNewContext(js, sandbox);
    const http = {get(url){return {pipe(){return this;},subscribe(observer){pending.push({url,observer});return {};}};}};
    const component = new exports.SceneBoardComponent(http,{url:'/scene-records'},
        {queryParamMap:{subscribe(){return {};}}},{currentUser$:{subscribe(fn){identity=fn;return {};}}},{},{},{});
    component.ngOnInit();
    const poll = (rows=[{eventId:'a'}]) => {
        component.loadLedger();
        const request=pending.filter(p=>p.url.includes('scene-events?')).at(-1);
        request.observer.next({rows,count:rows.length,stats:{}});
    };
    const images = () => pending.filter(p=>p.url.endsWith('/evidence'));
    return {component,poll,images,created,identity:user=>identity(user)};
}

describe('Scene board applied doorway status',()=>{
    function ready(){
        const component=board().component;
        component.data={visible:{updatedAt:component.now,entryGate:{enabled:true,verified:true,
            line:[[.5,.1],[.5,.9]],calibrationVersion:'saved-v1'},appliedCalibrationVersion:'saved-v1'}};
        return component;
    }
    it('removes the calibration warning only for a fresh applied gate',()=>{
        const c=ready(),gate=c.data.visible.entryGate;assert.equal(c.entryGateLabel(),'门口进入 · 朝镜头 / 远处玻璃门均计');
        for(const invalid of [undefined,{...gate,enabled:false},{...gate,verified:false},
            {...gate,calibrationVersion:null},{...gate,calibrationVersion:'none'},{...gate,line:[]}]){
            c.data.visible.entryGate=invalid;assert.equal(c.entryGateLabel(),'门口位置待标定');
        }
    });
    it('distinguishes unapplied versions, application failures and offline data',()=>{
        const c=ready();c.data.visible.appliedCalibrationVersion='old';
        assert.equal(c.entryGateLabel(),'门口标定待应用');
        c.data.visible.calibrationError='ValueError';assert.equal(c.entryGateLabel(),'门口标定应用异常 · 请检查');
        c.data.visible.updatedAt=c.now-8000;assert.equal(c.entryGateLabel(),'进入检测暂停 · 分析离线');
        c.data.visible.updatedAt=c.now;c.error='unauthorized';assert.equal(c.entryGateLabel(),'进入检测暂停 · 分析离线');
    });
});

describe('Scene board historical image lifetime',()=>{
    it('keeps a slow historical image across ordinary ledger polls without duplicate requests',()=>{
        const b=board();b.poll();const first=b.images()[0];
        b.poll();b.poll();assert.equal(b.images().length,1);
        first.observer.next({image:'historical'});
        assert.equal(b.component.shot({eventId:'a'}),'blob:1');assert.equal(b.created.length,1);
        b.poll();assert.equal(b.images().length,1);
    });
    it('drops an old scene response without clearing the new scene request',()=>{
        const b=board();b.poll();const old=b.images()[0];
        b.component.selectedScene='T1';b.component.selectScene(false);b.poll();
        const current=b.images()[1];old.observer.next({image:'old'});
        b.poll();assert.equal(b.images().length,2);assert.equal(b.created.length,0);
        current.observer.next({image:'new'});assert.equal(b.component.shot({eventId:'a'}),'blob:1');
    });
    it('discards images from the previous identity even when the event ID is the same',()=>{
        const b=board();b.poll();const old=b.images()[0];
        b.identity({username:'new-user',groups:255});b.poll();
        old.observer.next({image:'private-old-user'});assert.equal(b.created.length,0);
        b.images()[1].observer.next({image:'current-user'});assert.equal(b.created.length,1);
    });
    it('does not create a URL for an event no longer in the visible page',()=>{
        const b=board();b.poll();b.poll([{eventId:'b'}]);
        b.images()[0].observer.next({image:'old-page'});assert.equal(b.created.length,0);
    });
    it('reports a delayed failure on the current row after a ledger poll',()=>{
        const b=board();b.poll();const oldRow=b.component.ledger.rows[0];b.poll();
        b.images()[0].observer.error({status:404});
        assert.equal(b.component.ledger.rows[0].shotError,true);assert.equal(oldRow.shotError,undefined);
    });
});
