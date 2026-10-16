import fs from 'node:fs';
import path from 'node:path';
import { login } from './ui-session.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const tab=await(await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const waits=new Map(),issues=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&waits.has(m.id)){waits.get(m.id)(m);waits.delete(m.id);}if(m.method==='Runtime.exceptionThrown'){issues.push(m.params.exceptionDetails.text);}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>reject(new Error('CDP '+method+' timed out')),30000);waits.set(n,m=>{clearTimeout(timer);m.error?reject(new Error(m.error.message)):resolve(m.result);});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails){throw new Error((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text);}return r.result.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(expression,description)=>{for(let i=0;i<60;i++){if(await ev(expression))return;await sleep(250);}throw new Error(description);};
const mouseClick=async selector=>{
    const rect=await ev(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`);
    if(!rect)throw new Error('element not found: '+selector);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+rect.width/2,y:rect.y+rect.height/2,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.width/2,y:rect.y+rect.height/2,button:'left',clickCount:1});
};
const clickAt=async pos=>{
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button:'left',clickCount:1});
};
const apiInPage=async(url,body)=>ev(`(async()=>{const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(body===undefined?'GET':'POST')},
    headers:{'x-access-token':window.scadiaAccessToken,'Content-Type':'application/json'},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}signal:AbortSignal.timeout(30000)});
    let data={};try{data=await r.json()}catch(_){}return {status:r.status,data};})()`);
const results=[];
fs.mkdirSync(path.join(root,'project/_logs'),{recursive:true});
const NAME='UI-报表闭环-'+Date.now();
const checked=()=>`[...document.querySelectorAll('app-report-item-alarms mat-checkbox')].filter(c=>(c.querySelector('input')?.checked===true)).map(c=>c.textContent.trim()).filter(t=>/^(全部八场景|V[1-7]|T1)$/.test(t))`;
async function cleanup(){
    // 删除本次测试报表与其生成文件；不影响现场其它报表。
    try{
        const proj=await apiInPage('/api/project');
        const reports=((proj.data&&proj.data.reports)||[]);
        const mine=reports.filter(r=>r&&r.name===NAME);
        for(const rpt of mine){await apiInPage('/api/projectData',{cmd:'del-report',data:rpt});}
        const files=await apiInPage('/api/reportsQuery?query='+encodeURIComponent(JSON.stringify({name:NAME})));
        const list=(files.data&&files.data.data)||files.data||[];
        if(Array.isArray(list)){for(const f of list){if(String(f.fileName||'').startsWith(NAME+'_')){await apiInPage('/api/reportRemoveFile',{params:{fileName:f.fileName}});}}}
        return mine.length;
    }catch(_){return -1;}
}
try{
 await send('Page.enable');await send('Runtime.enable');
 await login({root,send,evaluate:ev});
 // 删除按钮位于最右列：先设 1920 宽视口，避免按钮落在默认视口之外（此前误判为功能失败）。
 await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'http://127.0.0.1:1881/reports'});await sleep(4000);
 await mouseClick('button.fab-add');
 await wait(`!!document.querySelector('app-report-editor form input')`,'report editor did not open');
 await ev(`(()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const input=document.querySelector('app-report-editor form input');
    set.call(input,'${NAME}');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 // 添加报警历史项（MDC 触发器对坐标点击偶发不响应：坐标与 DOM 双路径重试）
 let menuOpen=false;
 for(let attempt=0;attempt<5&&!menuOpen;attempt++){
     try{await mouseClick('app-report-editor .report-head-menu');}catch(_){}
     await sleep(900);
     menuOpen=await ev(`[...document.querySelectorAll('.cdk-overlay-container button')].some(b=>b.textContent.includes('警报历史'))`);
     if(!menuOpen){await ev(`document.querySelector('app-report-editor .report-head-menu')?.click()`);await sleep(900);
         menuOpen=await ev(`[...document.querySelectorAll('.cdk-overlay-container button')].some(b=>b.textContent.includes('警报历史'))`);}
 }
 if(!menuOpen){throw new Error('item menu did not open');}
 const menuPos=await ev(`(()=>{const b=[...document.querySelectorAll('.cdk-overlay-container button')].find(b=>b.textContent.includes('警报历史'));
    const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 // MDC 菜单按钮对坐标点击不稳定：菜单项自身是原生 button，用 DOM click 触发其监听器即可。
 await ev(`[...document.querySelectorAll('.cdk-overlay-container button')].find(b=>b.textContent.includes('警报历史'))?.click()`);
 await sleep(800);
 await wait(`!!document.querySelector('app-report-item-alarms')`,'alarms item dialog did not open');
 // 数据来源切到八场景候选事件（原生 select，合成 change 可用）
 await ev(`(()=>{const sel=[...document.querySelectorAll('app-report-item-alarms select')][0];
    if(!sel)throw new Error('source select missing');
    sel.value='scene';sel.dispatchEvent(new Event('change',{bubbles:true}));return sel.value;})()`);
 await wait(`!!document.querySelector('app-report-item-alarms mat-checkbox')`,'scene checkboxes did not appear');
 const defaults=await ev(`[...document.querySelectorAll('app-report-item-alarms mat-checkbox')].map(c=>(c.querySelector('input')?.checked===true)).filter(Boolean).length`);
 // 默认应全选（8 场景 + 全部开关 + 1 个结构空 checkbox），改成 V1+T1 子集
 await ev(`(()=>{const boxes=[...document.querySelectorAll('app-report-item-alarms mat-checkbox')];
    for(const label of ['V2','V3','V4','V5','V6','V7']){const b=boxes.find(c=>c.textContent.trim()===label);
        if(b&&b.querySelector('input')?.checked){b.querySelector('input').click();}}return true;})()`);
 await sleep(400);
 const subset=await ev(checked());
 results.push({step:'subset-selection',defaultsAllChecked:defaults>=9,subset,pass:defaults>=9&&JSON.stringify(subset)===JSON.stringify(['V1','T1'])});
 await mouseClick('app-report-item-alarms button.mat-primary');
 await wait(`!document.querySelector('app-report-item-alarms')`,'alarms item dialog did not close');
 await mouseClick('app-report-editor button.mat-primary');
 await sleep(1500);
 await send('Page.navigate',{url:'http://127.0.0.1:1881/reports'});await sleep(4000);
 await wait(`!![...document.querySelectorAll('tr.my-mat-row')].find(r=>r.textContent.includes('${NAME}'))`,'saved report row not visible');
 results.push({step:'save-report',pass:true});
 // 重开编辑器核对子集
 const editPos=await ev(`(()=>{const row=[...document.querySelectorAll('tr.my-mat-row')].find(r=>r.textContent.includes('${NAME}'));
    const b=row.querySelector('button');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 await clickAt(editPos);
 await wait(`!!document.querySelector('app-report-editor form input')`,'edit dialog did not open');
 await sleep(800);
 await mouseClick('app-report-editor .report-item-edit');
 await sleep(800);
 await wait(`!!document.querySelector('app-report-item-alarms mat-checkbox')`,'alarms item dialog did not reopen');
 const readback=await ev(checked());
 results.push({step:'reopen-readback',readback,pass:JSON.stringify(readback)===JSON.stringify(['V1','T1'])});
 // 全不选必须阻止保存并显示错误
 await ev(`(()=>{for(const label of ['V1','T1']){const b=[...document.querySelectorAll('app-report-item-alarms mat-checkbox')].find(c=>c.textContent.trim()===label);
    if(b&&b.querySelector('input')?.checked){b.querySelector('input').click();}}return true;})()`);
 await sleep(400);
 const sceneUnchecked=await ev(`[...document.querySelectorAll('app-report-item-alarms mat-checkbox')].filter(c=>/^(全部八场景|V[1-7]|T1)$/.test(c.textContent.trim())).every(c=>!(c.querySelector('input')?.checked===true))`);
 await mouseClick('app-report-item-alarms button.mat-primary');
 await sleep(600);
 const dialogStillOpen=await ev(`!!document.querySelector('app-report-item-alarms')`);
 const errVisible=await ev(`[...document.querySelectorAll('app-report-item-alarms *')].some(e=>e.children.length===0&&/至少选择一个场景/.test(e.textContent||''))`);
 results.push({step:'empty-selection-blocked',sceneUnchecked,dialogStillOpen,errVisible,pass:sceneUnchecked&&dialogStillOpen&&errVisible});
 // 取消子对话框并关闭编辑器
 await ev(`[...document.querySelectorAll('app-report-item-alarms button')].find(b=>/取消|Cancel/.test(b.textContent.trim()))?.click()`);await sleep(400);
 await mouseClick('app-report-editor .dialog-close-btn');await sleep(600);
 // 保存后立即生成（正对重载窗口）：先按名称从工程 API 拿真实报表 id，再点行内 play_arrow。
 const reportId=await ev(`(async()=>{const r=await fetch('/api/project',{headers:{'x-access-token':window.scadiaAccessToken}});
    const j=await r.json();const d=j.data||j;const hit=((d&&d.reports)||[]).find(x=>x.name==='${NAME}');return hit?hit.id:null;})()`);
 if(!reportId)throw new Error('saved report id not found in project');
 await ev(`(()=>{const row=[...document.querySelectorAll('tr.my-mat-row')].find(r=>r.textContent.includes('${NAME}'));
    if(!row)throw new Error('row missing');
    const b=[...row.querySelectorAll('button')].find(b=>b.querySelector('mat-icon')?.textContent?.trim()==='play_arrow');
    if(!b||b.disabled)throw new Error('generate button unavailable');
    b.click();})()`);
 let accepted=null;
 for(let i=0;i<20;i++){
     const r=await apiInPage('/api/reportStatus?id='+encodeURIComponent(reportId));
     if(r.status===200&&['running','completed','failed'].includes(r.data?.status?.state)){accepted=r.data.status;break;}
     await sleep(250);
 }
 results.push({step:'build-accepted-after-reopen',reportId,pass:!!accepted});
 if(!accepted)throw new Error('Generate click did not produce an accepted server request');
 // 轮询真实终态（页面上下文内调用 API，凭据不落地）
 let terminal=null;
 for(let i=0;i<60;i++){
     await sleep(2000);
     const r=await apiInPage('/api/reportStatus?id='+encodeURIComponent(reportId));
     const st=(r.data&&r.data.status)||{};
     if(st.state==='completed'||st.state==='failed'){terminal=st;break;}
 }
 results.push({step:'build-terminal-state',terminal,pass:!!terminal&&terminal.state==='completed'&&!!terminal.file});
 // 展开行详情，核对本次文件出现在列表
 await ev(`(()=>{const row=[...document.querySelectorAll('tr.my-mat-row')].find(r=>r.textContent.includes('${NAME}'));
    const b=row?.querySelector('.mat-column-expand button');
    if(!b)throw new Error('expand button missing');
    if(b.querySelector('mat-icon')?.textContent?.trim()==='expand_more')b.click();})()`);
 await sleep(2500);
 const details=await ev(`(()=>{const row=[...document.querySelectorAll('tr.my-mat-row')].find(r=>r.textContent.includes('${NAME}'));
    const det=row.nextElementSibling;return {expanded:!!det&&(det.textContent.includes('.pdf')),text:(det?.textContent||'').slice(0,200)};})()`);
 const generatedName=terminal?.file?.split(/[\\/]/).pop();
 results.push({step:'details-show-this-run-pdf',details,generatedName,pass:!!details.expanded&&!!generatedName&&details.text.includes(generatedName)});
 // UI 删除：remove 列（clear 图标，行内最后一个按钮）→ 确认对话框 → 行消失 → 重载仍不存在
 const delPos=await ev(`(()=>{const row=[...document.querySelectorAll('tr.my-mat-row')].find(r=>r.textContent.includes('${NAME}'));
    const btns=[...row.querySelectorAll('button')];const b=btns[btns.length-1];
    const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,icon:b.querySelector('mat-icon')?.textContent?.trim()};})()`);
 results.push({step:'delete-button-icon',icon:delPos.icon,pass:delPos.icon==='clear'});
 await clickAt({x:delPos.x,y:delPos.y});
 // 报表删除走 ReportEditor 的 remove 模式（编辑器复用确认），不是 ConfirmDialog。
 await wait(`!!document.querySelector('app-report-editor')`,'remove editor did not open');
 let confirmed=false;
 for(let attempt=0;attempt<5&&!confirmed;attempt++){
     try{await mouseClick('app-report-editor button.mat-primary');}catch(_){}
     await sleep(1200);
     confirmed=await ev(`!document.querySelector('app-report-editor')`);
     if(!confirmed){await ev(`[...document.querySelectorAll('app-report-editor button')].find(b=>b.classList.contains('mat-primary'))?.click()`);await sleep(1200);
         confirmed=await ev(`!document.querySelector('app-report-editor')`);}
 }
 if(!confirmed){throw new Error('remove confirm did not complete');}
 await sleep(2000);
 const removedInUi=await ev(`![...document.querySelectorAll('tr.my-mat-row')].some(r=>r.textContent.includes('${NAME}'))`);
 await send('Page.navigate',{url:'http://127.0.0.1:1881/reports'});await sleep(4000);
 const removedAfterReload=await ev(`![...document.querySelectorAll('tr.my-mat-row')].some(r=>r.textContent.includes('${NAME}'))`);
 results.push({step:'delete-ui-flow',removedInUi,removedAfterReload,pass:removedInUi&&removedAfterReload});
 fs.writeFileSync(path.join(root,'project/_logs/reports-scenes-ui.json'),JSON.stringify({results,issues},null,2));
 console.log(JSON.stringify({results,issues}));
 if(issues.length||results.some(r=>r.pass===false)){process.exitCode=1;}
}catch(e){
 fs.writeFileSync(path.join(root,'project/_logs/reports-scenes-ui.json'),JSON.stringify({results,issues,error:String(e)},null,2));
 console.error(String(e));process.exitCode=1;
}finally{
 const cleaned=await cleanup();
 console.log('cleanup removed reports:',cleaned);
 await send('Page.close').catch(()=>{});ws.close();
}
