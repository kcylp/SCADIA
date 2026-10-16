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
 for(const size of [{width:1280,height:745},{width:1920,height:1080}]){
  for(const route of ['/home/v_zc_g3','/home/v_zc_g8']){
   issues.length=0;
   await send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});
   await send('Page.navigate',{url:'http://127.0.0.1:1881'+route});await sleep(5000);
   const row=await ev(`(()=>({route:location.pathname,heading:document.querySelector('h1,h2,.header-panel')?.textContent?.trim(),panes:document.querySelectorAll('.pane,.my-pane,md-pane').length,svg:document.querySelectorAll('svg').length,canvas:document.querySelectorAll('canvas').length,overflow:document.documentElement.scrollWidth>innerWidth+1,errors:[...document.querySelectorAll('.error')].map(e=>e.textContent),body:document.body.innerText.slice(0,300)}))()`);
   row.size=size;row.pass=!row.overflow&&!row.errors.length&&!issues.length;
   results.push(row);
   console.log(JSON.stringify({route:row.route,size:size.width,pass:row.pass,panes:row.panes,svg:row.svg,errors:row.errors}));
  }
 }
 fs.writeFileSync(path.join(root,'project/_logs/group-pages-g3-g8.json'),JSON.stringify({results,issues},null,2));
 if(issues.length||results.some(r=>!r.pass)){process.exitCode=1;}
}catch(e){console.error(String(e));process.exitCode=1;}finally{await send('Page.close').catch(()=>{});ws.close();}
