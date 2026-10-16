import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {login} from './ui-session.mjs';
const root=path.resolve(import.meta.dirname,'../..'),results=[];
const tab=await(await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0;const waiting=new Map(),issues=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}if(m.method==='Runtime.exceptionThrown')issues.push(m.params.exceptionDetails.text);};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),60000);waiting.set(id,m=>{clearTimeout(timer);m.error?reject(Error(m.error.message)):resolve(m.result);});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
const check=(name,pass,value)=>{results.push({name,pass,value});console.log(JSON.stringify(results.at(-1)));assert(pass,name);};
const api=async(url,body)=>ev(`(async()=>{const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(body===undefined?'GET':'POST')},headers:{'x-access-token':window.scadiaAccessToken,'Content-Type':'application/json'},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}signal:AbortSignal.timeout(30000)});let data={};try{data=await r.json()}catch(_){}return {status:r.status,data}})()`);
const wait=async expression=>{for(let i=0;i<60;i++){if(await ev(expression))return;await new Promise(r=>setTimeout(r,250));}throw Error('UI readiness timeout');};
try {
 await send('Page.enable');await send('Runtime.enable');await login({root,send,evaluate:ev});issues.length=0;
 const from=0,to=Date.now(),ids=['V1','V2','V3','V4','V5','V6','V7','T1'];let total=0,latest;
 for(const scene of [...ids,'all']) {
  const q=new URLSearchParams({scene,from:String(from),to:String(to),limit:'1'}),page=await api('/api/ai/scene-events?'+q),summary=await api('/api/ai/scene-events/summary?'+q),out=await api('/api/ai/scene-events/export?'+q);
  check('ledger-'+scene,[page,summary,out].every(r=>r.status===200)&&page.data.count===summary.data.count&&page.data.count===out.data.count&&out.data.rows.length===out.data.count&&out.data.rows.every(r=>scene==='all'||r.sceneId===scene),{page:page.data.count,summary:summary.data.count,exported:out.data.rows?.length});
  const context=await api('/api/analysis/context',{module:'video',intent:scene==='all'?'all_scenes':scene,from,to:to+1}),data=context.data.evidence?.[0]?.data;
  check('analysis-context-'+scene,context.status===200&&data?.count===out.data.count&&data.events.length<=30&&data.summary?.groups.reduce((n,g)=>n+g.count,0)===out.data.count,{status:context.data.status,count:data?.count,sample:data?.events.length});
  if(scene!=='all')total+=out.data.count;else{check('overview-total',out.data.count===total,{total});latest=out.data.rows[0];}
 }
 for(const query of ['scene=V9','from=abc','scene=T1&source=thermal&kind=smoking','limit=abc']){const r=await api('/api/ai/scene-events?'+query);check('invalid-query',r.status===400,{query,status:r.status});}
 const noAuth=await ev(`(async()=>{const view=await fetch('/api/ai/scene-events',{credentials:'omit'});const ack=await fetch('/api/ai/scene-events/invalid-id/ack',{method:'POST',credentials:'omit'});return {view:view.status,ack:ack.status}})()`);check('unauthenticated', [200,401].includes(noAuth.view)&&noAuth.ack===401,{...noAuth,meaning:'开放模式允许查看；写操作仍必须管理员认证'});
 if(latest){const manifest=await api('/api/ai/scene-events/'+latest.eventId+'/evidence-manifest');check('manifest-identity',manifest.status===200&&manifest.data.eventId===latest.eventId,{status:manifest.status,frames:manifest.data.frames?.length});}
 const body={module:'video',intent:'all_scenes',from,to:to+1,question:'请基于本次固定时间窗的八场景证据，按事件ID概述候选、复核结论及证据不足，明确区分当前健康状态与历史事件，不推断未提供的测温或业务事实。'};
 const chat=await api('/api/analysis/chat',body);
 check('deepseek-request',chat.status===200&&chat.data.status==='ok'&&!!chat.data.analysisId,{status:chat.data.status,saved:!!chat.data.analysisId,model:chat.data.model});
 const history=await api('/api/analysis/history/'+chat.data.analysisId),saved=history.data.rows?.[0]?.result;
 check('history-roundtrip',history.status===200&&saved?.answer===chat.data.answer&&JSON.stringify(saved?.evidence)===JSON.stringify(chat.data.evidence)&&saved?.window.from===from&&saved?.window.to===to+1,{status:history.status,originalEvidence:!!saved});
 await send('Page.navigate',{url:'http://127.0.0.1:1881/analysis?module=video&intent=all_scenes&from='+from+'&to='+(to+1)});
 await wait(`!!document.querySelector('app-analysis-workspace iframe')`);
 await wait(`(()=>{const d=document.querySelector('app-analysis-workspace iframe').contentDocument;return d?.getElementById('history-refresh')&&!d.getElementById('analysis-history').hidden})()`);
 await ev(`document.querySelector('iframe').contentDocument.getElementById('history-refresh').click()`);
 await wait(`document.querySelector('iframe').contentDocument.querySelectorAll('#history-rows button').length>0`);
 await ev(`document.querySelector('iframe').contentDocument.querySelector('#history-rows button').click()`);
 await wait(`!document.querySelector('iframe').contentDocument.getElementById('history-export').hidden`);
 check('history-page',await ev(`document.querySelector('iframe').contentDocument.getElementById('history-answer').textContent.includes('固定窗口')`),{loaded:true});
 for(const [width,height] of [[1280,745],[1920,1080],[390,844]]){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});
  await send('Page.navigate',{url:'http://127.0.0.1:1881/scene-records?scene=all&from='+from+'&to='+to});await wait(`!!document.querySelector('app-scene-board .table-wrap table')`);
  const state=await ev(`({overflow:document.documentElement.scrollWidth>innerWidth+2,rows:document.querySelectorAll('app-scene-board .table-wrap table tbody tr').length,summary:!!document.querySelector('.summary')})`);
  check('ledger-layout-'+width,!state.overflow&&state.rows>0,state);
 }
 check('uncaught-errors',issues.length===0,issues);
} finally {
 fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts','scenes-consumers-regression.json'),JSON.stringify(results,null,2));
 ws.close();await fetch('http://127.0.0.1:9222/json/close/'+tab.id);
}
