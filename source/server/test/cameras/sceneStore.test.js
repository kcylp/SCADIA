'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SceneStore } = require('../../runtime/cameras/scene-store');
const id = 'a'.repeat(32);
const event = () => ({eventId:id,sceneId:'V1',kind:'doorentry',at:Date.now(),camera:'test-camera',trackId:'T1',shot:'scene-'+id+'.jpg',label:'门口进入',calibrationVersion:'test-v1'});

describe('Durable scene event ledger', () => {
    let dir, store;
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-scenes-'));
        fs.mkdirSync(path.join(dir,'scene-events')); fs.mkdirSync(path.join(dir,'images'));
        store = new SceneStore(dir,path.join(dir,'images')); await store.ready;
    });
    afterEach(async () => { await store.close(); fs.rmSync(dir,{recursive:true,force:true}); });
    const queue = (dir, value) => fs.writeFileSync(path.join(dir,'scene-events',value.eventId+'.json'),JSON.stringify(value));
    it('survives replay and reopening without duplicate entries', async () => {
        const e=event(); queue(dir,e); await store.ingest(); queue(dir,e);
        await Promise.all([store.ingest(),store.ingest()]);
        assert.equal((await store.list()).count,1);
        await store.close(); store=new SceneStore(dir,path.join(dir,'images'));
        assert.equal((await store.list()).count,1);
    });
    it('uses identical multi-scene filters for totals, trend, pages and complete exports', async () => {
        const at = Date.now()-10000;
        for(let i=0;i<135;i++) {
            const eventId=i.toString(16).padStart(32,'0'), sceneId=i%2?'V3':'T1';
            queue(dir,{...event(),eventId,sceneId,kind:i%2?'smoking':'thermal_anomaly',source:i%2?'visible':'thermal',at:at+i,shot:'scene-'+eventId+'.jpg'});
        }
        const q={scene:'all',from:at,to:at+134};
        const summary=await store.aggregate(q),page=await store.list({...q,limit:30}),out=await store.exportEvents(q);
        assert.equal(summary.count,135);assert.equal(page.count,135);assert.equal(page.rows.length,30);
        const pastEnd=await store.list({...q,offset:1000});assert.equal(pastEnd.count,135);assert.deepEqual(pastEnd.rows,[]);
        const none=await store.list({...q,from:at+200,to:at+300});assert.equal(none.count,0);assert.deepEqual(none.rows,[]);
        assert.equal(out.rows.length,135);assert.equal(new Set(out.rows.map(r=>r.eventId)).size,135);
        assert.equal(summary.trend.reduce((n,g)=>n+g.count,0),135);
        assert.equal(out.groups.reduce((n,g)=>n+g.count,0),135);
        assert.equal((await store.list({...q,source:'visible'})).count,67);
        assert.equal((await store.aggregate({...q,scene:'V3,T1',from:at+134})).count,1);
        await store.acknowledge('0'.repeat(32),'operator');
        assert.equal((await store.exportEvents({...q,acknowledged:true})).count,1);
        await assert.rejects(store.aggregate({...q,from:NaN}),/range/);
        await assert.rejects(store.list({...q,verdict:'completed'}),/verdict/);
    });
    it('rejects malformed pagination instead of silently using a default',async()=>{
        for(const q of [{limit:'abc'},{limit:-1},{limit:0},{limit:1.5},{offset:-1},{offset:'abc'},{offset:1.1}])
            await assert.rejects(store.list(q),/Invalid page/);
        assert.equal((await store.list({limit:1000})).limit,100);
    });
    it('reads filtered review, rows and page count before concurrent status changes',async()=>{
        queue(dir,event());await store.ingest();const original=store.all.bind(store);let selected=0;
        store.all=async(sql,args)=>{const result=await original(sql,args);if(sql.startsWith('WITH matched')){selected++;await store.run("UPDATE scene_reviews SET status='failed' WHERE eventId=?",[id]);}return result;};
        const page=await store.list({reviewStatus:'pending'});
        assert.equal(selected,1);assert.equal(page.count,1);assert.equal(page.rows[0].reviewStatus,'pending');
        assert.equal((await store.getEvent(id)).reviewStatus,'failed');
    });
    it('keeps ACK idempotent and tied to the precise event', async () => {
        queue(dir,event()); const a=await store.acknowledge(id,'operator-a');
        const b=await store.acknowledge(id,'operator-b');
        assert.equal(a.ackAt,b.ackAt); assert.equal(b.ackBy,'operator-a');
        await assert.rejects(store.acknowledge('b'.repeat(32),'x'),/not found/);
    });
    it('notifies status listeners only for a new event or first ACK, including the scene ACK path', async () => {
        let changes=0;store.onChange=()=>{changes++;};
        const e=event();queue(dir,e);await store.ingest();assert.equal(changes,1);
        queue(dir,e);await store.ingest();assert.equal(changes,1);
        await store.acknowledge(id,'operator-a');assert.equal(changes,2);
        await store.acknowledge(id,'operator-b');assert.equal(changes,2);
    });
    it('rejects a main shot belonging to another event even with valid registered frames', () => {
        assert.throws(()=>store.validate({...event(),shot:'scene-'+ 'b'.repeat(32)+'.jpg',evidenceFrames:[{file:'scene-'+id+'-0.jpg',at:Date.now()}]}),/Invalid scene/);
    });
    it('resets projections while retaining history and restart deduplication', async () => {
        const e=event();e.at-=1000;queue(dir,e);await store.ingest();
        fs.writeFileSync(path.join(dir,'images','ai-counts.json'),JSON.stringify({clearedAt:Date.now()}));
        let list=await store.list();assert.equal(list.count,1);assert.equal(list.stats.total,0);
        queue(dir,e);await store.ingest();list=await store.list();assert.equal(list.count,1);assert.equal(list.stats.total,0);
    });
    it('quarantines malformed events and rejects unknown scenes', async () => {
        queue(dir,{...event(),shot:'../../private'});await store.ingest();
        assert(fs.existsSync(path.join(dir,'scene-events',id+'.json.rejected')));
        assert.equal((await store.list()).count,0);
        await assert.rejects(store.list({scene:'anything'}),/Unknown scene/);
    });
    it('recovers tasks older than a day beyond 200 newer completed events', async () => {
        const e = event(); e.at -= 3 * 86400000; queue(dir, e); await store.ingest();
        for (let i = 0; i < 205; i++) {
            const later = { ...event(), eventId: i.toString(16).padStart(32, '0') };
            later.shot = 'scene-' + later.eventId + '.jpg'; queue(dir, later);
        }
        await store.ingest(); await store.ingest();
        const claimed = await store.claimReview(); assert.equal(claimed.event.eventId, id);
        await assert.rejects(store.finishReview(id, { lease: 'wrong', result: { reviewStatus: 'failed' } }), /lease/);
        await store.finishReview(id, { lease: claimed.lease, result: { reviewStatus: 'completed', verdict: '证据不足', text: '需要方向序列' } });
        await store.close(); store = new SceneStore(dir, path.join(dir, 'images')); await store.ready;
        const next = await store.claimReview(); assert.notEqual(next.event.eventId, id);
        const rows = (await store.list({ from: e.at - 1, to: e.at + 1 })).rows;
        assert.equal(rows[0].reviewStatus, 'completed'); assert.equal(rows[0].reviewHistory.length, 1);
    });
    it('claims concurrent tasks once and recovers an abandoned lease', async () => {
        queue(dir, event());
        const results = await Promise.all([store.claimReview(), store.claimReview()]);
        assert.equal(results.filter(Boolean).length, 1);
        const first = results.find(Boolean);
        await store.run('UPDATE scene_reviews SET leaseUntil=0 WHERE eventId=?', [id]);
        const recovered = await store.claimReview(); assert.notEqual(first.lease, recovered.lease);
        await assert.rejects(store.finishReview(id, { lease: first.lease, result: { reviewStatus: 'failed' } }), /lease/);
        await store.finishReview(id, { lease: recovered.lease, result: { reviewStatus: 'failed', errorCode: 'EVIDENCE_MISSING', retryable: false } });
        assert.equal(await store.claimReview(), null);
        assert.equal((await store.list()).rows[0].review.errorCode, 'EVIDENCE_MISSING');
    });
    it('persists typed review diagnostics across restart without accepting arbitrary nested fields', async () => {
        queue(dir,event());const claim=await store.claimReview();
        const result={reviewStatus:'completed',verdict:'证据不足',text:'缺少时序',reviewProtocol:2,
            observation:'unclear',peopleCount:null,input:{imageCount:1,imageGrid:[[1,40,50]],inputTokens:800},
            generation:{generatedTokens:96,finished:true,limit:null},generationMs:2200};
        for(const extra of [{peopleCount:true},{input:{password:'must-not-persist'}},{generation:{finished:'yes'}},
            {input:{imageGrid:[[1,NaN,50]]}},{reviewProtocol:3}]) {
            await assert.rejects(store.finishReview(id,{lease:claim.lease,result:{...result,...extra}}),/diagnostics/);
        }
        await store.finishReview(id,{lease:claim.lease,result});
        await store.close();store=new SceneStore(dir,path.join(dir,'images'));await store.ready;
        const saved=(await store.list()).rows[0].review;
        for(const key of ['reviewProtocol','observation','peopleCount','input','generation']){assert.deepEqual(saved[key],result[key]);}
    });
    it('exposes worker calibration failure codes through the sanitized status',()=>{
        fs.writeFileSync(path.join(dir,'images','ai-scenes.json'),JSON.stringify({calibrationError:'ValueError',source:{password:'private'}}));
        assert.equal(store.status().visible.calibrationError,'ValueError');
        assert(!JSON.stringify(store.status()).includes('private'));
    });
    it('validates event kinds against the scene and prevents cross-event evidence reads', () => {
        assert.throws(() => store.validate({ ...event(), sceneId: 'V2' }), /Invalid scene/);
        assert.equal(store.validate({ ...event(), sceneId: 'V2', kind: 'fall' }).kind, 'fall');
        assert.throws(() => store.validate({ ...event(), evidenceFrames: [{ file: 'scene-' + 'b'.repeat(32) + '.jpg', at: Date.now() }] }), /frames/);
    });
    it('does not emit source credentials through status', () => {
        fs.writeFileSync(path.join(dir,'images','ai-scenes.json'),JSON.stringify({camera:'c',source:{password:'private'},updatedAt:1,scenes:[]}));
        assert(!JSON.stringify(store.status()).includes('private'));
    });
});
