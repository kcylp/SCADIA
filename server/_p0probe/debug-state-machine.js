'use strict';
const path=require('path'), os=require('os'), fs=require('fs');
const SERVER=path.join(__dirname,'..'); process.chdir(SERVER);
const storage=require(path.join(SERVER,'runtime','storage','databases'));
const workDir=fs.mkdtempSync(path.join(os.tmpdir(),'p0dbg-'));
const log=[];
const logger={info:(m)=>log.push('info: '+m),warn:(m)=>log.push('warn: '+m),error:(m)=>log.push('error: '+m),debug:()=>{}};
const buf=fs.readFileSync(path.join(SERVER,'runtime','notificator','index.js'),'utf8');
const MARK='var _loadProperty = function () {';
console.log('marker found:', buf.indexOf(MARK)!==-1);
const instrumented = buf.replace(MARK,
  "var _loadProperty = function () {\n        logger.info('DBG._loadProperty entered');");
const p=path.join(SERVER,'runtime','notificator','__dbg.js');
fs.writeFileSync(p, instrumented);
const notificator=require(p);
const events=(()=>{const L={};return {on:(n,h)=>{(L[n]=L[n]||[]).push(h);},emit:async(n,d)=>{for(const h of (L[n]||[]))await h(d);}};})();
const configs=[{id:'n1',name:'x',type:'alarm',enabled:true,receiver:'http://127.0.0.1:1/x',delay:0,interval:0,text:'',subscriptions:{alarm:true},options:null,mode:0}];
const runtime={logger,settings:{workDir},events,
  project:{getNotifications:()=>{logger.info('DBG.project.getNotifications called');return Promise.resolve(JSON.parse(JSON.stringify(configs)));}},
  alarms:{values:[{name:'t',type:'high',status:'N',ontime:Date.now()}],string:'S'},
  notificatorMgr:{postMessage:()=>Promise.resolve('ok'),sendMail:()=>Promise.reject(new Error('no smtp'))}};
runtime.alarmsMgr={getAlarmsValues:()=>runtime.alarms.values,getAlarmsString:()=>runtime.alarms.string};
(async()=>{
  const m=notificator.create(runtime);
  await m.start();
  for (let i=0;i<4;i++){ m.forceCheck(); await new Promise(r=>setTimeout(r,900)); console.log('--- pass '+i+' ---'); log.forEach(l=>console.log('   '+l)); log.length=0; }
  await m.stop();
  const sqlite3=require(path.join(SERVER,'node_modules','sqlite3')).verbose();
  const f=storage.resolveDbFile(workDir,'notifications',null);
  await new Promise((res,rej)=>{const d=new sqlite3.Database(f);d.all('SELECT * FROM notifications;',[],(e,r)=>{d.close();e?rej(e):(console.log('ROWS',JSON.stringify(r)),res());});});
  fs.unlinkSync(p); try{fs.rmSync(workDir,{recursive:true,force:true});}catch(e){}
})();
