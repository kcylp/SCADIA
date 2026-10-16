'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SceneStore } = require('../../runtime/cameras/scene-store');
const { deliverScenes, validateSubscription } = require('../../runtime/notificator/scenes');
const { sceneContent } = require('../../runtime/reporting/scenes');

describe('Scene consumers use durable event identities', () => {
    let dir, store, now;
    const sub = {id:'local-test',type:'scenes',enabled:true,sceneIds:['V3'],scenePhases:['candidate','review']};
    const eventId = 'c'.repeat(32);
    beforeEach(async () => {
        now=Date.now()-1000;dir=fs.mkdtempSync(path.join(os.tmpdir(),'scadia-consumers-'));
        fs.mkdirSync(path.join(dir,'scene-events'));fs.mkdirSync(path.join(dir,'images'));
        store=new SceneStore(dir,path.join(dir,'images'));await store.ready;
    });
    afterEach(async()=>{await store.close();fs.rmSync(dir,{recursive:true,force:true});});
    const queue=()=>fs.writeFileSync(path.join(dir,'scene-events',eventId+'.json'),JSON.stringify({eventId,sceneId:'V3',source:'visible',kind:'smoking',at:now+100,camera:'local',trackId:'T1',shot:'scene-'+eventId+'.jpg',label:'抽烟候选',calibrationVersion:'rule-test'}));
    it('does not replay old history and delivers candidate and review once, including after restart',async()=>{
        let sent=[];const send=async(s,text)=>sent.push(text);
        await deliverScenes(store,[sub],send,now);
        queue();await deliverScenes(store,[sub],send,now+200);await deliverScenes(store,[sub],send,now+300);
        assert.equal(sent.length,1);assert(sent[0].includes(eventId));assert(sent[0].includes('候选事件'));
        const claim=await store.claimReview();
        await store.finishReview(eventId,{lease:claim.lease,result:{reviewStatus:'completed',verdict:'证据不足',text:'细节不清'}});
        await deliverScenes(store,[sub],send,now+400);assert.equal(sent.length,2);assert(sent[1].includes('证据不足'));
        await store.close();store=new SceneStore(dir,path.join(dir,'images'));await store.ready;
        await deliverScenes(store,[sub],send,now+500);assert.equal(sent.length,2);
        assert((await store.deliveries()).every(r=>r.status==='sent'));
    });
    it('persists failure without transport secrets, retries and respects disabled subscriptions',async()=>{
        const candidate={...sub,scenePhases:['candidate']};let attempts=0;
        const fail=async()=>{attempts++;throw new Error('secret://password');};
        await deliverScenes(store,[candidate],fail,now);queue();
        await deliverScenes(store,[candidate],fail,now+200);assert.equal(attempts,1);
        assert(!JSON.stringify(await store.deliveries()).includes('password'));
        await deliverScenes(store,[candidate],fail,now+300);assert.equal(attempts,1);
        await deliverScenes(store,[candidate],async()=>{attempts++;},now+100000);assert.equal(attempts,2);
        await deliverScenes(store,[candidate],fail,now+200000);assert.equal(attempts,2);
        await deliverScenes(store,[{...candidate,enabled:false}],fail,now+300000);assert.equal(attempts,2);
    });
    it('validates scopes and filters event subtypes before queuing either phase',async()=>{
        for(const change of [{sceneIds:['V9']},{sceneIds:[]},{scenePhases:['error']},{scenePhases:[]},{sceneKinds:['bad,kind']},{sceneKinds:'smoking'}])
            assert.throws(()=>validateSubscription({...sub,...change}),/Invalid scene/);
        const filtered={...sub,sceneKinds:['fire']};let sent=0;
        await deliverScenes(store,[filtered],async()=>sent++,now);queue();
        await deliverScenes(store,[filtered],async()=>sent++,now+200);assert.equal(sent,0);
        assert.equal((await store.deliveries()).length,0);
        await deliverScenes(store,[{...filtered,sceneKinds:['smoking']}],async()=>sent++,now+300);assert.equal(sent,0);
        assert.equal((await store.deliveries()).length,0);
    });
    it('starts a fresh window after re-enabling without replaying failed deliveries',async()=>{
        let sent=0;const fail=async()=>{sent++;throw Error('network');};
        await deliverScenes(store,[sub],fail,now);queue();await deliverScenes(store,[sub],fail,now+200);assert.equal(sent,1);
        await deliverScenes(store,[{...sub,enabled:false}],fail,now+300);
        await deliverScenes(store,[sub],fail,now+100000);assert.equal(sent,1);
        assert.equal((await store.deliveries()).length,0);
    });
    it('does not replay events predating first activation',async()=>{
        queue();await deliverScenes(store,[sub],async()=>{throw new Error('must not send');},now+500);
        assert.equal((await store.deliveries()).length,0);
    });
    it('renders summary, trend and full detail from one snapshot and preserves saved analysis evidence',async()=>{
        queue();
        const range={begin:new Date(now),end:new Date(now+500)};
        const content=await sceneContent(store,{scene:'all'},range);
        const all=JSON.stringify(content);assert(all.includes(eventId));assert(all.includes('候选数 1'));assert(all.includes('完整明细 1'));
        const data={intent:'scene_event',answer:'固定结果',evidence:[{eventId,verdict:'证据不足'}]};
        const saved=await store.saveAnalysis('operator',data);await store.acknowledge(eventId,'operator');
        const record=(await store.analysisHistory(saved.analysisId))[0];assert.deepEqual(record.result,data);
        assert.equal((await store.analysisHistory())[0].intent,'scene_event');
    });
});
