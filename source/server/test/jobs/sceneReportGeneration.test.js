'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const createReport=require('../../runtime/jobs/report').create;
const {SceneStore}=require('../../runtime/cameras/scene-store');
const contract=require('../../runtime/reporting/contract');
describe('Scene report production PDF boundary',function(){
    this.timeout(30000);
    let dir,store,runtime,property;
    const ref=new Date(2026,9,16,11),eventId='e'.repeat(32);
    beforeEach(async()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'scadia-pdf-'));fs.mkdirSync(path.join(dir,'scene-events'));fs.mkdirSync(path.join(dir,'images'));
        store=new SceneStore(dir,path.join(dir,'images'));await store.ready;
        fs.writeFileSync(path.join(dir,'scene-events',eventId+'.json'),JSON.stringify({eventId,sceneId:'T1',source:'thermal',kind:'thermal_anomaly',at:new Date(2026,9,15,12).getTime(),camera:'thermal-local',trackId:'T1',shot:'scene-'+eventId+'.jpg',label:'红外热源候选',calibrationVersion:'rule-test'}));
        property={name:'scene-test',language:'zh-cn',scheduling:0,docproperty:{pageSize:'A4'},content:{items:[{type:contract.REPORT_ITEM_TYPE.alarms,range:contract.REPORT_DATE_RANGE.day,size:9,sceneFilter:{scene:'all'}}]}};
        runtime={cameraScenes:store,settings:{reportsDir:dir},logger:{info(){},warn(){},error(){}},project:{getReportingSettings:()=>({})}};
    });
    afterEach(async()=>{await store.close();fs.rmSync(dir,{recursive:true,force:true});});
    it('builds a real PDF from the exact previous production window and one full ledger snapshot',async()=>{
        let query,reads=0;const original=store.exportEvents.bind(store);
        store.exportEvents=async q=>{reads++;query=q;const data=await original(q);assert.equal(data.count,1);assert.equal(data.rows[0].eventId,eventId);return data;};
        const report=createReport(property,runtime),file=await report.execute(ref,true);
        assert.equal(reads,1);assert.equal(query.from,new Date(2026,9,15,8).getTime());assert.equal(query.to,new Date(2026,9,16,8).getTime()-1);
        const binary=fs.readFileSync(file);assert.equal(binary.subarray(0,5).toString(),'%PDF-');assert(binary.length>2000);
    });
    it('fails promptly for unavailable ledgers and filesystem errors instead of reporting success',async()=>{
        runtime.cameraScenes=null;await assert.rejects(createReport(property,runtime).execute(ref,true),/账本未就绪/);
        runtime.cameraScenes=store;runtime.settings.reportsDir=path.join(dir,'missing');
        await assert.rejects(createReport(property,runtime).execute(ref,true),/ENOENT/);
    });
    it('awaits the scheduled mail transport and reports its failure',async()=>{
        property.receiver='test@example.invalid';let called=0;
        runtime.notificatorMgr={sendMailMessage:async()=>{called++;throw Error('test transport failed');}};
        await assert.rejects(createReport(property,runtime).execute(ref,true),/test transport failed/);assert.equal(called,1);
    });
    it('passes an arbitrary multi-scene subset through to one ledger snapshot without widening it',async()=>{
        property.content.items[0].sceneFilter={scene:'V1,T1'};
        let query;const original=store.exportEvents.bind(store);
        store.exportEvents=async q=>{query=q;return await original(q);};
        const report=createReport(property,runtime),file=await report.execute(ref,true);
        assert.equal(query.scene,'V1,T1');
        const binary=fs.readFileSync(file);assert.equal(binary.subarray(0,5).toString(),'%PDF-');
    });
    it('an unmatched subset is an honest empty report, not a widened one',async()=>{
        property.content.items[0].sceneFilter={scene:'V3,V7'};
        let data;const original=store.exportEvents.bind(store);
        store.exportEvents=async q=>{data=await original(q);return data;};
        const report=createReport(property,runtime),file=await report.execute(ref,true);
        assert.equal(data.scenes.join(','),'V3,V7');
        assert.equal(data.count,0);
        const binary=fs.readFileSync(file);assert.equal(binary.subarray(0,5).toString(),'%PDF-');
    });
    it('rejects empty or unknown scene selections instead of guessing',async()=>{
        property.content.items[0].sceneFilter={scene:''};
        await assert.rejects(createReport(property,runtime).execute(ref,true),/Unknown scene/);
        property.content.items[0].sceneFilter={scene:'V1,V9'};
        await assert.rejects(createReport(property,runtime).execute(ref,true),/Unknown scene/);
    });
});
