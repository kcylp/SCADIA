'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, MODULES } = require('../../api/analysis/evidence');
const { SceneStore } = require('../../runtime/cameras/scene-store');
const { SCENE_TARGETS } = require('../../api/analysis/scene-evidence');

describe('Unified analysis scene evidence boundary', () => {
    let dir, store, runtime, now;
    const kinds = ['doorentry', 'fall', 'smoking', 'helmet', 'crowding', 'loitering', 'fire', 'thermal_anomaly'];
    const id = i => (i + 1).toString(16).padStart(32, '0');
    const read = scene => collect(runtime, {}, {module:'video', intent:scene, from:now-10000, to:now}, -1);
    const snapshot = () => ({
        visible: {camera:'visible-camera',streamKind:'visible',updatedAt:now-1,appliedCalibrationVersion:'gate-v1',
            entryGate:{enabled:true,verified:true,calibrationVersion:'gate-v1'},scenes:SCENE_TARGETS.slice(0,7).map(s=>({sceneId:s.id,status:'ready',detail:s.name}))},
        thermal: {camera:'thermal-camera',streamKind:'thermal',updatedAt:now-1,scenes:[{sceneId:'T1',status:'ready'}]},
        reviews:{byScene:{V3:{sceneId:'V3',camera:'visible-camera',source:'visible',reviewStatus:'completed',verdict:'证据不足',text:'巡视',frameAt:now-1}}}
    });
    beforeEach(async () => {
        now = Date.now();dir = fs.mkdtempSync(path.join(os.tmpdir(),'scadia-scene-analysis-'));
        fs.mkdirSync(path.join(dir,'scene-events'));fs.mkdirSync(path.join(dir,'images'));
        store = new SceneStore(dir,path.join(dir,'images'));await store.ready;
        store.status = snapshot;
        runtime = {settings:{secureEnabled:true},cameraScenes:store};
        SCENE_TARGETS.forEach((s,i) => fs.writeFileSync(path.join(dir,'scene-events',id(i)+'.json'),JSON.stringify({
            eventId:id(i),sceneId:s.id,source:s.source,kind:kinds[i],at:now-100,camera:s.source+'-camera',trackId:'track-'+s.id,
            shot:'scene-'+id(i)+'.jpg',label:s.name,calibrationVersion:'gate-v1',context:{model:{privateField:'excluded'}}
        })));
        await store.ingest();
    });
    afterEach(async () => {await store.close();fs.rmSync(dir,{recursive:true,force:true});});
    it('maps all eight targets to their own durable events and camera source',async () => {
        assert.deepEqual(MODULES.find(m=>m.id==='video').intents.filter(i=>i.requirement==='scene').map(i=>i.id),SCENE_TARGETS.map(s=>s.id));
        for (const s of SCENE_TARGETS) {
            const ctx=await read(s.id),d=ctx.evidence[0].data;
            assert.equal(ctx.status,'ready',s.id+JSON.stringify(ctx.evidenceQuality));
            assert.equal(d.target.source,s.source);assert.equal(d.count,1);assert.equal(d.events.length,1);
            assert.equal(d.events[0].sceneId,s.id);assert.equal(d.events[0].camera,s.source+'-camera');
            assert(!JSON.stringify(ctx).includes('privateField'));assert(!JSON.stringify(ctx).includes('"shot":'));assert(!JSON.stringify(ctx).includes('"shotFile":'));
        }
    });
    it('projects a persisted event review independently from patrols and ACK',async () => {
        const claim=await store.claimReview();
        await store.finishReview(claim.event.eventId,{lease:claim.lease,result:{reviewStatus:'completed',verdict:'证据不足',text:'需连续过门证据',limitations:'不作确认'}});
        await store.acknowledge(claim.event.eventId,'operator');
        const d=(await read('V1')).evidence[0].data;
        assert.equal(d.events[0].reviewStatus,'completed');assert.equal(d.events[0].review.verdict,'证据不足');
        assert.equal(d.events[0].ackBy,'operator');assert(d.events[0].ackAt);assert.equal(d.patrol,null);
        assert.equal((await read('V3')).evidence[0].data.patrol.text,'巡视');
    });
    it('does not expose global scene data to an ordinary user',async () => {
        runtime.cameraScenes={status(){throw new Error('must not read');}};
        const ctx=await collect(runtime,{}, {module:'video',intent:'V4',from:now-10000,to:now},1);
        assert.equal(ctx.status,'evidence_insufficient');assert.equal(ctx.evidence[0].data.events.length,0);
        assert(ctx.evidenceQuality.missing.some(x=>x.code==='video_permission'));
    });
    it('rejects mismatched source data and does not include unrelated patrols',async () => {
        const state=snapshot();state.thermal.camera='visible-camera';state.thermal.streamKind='visible';
        state.reviews.byScene.T1={...state.reviews.byScene.V3};store.status=()=>state;
        const ctx=await read('T1');assert.equal(ctx.status,'ready');assert.equal(ctx.evidence[0].data.events.length,1);
        assert.equal(ctx.evidence[0].data.patrol,null);assert(ctx.evidence[0].data.health.some(x=>x.code==='scene_stale'));
        const original=store.exportEvents.bind(store);store.exportEvents=async q=>{const ledger=await original(q);ledger.rows[0].source='visible';return ledger;};
        assert((await read('T1')).evidenceQuality.missing.some(x=>x.code==='scene_source_mismatch'));
    });
    it('reports current V1 calibration health without invalidating historical evidence',async () => {
        for(const patch of [{entryGate:{enabled:true,verified:false}},{appliedCalibrationVersion:'old'},{calibrationError:'ValueError'}]){
            store.status=()=>{const s=snapshot();Object.assign(s.visible,patch);return s;};
            const ctx=await read('V1');assert(ctx.evidence[0].data.health.some(x=>x.code==='door_calibration_required'));
            assert.equal(ctx.evidence[0].data.events.length,1);
        }
    });
    it('reports missing, stale and failed reads without converting them to normal',async () => {
        store.status=()=>{const s=snapshot();s.visible.updatedAt=now-9000;return s;};
        assert((await read('V2')).evidence[0].data.health.some(x=>x.code==='scene_stale'));
        store.status=()=>{throw new Error('file parse');};
        const ctx=await read('V2');assert.equal(ctx.status,'ready');assert(ctx.evidence[0].data.health.some(x=>x.code==='scene_status_failed'));
        runtime.cameraScenes=null;
        assert((await read('V2')).evidenceQuality.missing.some(x=>x.code==='scene_unavailable'));
    });
    it('keeps original camera identities after a source replacement',async()=>{
        store.status=()=>{const s=snapshot();s.visible.camera='replacement-camera';return s;};
        const d=(await read('V3')).evidence[0].data;assert.equal(d.count,1);assert.equal(d.events[0].camera,'visible-camera');
    });
    it('excludes the end boundary and treats patrol-only as no event evidence',async () => {
        const ctx=await collect(runtime,{}, {module:'video',intent:'V3',from:now-99,to:now},-1);
        assert(ctx.evidenceQuality.missing.some(x=>x.code==='scene_events_missing'));
        assert(ctx.evidence[0].data.patrol);assert.equal(ctx.evidence[0].data.events.length,0);
        const end=await collect(runtime,{}, {module:'video',intent:'V3',from:now-10000,to:now-100},-1);
        assert.equal(end.evidence[0].data.count,0);
    });
    it('anchors comprehensive evidence and every summary to one immutable ledger snapshot',async()=>{
        const original=store.exportEvents.bind(store);let reads=0;
        store.exportEvents=async q=>{reads++;const data=await original(q);await store.acknowledge(id(0),'operator');return data;};
        const ctx=await collect(runtime,{}, {module:'video',intent:'all_scenes',from:now-10000,to:now},-1);
        const d=ctx.evidence[0].data;
        assert.equal(ctx.status,'ready');assert.equal(reads,1);assert.equal(d.count,8);
        assert.equal(d.summary.groups.reduce((n,g)=>n+g.count,0),8);
        assert.equal(d.summary.trend.reduce((n,g)=>n+g.count,0),8);
        assert.equal(d.events.find(r=>r.sceneId==='V1').ackAt,null);
        assert.equal(d.summary.groups.find(g=>g.sceneId==='V1').acknowledged,0);
        assert(d.snapshotAt);assert((await store.getEvent(id(0))).ackAt);
    });
    it('uses event identity and historical report windows without admitting unrelated scenes',async()=>{
        const body={module:'video',intent:'scene_event',sceneId:'V3',eventId:id(2),from:0,to:now};
        const ctx=await collect(runtime,{},body,-1);assert.equal(ctx.status,'ready');
        assert.equal(ctx.evidence[0].data.count,1);assert.equal(ctx.filters.eventId,id(2));
        const wrong=await collect(runtime,{}, {...body,sceneId:'T1'},-1);
        assert.equal(wrong.status,'evidence_insufficient');assert.equal(wrong.evidence[0].data.count,0);
        const overview=await collect(runtime,{}, {module:'video',intent:'all_scenes',sceneIds:['V3','T1'],from:0,to:now},-1);
        assert.equal(overview.evidence[0].data.count,2);
    });
    it('retains total count while limiting the model to the most recent 30 rows',async () => {
        for(let i=8;i<40;i++){
            const e={eventId:id(i),sceneId:'V3',kind:'smoking',at:now-1000-i,camera:'visible-camera',trackId:'T'+i,
                shot:'scene-'+id(i)+'.jpg',label:'抽烟候选',calibrationVersion:'rules-v1'};
            fs.writeFileSync(path.join(dir,'scene-events',e.eventId+'.json'),JSON.stringify(e));
        }
        const d=(await read('V3')).evidence[0].data;assert.equal(d.count,33);assert.equal(d.events.length,30);
        const page=await store.list({scene:'V3',from:now-10000,to:now,offset:30,limit:30});assert.equal(page.rows.length,3);
    });
});
