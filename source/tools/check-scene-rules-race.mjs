import fs from 'node:fs';
import path from 'node:path';
import { login } from './ui-session.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const tab=await(await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const waits=new Map(),issues=[];
const paused=[];
ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.id&&waits.has(m.id)){waits.get(m.id)(m);waits.delete(m.id);}
    if(m.method==='Runtime.exceptionThrown'){issues.push(m.params.exceptionDetails.text);}
    if(m.method==='Fetch.requestPaused'){paused.push(m.params.requestId);}
};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>reject(new Error('CDP '+method+' timed out')),20000);waits.set(n,m=>{clearTimeout(timer);m.error?reject(new Error(m.error.message)):resolve(m.result);});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails){throw new Error((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text);}return r.result.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(expression,description)=>{for(let i=0;i<60;i++){if(await ev(expression))return;await sleep(250);}throw new Error(description);};
const results=[];
try{
 await send('Page.enable');await send('Runtime.enable');
 await login({root,send,evaluate:ev});
 await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:1881/scenes'});await sleep(5000);
 await wait(`!!document.querySelector('app-scene-board details summary')`,'rules summary missing');
 const rulesBtn=await ev(`(()=>{const s=document.querySelector('app-scene-board details summary');
    if(!s)return null;const r=s.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,text:s.textContent.trim()};})()`);
 results.push({step:'rules-panel',rulesBtn,pass:!!rulesBtn});
 if(!rulesBtn){throw new Error('rules summary not found');}
 // 基线：正常展开确实能读出规则
 await ev(`(()=>{const d=document.querySelector('app-scene-board details');d.open=true;d.dispatchEvent(new Event('toggle'));return true;})()`);
 await sleep(2500);
 const baseline=await ev(`document.querySelectorAll('app-scene-board details mat-checkbox, app-scene-board details input[type=checkbox]').length`);
 results.push({step:'baseline-rules-loaded',rows:baseline,pass:baseline>0});
 // 拦截 rules 请求并暂停，制造“晚返回”
 await send('Fetch.enable',{patterns:[{urlPattern:'*/api/ai/scenes/rules/*'}]});
 paused.length=0;
 await ev(`(()=>{const d=document.querySelector('app-scene-board details');d.open=false;d.dispatchEvent(new Event('toggle'));return true;})()`);
 await sleep(600);
 await ev(`(()=>{const d=document.querySelector('app-scene-board details');d.open=true;d.dispatchEvent(new Event('toggle'));return true;})()`);
 for(let i=0;i<40&&!paused.length;i++){await sleep(250);}
 results.push({step:'request-held',heldCount:paused.length,pass:paused.length>0});
 // 请求仍挂起时在 SPA 内切换身份（点“退出” → currentUser$ 变化 → identityGeneration 递增，不整页刷新）
 const logoutClicked=await ev(`(()=>{const el=[...document.querySelectorAll('button,a')].find(e=>/退出/.test(e.textContent));
    if(!el)return false;el.click();return true;})()`);
 await sleep(2500);
 const identityChanged=await ev(`!window.scadiaAccessToken`);
 results.push({step:'identity-changed',logoutClicked,identityChanged,pass:logoutClicked&&identityChanged});
 // 放行被挂起的旧请求（响应属于“前一个身份”），它必须被 identityGeneration 门禁拦下
 for(const rid of paused){try{await send('Fetch.continueRequest',{requestId:rid});}catch(_){}}
 await sleep(3000);
 await send('Fetch.disable');
 const after=await ev(`(()=>{const txt=document.body.innerText;
    return {ruleRows:document.querySelectorAll('app-scene-board details mat-checkbox, app-scene-board details input[type=checkbox]').length,
        hasSavedMsg:/规则已保存/.test(txt)};})()`);
 results.push({step:'stale-response-blocked',after,pass:after.ruleRows===0&&!after.hasSavedMsg});
 fs.writeFileSync(path.join(root,'project/_logs/scene-rules-race.json'),JSON.stringify({results,issues},null,2));
 console.log(JSON.stringify({results,issues}));
 if(issues.length||results.some(r=>r.pass===false)){process.exitCode=1;}
}catch(e){
 fs.writeFileSync(path.join(root,'project/_logs/scene-rules-race.json'),JSON.stringify({results,issues,error:String(e)},null,2));
 console.error(String(e));process.exitCode=1;
}finally{await send('Fetch.disable').catch(()=>{});await send('Page.close').catch(()=>{});ws.close();}
