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
    it('keeps ACK idempotent and tied to the precise event', async () => {
        queue(dir,event()); const a=await store.acknowledge(id,'operator-a');
        const b=await store.acknowledge(id,'operator-b');
        assert.equal(a.ackAt,b.ackAt); assert.equal(b.ackBy,'operator-a');
        await assert.rejects(store.acknowledge('b'.repeat(32),'x'),/not found/);
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
