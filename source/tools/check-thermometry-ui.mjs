// 解锁后一键验证：/scenes 页测温面板的真实数据显示（DOM 数据 + 截图）。
// 用法：node source/tools/check-thermometry-ui.mjs   （需要 1881 服务与 9222 CDP 已运行）
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root.startsWith('D:') ? 'D:/SCADIA-工作站迁移/SCADIA/project/_logs/' : root, '');
const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const waits = new Map(); const issues = [];
ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') { issues.push(m.params.exceptionDetails.text); } };
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error('CDP ' + method + ' timed out')), 30000);
    waits.set(n, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { throw new Error(r.exceptionDetails.text); } return r.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:1881/scenes' });
    // 等页面登录 + 首轮轮询（loadThermo 在 /api/ai/scenes 成功后触发）
    let panel = null;
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        panel = await ev(`(()=>{const s=document.querySelector('section.thermo');if(!s)return null;
            return {heading:s.querySelector('h2')?.textContent,
                status:s.querySelector('.thermo-status')?.textContent.replace(/\\s+/g,' ').trim(),
                reason:[...s.querySelectorAll('.detail')].map(e=>e.textContent.trim()),
                cards:[...s.querySelectorAll('.thermo-cards .card')].map(c=>c.textContent.replace(/\\s+/g,' ').trim()),
                hotspots:[...s.querySelectorAll('.thermo ol li')].map(l=>l.textContent.replace(/\\s+/g,' ').trim()),
                trendRows:[...s.querySelectorAll('.thermo table tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())};})()`);
        if (panel && panel.cards && panel.cards.length) break;   // 出现温度卡即数据就绪
    }
    const api = await (await fetch('http://127.0.0.1:1881/api/ai/scenes/thermometry')).json();
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = outDir + 'thermometry-ui-verify.png';
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const result = { panel, apiStatus: { status: api.status, unit: api.unit, sceneTemperature: api.sceneTemperature,
        hotspots: (api.hotspots || []).length, samples: api.samples, reason: api.reason }, issues, screenshot: file };
    fs.writeFileSync(outDir + 'thermometry-ui-verify.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    const pass = api.status === 'ok' && api.deviceTemperature != null &&
        panel && panel.cards && panel.cards.length >= 1 && issues.length === 0;
    console.log('PASS=' + pass);
    process.exitCode = pass ? 0 : 1;
} catch (e) {
    console.error(String(e)); process.exitCode = 1;
} finally {
    await send('Page.close').catch(() => {}); ws.close();
}
