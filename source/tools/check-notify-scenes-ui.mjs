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
const wait=async(expression,description)=>{for(let i=0;i<60;i++){if(await ev(expression))return;await sleep(250);}throw new Error(description);};
// MDC 组件只响应真实鼠标事件；合成 click 打不开 mat-select。
const mouseClick=async selector=>{
    const rect=await ev(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`);
    if(!rect)throw new Error('element not found for click: '+selector);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+rect.width/2,y:rect.y+rect.height/2,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.width/2,y:rect.y+rect.height/2,button:'left',clickCount:1});
};
const results=[];
const NAME='UI-订阅回读-'+Date.now();
try{
 await send('Page.enable');await send('Runtime.enable');
 await login({root,send,evaluate:ev});
 await send('Page.navigate',{url:'http://127.0.0.1:1881/notifications'});await sleep(4000);
 await mouseClick('app-notification-list button');
 await wait(`!!document.querySelector('app-notification-property form input')`,'property dialog did not open');
 await ev(`(()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const inputs=[...document.querySelectorAll('app-notification-property form input')].filter(e=>e.type==='text');
    set.call(inputs[0],'${NAME}');inputs[0].dispatchEvent(new Event('input',{bubbles:true}));
    set.call(inputs[1],'ui-scene-sub@example.invalid');inputs[1].dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 await mouseClick('app-notification-property mat-select');
 await wait(`document.querySelectorAll('.cdk-overlay-container mat-option').length>0`,'type options did not open');
 await ev(`(()=>{const opt=[...document.querySelectorAll('.cdk-overlay-container mat-option')].find(o=>o.textContent.includes('八场景事件'));
    if(!opt)throw new Error('scenes option missing');
    const r=opt.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`).then(async pos=>{
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button:'left',clickCount:1});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button:'left',clickCount:1});
    });
 await wait(`!!document.querySelector('app-notification-property select[multiple]')`,'scenes section did not appear');
 await ev(`(()=>{const sel=document.querySelector('app-notification-property select[multiple]');
    [...sel.options].forEach(o=>o.selected=['V1','T1'].includes(o.label||o.textContent.trim()));
    sel.dispatchEvent(new Event('change',{bubbles:true}));return [...sel.selectedOptions].map(o=>o.value);})()`);
 const okDisabled=await ev(`[...document.querySelectorAll('app-notification-property button')].find(b=>b.classList.contains('mat-primary'))?.disabled`);
 await mouseClick('app-notification-property button.mat-primary');
 await wait(`!![...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}'))`,'saved row not visible in list');
 const saved=await ev(`(()=>{const row=[...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}'));
    return {name:row?.textContent.includes('${NAME}'),subRange:row?.textContent.includes('V1, T1 / candidate'),receiver:row?.textContent.includes('ui-scene-sub@example.invalid')};})()`);
 results.push({step:'save-new',okDisabled,saved,pass:!okDisabled&&saved.name&&saved.subRange&&saved.receiver});
 // 重新加载（真读回：从工程存储加载）
 await send('Page.navigate',{url:'http://127.0.0.1:1881/notifications'});await sleep(4000);
 const reload=await ev(`(()=>{const row=[...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}'));
    return {present:!!row,subRange:row?.textContent.includes('V1, T1 / candidate')};})()`);
 results.push({step:'reload-readback',reload,pass:reload.present&&reload.subRange});
 // 编辑既有订阅：改成 V3+V7，保存，再读回
 await ev(`(()=>{const row=[...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}'));
    const r=row.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`).then(async pos=>{
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button:'left',clickCount:1});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button:'left',clickCount:1});
    });
 await wait(`!!document.querySelector('app-notification-property select[multiple]')`,'edit dialog did not open');
 const editInit=await ev(`[...document.querySelector('app-notification-property select[multiple]').selectedOptions].map(o=>o.label||o.textContent.trim())`);
 await ev(`(()=>{const sel=document.querySelector('app-notification-property select[multiple]');
    [...sel.options].forEach(o=>o.selected=['V3','V7'].includes(o.label||o.textContent.trim()));
    sel.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
 await mouseClick('app-notification-property button.mat-primary');
 await wait(`!![...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}')&&r.textContent.includes('V3, V7'))`,'edited row not updated');
 await send('Page.navigate',{url:'http://127.0.0.1:1881/notifications'});await sleep(4000);
 const edited=await ev(`(()=>{const row=[...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}'));
    return {subRange:row?.textContent.includes('V3, V7 / candidate')};})()`);
 results.push({step:'edit-readback',editInit,edited,pass:JSON.stringify(editInit)==='["V1","T1"]'&&edited.subRange});
 // 清理：移除测试订阅（行内第二个按钮是 remove 列）
 await ev(`(()=>{const row=[...document.querySelectorAll('mat-table mat-row')].find(r=>r.textContent.includes('${NAME}'));
    const r=row.querySelectorAll('button')[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`).then(async pos=>{
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button:'left',clickCount:1});
        await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button:'left',clickCount:1});
    });
 await wait(`!!document.querySelector('app-confirm-dialog')`,'confirm dialog did not open');
 await mouseClick('app-confirm-dialog button.mat-primary');
 await sleep(1500);
 const removed=await ev(`![...document.querySelectorAll('mat-table mat-row')].some(r=>r.textContent.includes('${NAME}'))`);
 results.push({step:'cleanup',removed,pass:removed});
 fs.writeFileSync(path.join(root,'project/_logs/notify-scenes-ui.json'),JSON.stringify({results,issues},null,2));
 console.log(JSON.stringify({results,issues}));
 if(issues.length||results.some(r=>r.pass===false)){process.exitCode=1;}
}catch(e){
 fs.writeFileSync(path.join(root,'project/_logs/notify-scenes-ui.json'),JSON.stringify({results,issues,error:String(e)},null,2));
 console.error(String(e));process.exitCode=1;
}finally{await send('Page.close').catch(()=>{});ws.close();}
