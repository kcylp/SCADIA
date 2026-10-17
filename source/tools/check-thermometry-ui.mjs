// 解锁后一键验证：/scenes 页红外测温卡片的真实数据显示（DOM 数据 + 截图）。
// 用法：node source/tools/check-thermometry-ui.mjs
// 要求：1881 服务在线；Chrome/Edge 以 --remote-debugging-port=9222 启动。
// 注意（R07）：
//   - 本脚本不接受任何命令行参数，URL 为常量，避免被 Git Bash 路径转换
//     （/scenes 会被 MSYS 改写成 C:/Program Files/Git/scenes，导致 “Cannot navigate to invalid URL”）。
//   - 选择器匹配当前真实模板：测温卡片为场景卡内的 .temp-overlay（不是 section.thermo）。
//   - 数值比较只读取“温度数值专属元素”，与时间元素分离，按有限数字解析并带显示精度容差；
//     绝不对整张卡片文本做模糊匹配（避免时间里的 33 冒充 33°C）。
//   - 每次运行另存带时间戳的证据文件，不覆盖旧记录。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:1881';
const CDP = 'http://127.0.0.1:9222';
const PAGE_URL = BASE + '/scenes';
if (!/^https?:\/\//.test(PAGE_URL)) { throw new Error('invalid page url: ' + PAGE_URL); }

const scriptName = path.basename(process.argv[1] || 'check-thermometry-ui.mjs');
const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root.startsWith('D:') ? 'D:/SCADIA-工作站迁移/SCADIA/project/_logs' : root);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 从“温度专属元素”文本解析首个有限数字；用于与 API 样本按显示精度比较。
function parseTempNumber(text) {
    if (typeof text !== 'string') { return NaN; }
    const m = text.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
}
function tempMatches(text, apiTemp) {
    const shown = parseTempNumber(text);
    if (!Number.isFinite(shown) || !Number.isFinite(apiTemp)) { return false; }
    return Math.abs(shown - apiTemp) <= 0.05 + 1e-9;   // 显示精度 0.1，容差 ±0.05
}

async function verifyWidth(width, height) {
    const tab = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
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
    try {
        await send('Page.enable'); await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: PAGE_URL });
        // 等页面登录 + 测温卡片渲染（温度轮询已与场景请求解耦，2 秒周期）
        let panel = null;
        const readPanel = () => ev(`(()=>{const cards=[...document.querySelectorAll('.temp-overlay')];
            return { count: cards.length,
                cards: cards.map(c=>({
                    full: c.textContent.replace(/\\s+/g,' ').trim(),
                    tempText: (c.querySelector('strong:not(.temp-bad)')||{}).textContent ? c.querySelector('strong:not(.temp-bad)').textContent.trim() : null,
                    badText: (c.querySelector('.temp-bad')||{}).textContent ? c.querySelector('.temp-bad').textContent.trim() : null,
                    timeText: [...c.querySelectorAll('small')].map(e=>e.textContent.trim()).join(' ')
                })) };})()`);
        for (let i = 0; i < 40; i++) {
            await sleep(1000);
            panel = await readPanel();
            if (panel && panel.count >= 1 && panel.cards[0] && panel.cards[0].tempText) break;   // 温度数值元素就绪
        }
        const api = await (await fetch(BASE + '/api/ai/scenes/thermometry')).json();
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(outDir, `thermometry-ui-verify-${stamp}-${width}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        const card = (panel && panel.cards && panel.cards[0]) ||null;
        const tempText = card ? card.tempText : null;
        const apiTemp = Number(api.deviceTemperature);
        const apiHasTemp = api.deviceTemperature !== null && api.deviceTemperature !== undefined && Number.isFinite(apiTemp);
        const checks = {
            apiStatusOk: api.status === 'ok',
            apiUnitCelsius: api.unit === '°C',
            apiTempFinite: apiHasTemp,
            cardShown: !!(card && tempText),
            // 只读温度元素，与时间分离；时间里的 33 不会被当成 33°C。
            cardMatchesValue: apiHasTemp ? tempMatches(tempText, apiTemp) : false,
            cardShowsUnit: typeof tempText === 'string' && tempText.includes('°C'),
            cardTimeShown: !!(card && card.timeText && card.timeText.length > 0),
            // 自检：时间冒充温度的反例必须被拒绝（证明匹配不是模糊文本匹配）。
            decoyRejected: !tempMatches('99 °C', 33) && !tempMatches('3391 °C', 33.1),
            noExceptions: issues.length === 0
        };
        const pass = checks.apiStatusOk && checks.apiUnitCelsius && checks.apiTempFinite && checks.cardShown
            && checks.cardMatchesValue && checks.cardShowsUnit && checks.cardTimeShown
            && checks.decoyRejected && checks.noExceptions;
        return { width, url: PAGE_URL, panel, card: card ? { tempText, badText: card.badText, timeText: card.timeText } : null,
            apiStatus: { status: api.status, unit: api.unit, deviceTemperature: api.deviceTemperature,
                unitSource: api.unitSource, unitAgeMs: api.unitAgeMs, sceneTemperature: api.sceneTemperature,
                hotspots: (api.hotspots || []).length, samples: api.samples, clockSource: api.clockSource,
                timeStatus: api.timeStatus, reason: api.reason },
            checks, issues, screenshot: file, PASS: pass };
    } finally {
        await send('Page.close').catch(() => {}); ws.close();
    }
}

try {
    const results = [];
    for (const [w, h] of [[1280, 800], [1920, 1080]]) { results.push(await verifyWidth(w, h)); }
    const allPass = results.length > 0 && results.every(r => r.PASS);
    const out = { command: `node source/tools/${scriptName}`, at: new Date().toISOString(), stamp, results, PASS: allPass };
    // 另存带时间戳的新证据；同时维护 latest 指针。旧时间戳文件保留，不覆盖。
    fs.writeFileSync(path.join(outDir, `thermometry-ui-verify-${stamp}.json`), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(outDir, 'thermometry-ui-verify.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = allPass ? 0 : 1;
} catch (e) {
    console.error(String(e)); process.exitCode = 1;
}
