'use strict';
const { createHash } = require('crypto');
const { IDS, validateSubscription } = require('../../scene-subscription');
async function deliverScenes(store, subscriptions, send, now=Date.now()) {
    await store.ingest();
    for (const sub of subscriptions.filter(s=>s.type==='scenes')) {
        try { validateSubscription(sub); } catch (_) { continue; }
        const ids = sub.sceneIds || IDS, phases = sub.scenePhases || ['candidate'], kinds=sub.sceneKinds||[];
        const fingerprint=createHash('sha256').update(JSON.stringify([!!sub.enabled,[...ids].sort(),[...phases].sort(),[...kinds].sort(),sub.receiver||''])).digest('hex');
        const configKey='notify-config:'+sub.id,startKey='notify-start:'+sub.id;
        const previous=await store.all('SELECT value FROM meta WHERE key=?',[configKey]);
        if (previous.length && previous[0].value!==fingerprint) {
            // Edits/re-enabling start a new subscription window; queued old scope is never sent.
            await store.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[startKey,String(now)]);
            await store.run("DELETE FROM scene_deliveries WHERE subscription=? AND status<>'sent'",[sub.id]);
        }
        await store.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',[configKey,fingerprint]);
        if (!sub.enabled) continue;
        const marks=ids.map(()=>'?').join(','), kindSql=kinds.length?' AND e.kind IN ('+kinds.map(()=>'?').join(',')+')':'';
        await store.run('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)',[startKey,String(now)]);
        const started=Number((await store.all('SELECT value FROM meta WHERE key=?',[startKey]))[0].value);
        for (const phase of phases) {
            const terminal=phase==='review'?" AND r.status IN ('completed','failed','timeout','unavailable')":'';
            const rows=await store.all('SELECT e.id FROM events e LEFT JOIN scene_reviews r ON r.eventId=e.id WHERE e.at>=? AND e.at<=? AND e.scene IN ('+marks+')'+kindSql+terminal+
                ' AND NOT EXISTS (SELECT 1 FROM scene_deliveries d WHERE d.subscription=? AND d.eventId=e.id AND d.phase=?) ORDER BY e.at,e.id LIMIT 200',[started,now,...ids,...kinds,sub.id,phase]);
            for (const row of rows) await store.run('INSERT OR IGNORE INTO scene_deliveries(subscription,eventId,phase,updatedAt) VALUES(?,?,?,?)',[sub.id,row.id,phase,now]);
        }
        const pending=await store.all("SELECT * FROM scene_deliveries WHERE subscription=? AND status<>'sent' AND attempts<3 AND nextAt<=? ORDER BY updatedAt,eventId,phase LIMIT 50",[sub.id,now]);
        for (const job of pending) {
            const changed=await store.run("UPDATE scene_deliveries SET status='sending',attempts=attempts+1,nextAt=?,updatedAt=? WHERE subscription=? AND eventId=? AND phase=? AND status<>'sent' AND attempts<3 AND nextAt<=?",[now+300000,now,sub.id,job.eventId,job.phase,now]);
            if (!changed) continue;
            try {
                const event=await store.getEvent(job.eventId);
                if (!ids.includes(event.sceneId) || (kinds.length&&!kinds.includes(event.kind)) || !phases.includes(job.phase)) throw new Error('scope_changed');
                const summary=job.phase==='candidate'?'候选事件，等待事件复核':event.reviewStatus+' · '+(event.review?.verdict||'无结论')+' · '+(event.review?.limitations||event.review?.errorCode||'');
                await send(sub,event.sceneId+' · '+event.label+'\n'+summary+'\n'+event.source+' / '+event.camera+'\n'+new Date(event.at).toISOString()+'\neventId: '+event.eventId+'\n阶段: '+job.phase+'\n证据：/api/ai/scene-events/'+event.eventId+'/evidence');
                await store.run("UPDATE scene_deliveries SET status='sent',updatedAt=?,error=NULL WHERE subscription=? AND eventId=? AND phase=?",[now,sub.id,job.eventId,job.phase]);
            } catch (_) {
                await store.run("UPDATE scene_deliveries SET status='failed',updatedAt=?,nextAt=?,error='transport_failed' WHERE subscription=? AND eventId=? AND phase=?",[now,now+60000*Math.pow(2,job.attempts),sub.id,job.eventId,job.phase]);
            }
        }
    }
}
module.exports={deliverScenes,validateSubscription};
