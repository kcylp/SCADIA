import fs from 'node:fs';
import path from 'node:path';
import { login } from './ui-session.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const waits = new Map(), issues = [], results = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') { issues.push(m.params.exceptionDetails.text); }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { waits.delete(n); reject(new Error('CDP timeout: ' + method)); }, 20000);
    waits.set(n, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params }));
});
const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); }
    return r.result?.value;
};
const pause = ms => new Promise(r => setTimeout(r, ms));
const record = (name, value, pass) => {
    results.push({ name, value, pass }); console.log(JSON.stringify({ name, pass, value }));
};
try {
    await send('Page.enable'); await send('Runtime.enable');
    await login({ root, send, evaluate: ev });
    for (const size of [{ width: 1280, height: 745 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
        await send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
        for (const route of ['/alarms', '/home/v_zc_g5']) {
            await send('Page.navigate', { url: 'http://127.0.0.1:1881' + route }); await pause(5000);
            const native = route === '/alarms';
            const page = await ev(`({route:location.pathname,overflow:document.documentElement.scrollWidth>innerWidth+1,
                rows:document.querySelectorAll('mat-row').length,historyButtons:[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('历史证据')).length,
                monitorRows:(window.__monitor?.data?.alarms||[]).filter(a=>a.eventId).length,
                monitorReady:!!document.getElementById('aq_layer')&&typeof window.__monitor?.openSceneEvidence==='function'})`);
            record(route + '-' + size.width + '-list', page, !page.overflow && (native ? page.historyButtons > 0 : page.monitorReady && page.monitorRows > 0));
            if (native) {
                await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('历史证据'));b?.click()})()`);
            } else {
                await ev(`(()=>{const m=window.__monitor,row=(m.data.alarms||[]).find(a=>a.eventId);if(!row)throw new Error('No persisted scene alarm');m.openSceneEvidence(row)})()`);
            }
            await pause(2000);
            const detail = await ev(`(()=>{
                const d=document.querySelector('${native ? 'mat-dialog-container' : '#scene-evidence-dialog'}');
                if(!d)return {present:false};const r=d.getBoundingClientRect();
                return {present:true,frames:d.querySelectorAll('figure').length,images:[...d.querySelectorAll('img')].map(i=>({loaded:i.complete&&i.naturalWidth>0})),
                    inside:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1,text:d.innerText.slice(-600),overflow:d.scrollWidth>d.clientWidth+1};
            })()`);
            record(route + '-' + size.width + '-evidence', detail, detail.present && detail.frames > 0 && detail.images.length > 0 && detail.images.every(i => i.loaded) && detail.inside && !detail.overflow);
            const screenshot = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(root, 'project/_logs', 'scene-alarm-' + (native ? 'native' : 'monitor') + '-' + size.width + '.png'), Buffer.from(screenshot.data, 'base64'));
            await ev(`(()=>{const d=document.querySelector('${native ? 'mat-dialog-container' : '#scene-evidence-dialog'}');[...d.querySelectorAll('button')].find(b=>b.textContent.includes('关闭')).click()})()`);
            await pause(300);
            const closed = await ev(`!document.querySelector('${native ? 'mat-dialog-container' : '#scene-evidence-dialog'}')`);
            record(route + '-' + size.width + '-close', closed, closed);
        }
    }
    // Exercise only browser-local failures; no live event is acknowledged or modified.
    await send('Page.navigate', { url: 'http://127.0.0.1:1881/home/v_zc_g5' }); await pause(4000);
    await ev(`(()=>{window.__realFetch=window.fetch;window.fetch=(url,opts)=>String(url).includes('evidence?frame=')?Promise.resolve(new Response('',{status:404})):window.__realFetch(url,opts);const m=window.__monitor;m.openSceneEvidence((m.data.alarms||[]).find(a=>a.eventId))})()`);
    await pause(1500);
    const missing = await ev(`({text:document.querySelector('#scene-evidence-dialog')?.innerText,images:document.querySelectorAll('#scene-evidence-dialog img').length})`);
    record('missing-frame-message', missing, missing.text?.includes('图片读取失败') && missing.images === 0);
    await ev(`document.querySelector('#scene-evidence-dialog').close();window.fetch=window.__realFetch`); await pause(100);
    await ev(`(()=>{window.fetch=(url,opts)=>String(url).includes('evidence-manifest')?Promise.resolve(new Response('',{status:403})):window.__realFetch(url,opts);const m=window.__monitor;m.openSceneEvidence((m.data.alarms||[]).find(a=>a.eventId))})()`);
    await pause(500);
    const denied = await ev(`document.querySelector('#scene-evidence-dialog')?.innerText`);
    record('forbidden-message', denied, denied?.includes('403') && denied?.includes('登录'));
    await ev(`document.querySelector('#scene-evidence-dialog').close();window.fetch=window.__realFetch`);
    record('uncaught-errors', issues, issues.length === 0);
} catch (error) {
    record('test-error', error.message, false);
} finally {
    fs.writeFileSync(path.join(root, 'project/_logs/scene-alarms-ui-regression.json'), JSON.stringify({ results, issues }, null, 2));
    if (results.some(row => !row.pass)) { process.exitCode = 1; }
    await send('Page.close').catch(() => {}); ws.close();
}
