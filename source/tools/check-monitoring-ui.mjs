import fs from 'node:fs';
import path from 'node:path';
import { login } from './ui-session.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const reportName = process.env.SCADIA_UI_ACTIONS_ONLY?'ui-actions-regression.json':process.env.SCADIA_UI_ROUTES?'ui-focused-regression.json':'ui-regression.json';
const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const waiters = new Map(), issues = [], results = [], actions = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') { issues.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        issues.push(m.params.args.map(x => x.value || x.description || '').join(' '));
    }
};
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { waiters.delete(n); reject(new Error('CDP timeout: ' + method)); }, 20000);
    waiters.set(n, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression, userGesture = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); }
    return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {
    const image = await send('Page.captureScreenshot', { format:'png' });
    fs.writeFileSync(path.join(root,'project/_logs',name+'.png'),Buffer.from(image.data,'base64'));
};
await send('Page.enable'); await send('Runtime.enable');
try {
    await login({root,send,evaluate});
    const allRoutes=['/home/v_zc_home','/home/v_zc_g1','/scenes','/people','/home/v_zc_g2','/home/v_zc_g4','/home/v_zc_g5','/home/v_zc_g6','/home/v_zc_g7','/analysis','/analysis?config=1','/mes','/ems','/video','/alarms','/reports','/flows','/users','/ai-analysis','/messages','/notifications','/logs','/events','/cameras','/recipes','/calibrations','/device','/userRoles','/scripts','/language','/mapsLocations','/plugins','/arMarkers'];
    const routes=process.env.SCADIA_UI_ROUTES?process.env.SCADIA_UI_ROUTES.split(','):allRoutes;
    const sizes=[{width:1280,height:745},{width:1920,height:1080}].filter(s=>!process.env.SCADIA_UI_WIDTH||s.width===Number(process.env.SCADIA_UI_WIDTH));
    for (const size of process.env.SCADIA_UI_ACTIONS_ONLY?[]:sizes) {
        await send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});
        for (const route of routes) {
            issues.length=0;
            console.log(JSON.stringify({checking:route,size}));
            await send('Page.navigate',{url:'http://127.0.0.1:1881'+route});await sleep(5500);
            const row=await evaluate(`(()=>{
                const rect=e=>e?.getBoundingClientRect().toJSON();
                const mes=document.getElementById('svg_nav_mes_label'),conn=document.querySelector('[data-field=connection]');
                const a=rect(mes),b=rect(conn);
                return {route:location.pathname,viewport:[innerWidth,innerHeight],
                    text:document.body.innerText.slice(-4500),
                    svg:[...document.querySelectorAll('#content>svg')].map(rect),
                    menuOverlap:!!(a&&b&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top),
                    menu:[...document.querySelectorAll('#content text')].filter(e=>/MES|EMS/.test(e.textContent)).map(e=>({id:e.id,text:e.textContent,rect:rect(e)})),
                    status:[...document.querySelectorAll('[data-field]')].map(e=>({field:e.dataset.field,text:e.textContent})),
                    panes:[...document.querySelectorAll('foreignObject[id^=live_]')].map(e=>({id:e.id,rect:rect(e),nw:e.firstChild.naturalWidth,nh:e.firstChild.naturalHeight,visibility:e.firstChild.style.visibility})),
                    thermal:[...document.querySelectorAll('g[id^=detection_] text')].map(e=>e.textContent),
                    errors:window.__monitor?.errors,
                    sceneCards:[...document.querySelectorAll('.scenes article')].map(e=>({rect:rect(e),canvas:rect(e.querySelector('canvas')),offline:!!e.querySelector('.offline')})),
                    dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent.slice(0,1200)),
                    boards:[...document.querySelectorAll('.scada,.sc-body')].map(e=>({class:e.className,rect:rect(e),client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]})),
                    buttons:[...document.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.innerText||e.title||e.getAttribute('aria-label')),
                    pageOverflow:document.documentElement.scrollWidth>innerWidth+1};
            })()`);
            row.issues=[...issues];row.size=size;
            const name='ui-'+route.split('/').pop().replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+size.width;
            row.requestedRoute=route;
            await shot(name);row.screenshot=name+'.png';
            if(['/mes','/ems'].includes(route)) {
                row.bottom=await evaluate(`(()=>{const e=document.querySelector('.sc-body');if(!e)return null;e.scrollTop=e.scrollHeight;return {atBottom:Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop)<2,last:e.lastElementChild.getBoundingClientRect().toJSON()}})()`);
                await shot(name+'-bottom');
            }
            results.push(row);
            console.log(JSON.stringify({route,size,menuOverlap:row.menuOverlap,issues:row.issues,panes:row.panes.length,errors:row.errors,overflow:row.pageOverflow,bottom:row.bottom?.atBottom}));
        }
    }
    if(!process.env.SCADIA_UI_ROUTES) {
    await send('Page.navigate',{url:'http://127.0.0.1:1881/home/v_zc_g2'});await sleep(4000);
    await evaluate(`document.getElementById('alarm-confirm-entry').click()`);await sleep(1200);
    actions.push({name:'alarm dialog',result:await evaluate(`document.getElementById('alarm-confirm-dialog').innerText`)});
    await shot('ui-alarm-confirm-before');
    // A mismatched event must be rejected without changing the current one.
    actions.push({name:'stale event guard',result:await evaluate(`(async()=>{
        const m=window.__monitor,a=(m.data.alarms||[]).find(x=>!m.isAcked(x));if(!a)return {skipped:'no pending alarm'};
        const r=await fetch('/api/alarmack',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},m.headers()),body:JSON.stringify({params:a.name,expectedOntime:Number(a.ontime)-1})});
        return {status:r.status,pass:r.status===409};
    })()`)});
    await evaluate(`document.querySelector('#alarm-confirm-dialog [data-rows] button:not([disabled])')?.click()`);await sleep(1800);
    actions.push({name:'alarm acknowledge and readback',result:await evaluate(`document.querySelector('#alarm-confirm-dialog [role=status]').textContent`)});
    await shot('ui-alarm-confirm-after');
    await evaluate(`document.querySelector('#alarm-confirm-dialog [data-close]').click()`);
    await evaluate(`document.getElementById('all-count-reset').click()`);await sleep(300);
    await evaluate(`document.querySelectorAll('#counter-dialog button')[1].click()`);await sleep(1200);
    actions.push({name:'counter reset',result:await evaluate(`document.querySelector('#counter-dialog [role=status]').textContent`)});
    await shot('ui-count-reset');
    await evaluate(`document.querySelector('#counter-dialog button').click()`);
    await evaluate(`document.querySelector('a[href="/ai-analysis"]').click()`,true);await sleep(2500);
    const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
    const popup = tabs.find(t=>t.type==='page'&&t.url==='http://127.0.0.1:1881/ai-analysis'&&t.id!==tab.id);
    if(!popup) { throw new Error('AI analysis popup did not open'); }
    const pw = new WebSocket(popup.webSocketDebuggerUrl);await new Promise(r=>pw.onopen=r);
    const peval=expression=>new Promise((resolve,reject)=>{pw.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){m.result.exceptionDetails?reject(new Error(m.result.exceptionDetails.text)):resolve(m.result.result.value)}};pw.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});
    actions.push({name:'analysis popup authenticated',result:await peval(`({evidence:document.getElementById('evidence').textContent,status:document.getElementById('status').textContent,hasOpener:!!opener,hasTokenInUrl:location.search.includes('token')})`)});
    await peval(`document.getElementById('module').value='mes';document.getElementById('module').dispatchEvent(new Event('change'))`);await sleep(1500);
    actions.push({name:'analysis module evidence gate',result:await peval(`({module:document.getElementById('module').value,quality:document.getElementById('quality').textContent,message:document.getElementById('message').textContent})`)});
    await peval(`document.getElementById('test').click()`);await sleep(23000);
    actions.push({name:'DeepSeek live test',result:await peval(`({message:document.getElementById('message').textContent,answerVisible:!document.getElementById('answer').hidden,answer:document.getElementById('answer').textContent.slice(0,800)})`)});
    pw.close(); await fetch('http://127.0.0.1:9222/json/close/'+popup.id);
    console.log(JSON.stringify({actions}));
    }
    const failures=results.filter(x=>x.menuOverlap||x.issues.length||x.pageOverflow||x.route==='/login'||x.bottom?.atBottom===false);
    const actionFailures=actions.filter(x=>x.result?.pass===false||x.result?.hasTokenInUrl===true);
    if(actionFailures.length) { process.exitCode=1; }
    fs.writeFileSync(path.join(root,'project/_logs',reportName),JSON.stringify({results,actions,failures:failures.map(x=>({route:x.route,size:x.size,issues:x.issues})),actionFailures},null,2));
    if(failures.length) { process.exitCode=1; }
} catch (error) {
    process.exitCode=1;
    fs.writeFileSync(path.join(root,'project/_logs',reportName),JSON.stringify({results,actions,incomplete:true,error:String(error.message)},null,2));
    throw error;
} finally { await send('Page.close').catch(()=>{});ws.close(); }
