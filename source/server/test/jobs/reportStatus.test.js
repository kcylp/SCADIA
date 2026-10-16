'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const jobsManager=require('../../runtime/jobs/index').create;
const {SceneStore}=require('../../runtime/cameras/scene-store');
const contract=require('../../runtime/reporting/contract');

describe('Report build status tracking (accepted vs really done)',function(){
    this.timeout(90000);
    let dir,store,runtime,mgr,property,other;
    const eventId='f'.repeat(32);
    const makeProperty=(id,name)=>({id,name,language:'zh-cn',scheduling:'week',
        docproperty:{pageSize:'A4'},content:{items:[{type:contract.REPORT_ITEM_TYPE.alarms,range:contract.REPORT_DATE_RANGE.day,size:9,sceneFilter:{scene:'all'}}]}});
    function writeEvent(at){
        fs.writeFileSync(path.join(dir,'scene-events',eventId+'.json'),JSON.stringify({eventId,sceneId:'T1',source:'thermal',kind:'thermal_anomaly',at,camera:'thermal-local',trackId:'T1',shot:'scene-'+eventId+'.jpg',label:'红外热源候选',calibrationVersion:'rule-test'}));
    }
    beforeEach(async()=>{
        dir=fs.mkdtempSync(path.join(os.tmpdir(),'scadia-jobs-'));fs.mkdirSync(path.join(dir,'scene-events'));fs.mkdirSync(path.join(dir,'images'));
        store=new SceneStore(dir,path.join(dir,'images'));await store.ready;
        writeEvent(Date.now());
        // 用同一个对象引用：测试中途修改 receiver/scheduling 必须影响重载后的任务列表。
        property=makeProperty('report-status-1','status-test');
        other=makeProperty('report-status-2','other-test');
        runtime={cameraScenes:store,settings:{reportsDir:dir},logger:{info(){},warn(){},error(){}},
            project:{getReportingSettings:()=>({}),getReports:async()=>[property,other]},
            daqStorage:{checkRetention:async()=>{}},alarmsMgr:{checkRetention:async()=>{}}};
        mgr=jobsManager(runtime);
    });
    afterEach(async()=>{await mgr.stop();await store.close();fs.rmSync(dir,{recursive:true,force:true});});
    async function waitFor(id,state){
        const deadline=Date.now()+40000;
        while(Date.now()<deadline && mgr.getReportStatus(id).state!==state){await new Promise(r=>setTimeout(r,500));}
        return mgr.getReportStatus(id);
    }
    // start() 的 Promise 从不 resolve（生产里也是不等待地调用）。
    // 状态机 5s 一拍：INIT→LOAD→IDLE 至多两拍，再加异步加载，12s 足够进入稳态。
    async function startAndWaitLoaded(){
        mgr.start();
        await new Promise(r=>setTimeout(r,12000));
        assert.equal(mgr.forceReport({id:'__probe_not_exist__'}),false,'jobs should be loaded (steady state) by now');
    }
    it('tracks accepted -> running -> completed with a readable PDF for this run',async()=>{
        await startAndWaitLoaded();
        assert.equal(mgr.forceReport(property),true);
        assert.equal(mgr.getReportStatus(property.id).state,'running');
        const status=await waitFor(property.id,'completed');
        assert.equal(status.state,'completed');
        assert.ok(status.at>0);
        // 终态必须对应本次实际产物：文件存在、可读、是 PDF。
        assert.ok(status.file && status.file.startsWith(dir),'status.file inside reportsDir: '+status.file);
        const buf=fs.readFileSync(status.file);
        assert.equal(buf.slice(0,5).toString(),'%PDF-');
        assert.ok(buf.length>1000);
    });
    it('a forced request accepted just before a config reload still generates after the reload',async()=>{
        // 复现旧缺陷的关键序列：任务已加载 -> 强制请求被接受 -> reset 触发重载。
        // 旧实现把 force 挂在旧 Job 上，重载后被丢弃，且调度轮空被写成 completed（无文件）。
        await startAndWaitLoaded();
        assert.equal(mgr.forceReport(property),true);
        assert.equal(mgr.getReportStatus(property.id).state,'running');
        mgr.reset();                    // 模拟 set-report/del-report 触发的配置重载
        const status=await waitFor(property.id,'completed');
        assert.equal(status.state,'completed');
        assert.ok(status.file && fs.existsSync(status.file),'reload must not lose the accepted request');
        assert.equal(fs.readFileSync(status.file).slice(0,5).toString(),'%PDF-');
    });
    it('a forced request for a report that never loads fails explicitly instead of hanging or faking success',async()=>{
        await startAndWaitLoaded();
        property.scheduling='none';      // none 不会被加载进任务列表
        mgr.reset();                     // 进入重载窗口
        assert.equal(mgr.forceReport(property),true);   // 重载窗口内先接受（保存后立即生成的真实路径）
        assert.equal(mgr.getReportStatus(property.id).state,'running');
        const status=await waitFor(property.id,'failed');
        assert.equal(status.state,'failed');
        assert.match(status.error,/报表未加载/);
        assert.equal(status.file,undefined);
    });
    it('unforced schedule runs never rewrite request status and stale callbacks cannot clobber newer requests',async()=>{
        await startAndWaitLoaded();
        // 第一轮：report-1 正常完成。
        assert.equal(mgr.forceReport(property),true);
        const first=await waitFor(property.id,'completed');
        assert.ok(first.file);
        // 第二轮（新请求，代号递增；旧回调若晚到，代号不匹配不得串改）。
        assert.equal(mgr.forceReport(property),true);
        const second=await waitFor(property.id,'completed');
        assert.ok(second.at>=first.at);
        assert.ok(second.file && fs.existsSync(second.file));
        // 触发一次整列表调度轮：强制 report-2 会带动 _checkJobs 执行 report-1 的非强制轮
        // （week 调度非周一为轮空 resolve(true)；周一则真实生成——两种情况下都不得改写 report-1 的终态）。
        assert.equal(mgr.forceReport(other),true);
        await waitFor(other.id,'completed');
        await new Promise(r=>setTimeout(r,2000));
        const preserved=mgr.getReportStatus(property.id);
        assert.equal(preserved.state,'completed');
        assert.equal(preserved.file,second.file);
        assert.equal(preserved.at,second.at);
    });
    it('tracks async failures so the page can show them instead of staying "successful"',async()=>{
        property.receiver='test@example.invalid';
        runtime.notificatorMgr={sendMailMessage:async()=>{throw Error('transport broken');}};
        await startAndWaitLoaded();
        assert.equal(mgr.forceReport(property),true);
        const status=await waitFor(property.id,'failed');
        assert.equal(status.state,'failed');
        assert.match(status.error,/transport broken/);
        assert.equal(status.file,undefined);
    });
    it('keeps the last known status for unknown ids and does not invent one',async()=>{
        assert.deepEqual(mgr.getReportStatus('missing'),{state:'unknown'});
    });
});
