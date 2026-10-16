'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the shipped inline script with a minimal DOM; no live site data or browser session.
function page() {
    const nodes = new Map();
    const node = id => {
        if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,style:{},dataset:{},textContent:'',innerHTML:'',children:[],
            replaceChildren(...children){this.children=children;this.innerHTML='';this.textContent='';},appendChild(child){this.children.push(child);},querySelectorAll(){return [];}});
        return nodes.get(id);
    };
    node('module').value='video';node('intent').value='V1';node('window').value='3600000';
    const storage = new Map([['currentUser',JSON.stringify({username:'alice',groups:255})]]);
    let pending=[],urlId=0;
    const sandbox={console,URL:{createObjectURL:()=> 'blob:test-'+(++urlId),revokeObjectURL(){}},URLSearchParams,
        AbortSignal,Date,JSON,Number,String,document:{getElementById:node,createElement:()=>({style:{}}),body:{classList:{add(){}}},querySelectorAll:()=>[]},
        sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},location:{search:'',origin:'http://test'},
        fetch:()=>new Promise(resolve=>pending.push(resolve)),setInterval(){}};
    sandbox.window=sandbox;sandbox.parent=sandbox;sandbox.scadiaAccessToken='test-token';
    const html=fs.readFileSync(path.join(__dirname,'../../ai-analysis.html'),'utf8');
    const script=html.match(/<script>([\s\S]*)<\/script>/)[1].split("$('module').onchange=")[0];
    const context=vm.createContext(sandbox);vm.runInContext(script,context);
    return {node,storage,pending,run:code=>vm.runInContext(code,context)};
}
const fixture = scene => ({generatedAt:Date.now(),evidenceQuality:{sufficient:false,missing:[]},evidence:[{kind:'scene',data:{
    target:{id:scene,name:'测试场景',source:scene==='T1'?'thermal':'visible'},count:1,state:{detail:'检测状态'},patrol:null,
    events:[{sceneId:scene,sceneName:'测试场景',source:scene==='T1'?'thermal':'visible',camera:'test-camera',at:Date.now(),
        eventId:'a'.repeat(32),label:'<img src=x onerror=alert(1)>',reviewStatus:'completed',review:{verdict:'证据不足',text:'缺少连续证据'},trackId:'T1'}]
}}]});

describe('Unified analysis UI scene isolation',()=>{
    it('renders scene records with escaped labels and a scene-specific full-ledger link',()=>{
        const p=page();p.run('evidence='+JSON.stringify(fixture('T1'))+';renderEvidence()');
        assert.equal(p.node('scene-records').hidden,false);assert(p.node('scene-rows').innerHTML.includes('T1'));
        assert(p.node('scene-rows').innerHTML.includes('&lt;img'));assert(!p.node('scene-rows').innerHTML.includes('<img'));
        assert.equal(p.node('scene-ledger').href,'/scene-records?scene=T1');
        assert(p.node('facts').innerHTML.includes('当前返回记录的复核完成数'));
    });
    it('does not restore evidence from a previous scene after a delayed response',async()=>{
        const p=page(),request=p.run("showEvidence({sceneId:'V1',eventId:'a'.repeat(32),at:1,label:'进入'})");
        p.node('intent').value='T1';p.run('clearScene()');
        p.pending.shift()({ok:true,blob:async()=>({})});await request;
        assert.equal(p.node('scene-evidence').children.length,0);
    });
    it('lets the latest evidence click win over a slower previous click',async()=>{
        const p=page(),first=p.run("showEvidence({sceneId:'V1',eventId:'a'.repeat(32),at:1,label:'first'})");
        const second=p.run("showEvidence({sceneId:'V1',eventId:'b'.repeat(32),at:1,label:'second'})");
        p.pending[1]({ok:true,blob:async()=>({})});await second;
        p.pending[0]({ok:true,blob:async()=>({})});await first;
        assert(p.node('scene-evidence').children[0].alt.includes('second'));
    });
    it('drops a response if identity changes even before the identity timer runs',async()=>{
        const p=page(),request=p.run("showEvidence({sceneId:'V1',eventId:'a'.repeat(32),at:1,label:'private'})");
        p.storage.set('currentUser',JSON.stringify({username:'bob',groups:1}));
        p.pending[0]({ok:true,blob:async()=>({})});await request;
        assert.equal(p.node('scene-evidence').children.length,0);
        p.run("sessionSignature='old';checkSession()");assert.equal(p.node('scene-records').hidden,true);
    });
    it('opens saved results using the production history response and clears them on account change',async()=>{
        const p=page(),list=p.node('history-refresh').onclick();
        await new Promise(r=>setImmediate(r));
        p.pending[0]({ok:true,json:async()=>({rows:[{id:'saved-id',at:123,intent:'scene_t1'}]})});await list;
        assert.equal(p.node('history-rows').children.length,1);
        const open=p.node('history-rows').children[0].onclick();await new Promise(r=>setImmediate(r));
        p.pending[1]({ok:true,json:async()=>({rows:[{id:'saved-id',at:123,actor:'alice',result:{answer:'原始结果',question:'历史问题',window:{from:1,to:2},filters:{source:'thermal'}}}]})});await open;
        assert(p.node('history-answer').textContent.includes('原始结果'));assert(p.node('history-answer').textContent.includes('历史问题'));
        assert(p.node('history-answer').textContent.includes('thermal'));assert.equal(p.node('history-export').hidden,false);
        p.storage.set('currentUser',JSON.stringify({username:'bob',groups:1}));p.run('checkSession()');
        assert.equal(p.node('history-answer').textContent,'');assert.equal(p.node('history-export').hidden,true);assert.equal(p.node('analysis-history').hidden,true);
    });
    it('reports a missing historical image without falling back to a live frame',async()=>{
        const p=page(),request=p.run("showEvidence({sceneId:'V1',eventId:'a'.repeat(32),at:1,label:'进入'})");
        p.pending[0]({ok:false,status:404});await request;
        assert(p.node('scene-evidence').textContent.includes('404'));assert.equal(p.node('scene-evidence').children.length,0);
    });
});
