'use strict';
const path=require('path'), os=require('os'), fs=require('fs');
const SERVER=path.join(__dirname,'..'); process.chdir(SERVER);
const workDir=fs.mkdtempSync(path.join(os.tmpdir(),'p0dbg4-'));
const log=[];
const logger={info:(m)=>log.push('i: '+m),warn:(m)=>log.push('w: '+m),error:(m)=>log.push('E: '+m),debug:()=>{}};
let src=fs.readFileSync(path.join(SERVER,'runtime','notificator','index.js'),'utf8');
const ins=(anchor,text)=>{ if(src.indexOf(anchor)===-1) throw new Error('anchor missing'); src=src.replace(anchor, anchor+'\n'+text); };
ins('var _loadProperty = function () {', "        logger.info('DBG._loadProperty');");
ins('var _loadNotifications = function () {', "        logger.info('DBG._loadNotifications');");
ins("        } else if (status === NotifyStatusEnum.IDLE) {", "        logger.info('DBG.status=' + status);");
src = src.replace(/reject\(err\);/g, "logger.info('DBG.REJECT: ' + (err && err.stack ? err.stack : err)); reject(err);");
const p=path.join(SERVER,'runtime','notificator','__dbg4.js');
fs.writeFileSync(p, src);
const notificator=require(p);
const events=(()=>{const L={};return {on:(n,h)=>{(L[n]=L[n]||[]).push(h);},emit:async(n,d)=>{for(const h of (L[n]||[]))await h(d);}};})();
const configs=[{id:'n1',name:'x',type:'alarm',enabled:true,receiver:'http://127.0.0.1:1/x',delay:0,interval:0,text:'',subscriptions:{alarm:true},options:null,mode:0}];
const runtime={logger,settings:{workDir},events,
  project:{getNotifications:()=>Promise.resolve(JSON.parse(JSON.stringify(configs)))},
  alarms:{values:[{name:'t',type:'high',status:'N',ontime:Date.now()}],string:'S'},
  notificatorMgr:{postMessage:()=>Promise.resolve('ok'),sendMail:()=>Promise.reject(new Error('no smtp'))}};
runtime.alarmsMgr={getAlarmsValues:()=>runtime.alarms.values,getAlarmsString:()=>runtime.alarms.string};
(async()=>{
  const m=notificator.create(runtime);
  await m.start();
  for (let i=0;i<4;i++){ m.forceCheck(); await new Promise(r=>setTimeout(r,900)); console.log('--- pass '+i+' ---'); log.forEach(l=>console.log('   '+l)); log.length=0; }
  await m.stop();
  fs.unlinkSync(p); try{fs.rmSync(workDir,{recursive:true,force:true});}catch(e){}
})();
