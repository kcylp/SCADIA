'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {SceneStore}=require('../../runtime/cameras/scene-store');
const {deliverScenes}=require('../../runtime/notificator/scenes');

describe('Scene notification delivery with local stub transports',function(){
    this.timeout(20000);
    let dir,store;
    const eventId='a'.repeat(32);
    function writeEvent(at){
        fs.writeFileSync(path.join(dir,'scene-events',eventId+'.json'),JSON.stringify({eventId,sceneId:'V7',source:'visible',kind:'fire',at,camera:'cam',trackId:'7',shot:'scene-'+eventId+'.jpg',label:'火焰候选',calibrationVersion:'t'}));
    }
    beforeEach(async()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'scadia-notify-'));fs.mkdirSync(path.join(dir,'scene-events'));fs.mkdirSync(path.join(dir,'images'));
        store=new SceneStore(dir,path.join(dir,'images'));await store.ready;
    });
    afterEach(async()=>{await store.close();fs.rmSync(dir,{recursive:true,force:true});});
    it('delivers events from the subscription window once and dedupes across scheduler runs',async()=>{
        const sent=[];
        const sub={id:'sub-ok',type:'scenes',enabled:true,receiver:'stub-ok',sceneIds:['V7'],scenePhases:['candidate']};
        const t0=Date.now();
        await deliverScenes(store,[sub],async()=>{throw Error('must not run');},t0);   // 建立订阅窗口
        writeEvent(t0+1000);
        await deliverScenes(store,[sub],async(s,msg)=>{sent.push([s.receiver,msg]);},t0+60000);
        await deliverScenes(store,[sub],async(s,msg)=>{sent.push([s.receiver,msg]);},t0+120000);
        assert.equal(sent.length,1);
        assert.equal(sent[0][0],'stub-ok');
        assert.match(sent[0][1],/eventId: [0-9a-f]{10}/);
        const rows=await store.all("SELECT status,attempts,error FROM scene_deliveries WHERE subscription='sub-ok'");
        assert.deepEqual(rows,[{status:'sent',attempts:1,error:null}]);
    });
    it('retries failed transports with backoff and stops after three attempts',async()=>{
        let calls=0;const t0=Date.now();
        const sub={id:'sub-bad',type:'scenes',enabled:true,receiver:'stub-bad',sceneIds:['V7'],scenePhases:['candidate']};
        await deliverScenes(store,[sub],async()=>{},t0);
        writeEvent(t0+1000);
        await deliverScenes(store,[sub],async()=>{calls++;throw Error('network down');},t0+60000);
        assert.equal(calls,1);
        let rows=await store.all("SELECT status,attempts,nextAt FROM scene_deliveries WHERE subscription='sub-bad'");
        assert.equal(rows[0].status,'failed');assert.equal(rows[0].attempts,1);assert.ok(rows[0].nextAt>t0+60000);
        await deliverScenes(store,[sub],async()=>{calls++;throw Error('network down');},rows[0].nextAt-1);
        assert.equal(calls,1);
        await deliverScenes(store,[sub],async()=>{calls++;throw Error('network down');},rows[0].nextAt+1);
        assert.equal(calls,2);
        rows=await store.all("SELECT status,attempts,nextAt FROM scene_deliveries WHERE subscription='sub-bad'");
        assert.equal(rows[0].attempts,2);
        await deliverScenes(store,[sub],async()=>{calls++;throw Error('network down');},rows[0].nextAt+1);
        assert.equal(calls,3);
        rows=await store.all("SELECT status,attempts,nextAt FROM scene_deliveries WHERE subscription='sub-bad'");
        assert.equal(rows[0].attempts,3);
        await deliverScenes(store,[sub],async()=>{calls++;throw Error('network down');},rows[0].nextAt+1000000);
        assert.equal(calls,3);
        rows=await store.all("SELECT status,error FROM scene_deliveries WHERE subscription='sub-bad'");
        assert.equal(rows[0].status,'failed');assert.equal(rows[0].error,'transport_failed');
    });
    it('never sends the queued old scope after an edit changes the subscription window',async()=>{
        const sent=[];
        let sub={id:'sub-edit',type:'scenes',enabled:true,receiver:'r',sceneIds:['V7'],scenePhases:['candidate']};
        const t0=Date.now();
        await deliverScenes(store,[sub],async()=>{},t0);
        writeEvent(t0+1000);
        await deliverScenes(store,[sub],async(s,m)=>sent.push(m),t0+60000);
        assert.equal(sent.length,1);
        sub={...sub,sceneIds:['V1']};
        await deliverScenes(store,[sub],async(s,m)=>sent.push(m),t0+120000);
        assert.equal(sent.length,1);
        const rows=await store.all("SELECT status FROM scene_deliveries WHERE subscription='sub-edit'");
        assert.equal(rows.length,1);assert.equal(rows[0].status,'sent');
    });
});
