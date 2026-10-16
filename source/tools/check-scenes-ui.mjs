import fs from 'node:fs';
import path from 'node:path';
import { login } from './ui-session.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const tab=await(await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const waits=new Map(),issues=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&waits.has(m.id)){waits.get(m.id)(m);waits.delete(m.id);}if(m.method==='Runtime.exceptionThrown'){issues.push(m.params.exceptionDetails.text);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>reject(new Error('CDP '+method+' timed out')),20000);waits.set(n,m=>{clearTimeout(timer);m.error?reject(new Error(m.error.message)):resolve(m.result);});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails){throw new Error(r.exceptionDetails.text);}return r.result.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const results=[];
try{
 await send('Page.enable');await send('Runtime.enable');
 await login({root,send,evaluate:ev});
 issues.length=0;
 for(const size of [{width:1280,height:745},{width:1920,height:1080},{width:390,height:844}]){
  await send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});
  for(const route of ['/home/v_zc_g1','/people']){
   await send('Page.navigate',{url:'http://127.0.0.1:1881'+route});await sleep(5000);
   const row=await ev(`(()=>{const r=e=>e.getBoundingClientRect().toJSON(),cards=[...document.querySelectorAll('.scenes article')];return {route:location.pathname,heading:document.querySelector('h1')?.textContent,cards:cards.map(e=>({rect:r(e),canvas:r(e.querySelector('canvas')),offline:!!e.querySelector('.offline'),review:e.querySelector('.review').textContent})),overflow:document.documentElement.scrollWidth>innerWidth+1,errors:[...document.querySelectorAll('.error')].map(e=>e.textContent),stats:document.querySelector('.summary')?.textContent,body:document.body.innerText.slice(0,500)}})()`);
   row.size=size;row.pass=!row.overflow&&!row.errors.length&&(!route.includes('g1')||row.cards.length===8&&row.cards.every(c=>c.canvas.width>0&&c.canvas.height>=80)&&(size.width<1000||row.cards.every(c=>c.rect.bottom<=size.height+1)));
   const shot=await send('Page.captureScreenshot',{format:'png'});row.screenshot='scene-'+size.width+'-'+route.split('/').pop()+'.png';fs.writeFileSync(path.join(root,'project/_logs',row.screenshot),Buffer.from(shot.data,'base64'));
   results.push(row);console.log(JSON.stringify({size,route:row.route,pass:row.pass,cards:row.cards.length,offline:row.cards.filter(c=>c.offline).length,errors:row.errors}));
  }
 }
 await send('Emulation.setDeviceMetricsOverride',{width:1280,height:745,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:1881/scenes'});await sleep(3000);
 await ev(`document.querySelector('.scene-head button').click()`);await sleep(500);
 const focused=await ev(`({visible:[...document.querySelectorAll('.scenes article')].filter(e=>!e.hidden).length,canvas:document.querySelector('.scenes article canvas').getBoundingClientRect().toJSON()})`);results.push({focus:focused,pass:focused.visible===1});
 await ev(`document.querySelector('.scene-head button').click();[...document.querySelectorAll('button')].find(b=>b.textContent.includes('门口标定')).click()`);await sleep(500);
 const calibration=await ev(`({present:!!document.querySelector('section[aria-label="门口标定"]'),canSave:[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存标定'))?.disabled===false})`);results.push({calibration,pass:calibration.present&&!calibration.canSave});
 fs.writeFileSync(path.join(root,'project/_logs/scenes-ui-regression.json'),JSON.stringify({results,issues},null,2));
 if(issues.length||results.some(r=>r.pass===false)){process.exitCode=1;}
}finally{await send('Page.close').catch(()=>{});ws.close();}
