/**
 * 发布前凭据扫描：找出硬编码的密钥/口令。
 *
 * 用法：node tools/scan-secrets.cjs [目录]      （默认 = 本仓根）
 *       在 server/ 下：npm run test:secrets      （发布前对发布树跑一次）
 *
 * 退出码：0 = 没有阻断项（提示项会打印但不算失败）；1 = 有阻断项，**不要发布**。
 *
 * 为什么有分档：这个脚本原来把命中打印出来就 return 0，等于没有一个能挂进发布流程的信号；
 * 而它同时又会报出 settings.default.js 里的演示口令（'12345678'）一类东西 —— 如果一律当失败，
 * 脚本会被绕过。所以按「一条字符串是不是真的凭据」分档：
 *   block 高信号特征（GitHub/OpenAI/AWS token、私钥、Bearer、**裸 SECRET 常量**）
 *   info  口令类赋值（多为占位符/演示默认值，需要人看一眼）
 * 两种都打印、都要人复核，但只有 block 决定退出码。
 */
'use strict';
const fs = require('fs'), path = require('path');
const root = process.argv[2] || path.resolve(__dirname, '..', '..');  // 默认扫「包含本文件的那棵树的根」
if (!root) {
    console.error('用法：node tools/scan-secrets.cjs [目录]   （默认=本仓根；也可 npm run test:secrets）');
    process.exit(2);
}

const PATTERNS = [
    { name: 'secretCode 赋值', sev: 'info', re: /secretCode\s*[:=]\s*['"][^'"]{3,}['"]/g },
    { name: 'password 赋值', sev: 'info', re: /password\s*[:=]\s*['"][^'"]{3,}['"]/gi },
    { name: 'apiKey 赋值', sev: 'info', re: /api[_-]?key\s*[:=]\s*['"][^'"]{10,}['"]/gi },
    // 裸常量：const SECRET = '...' / JWT_SECRET: '...' —— 这一类原来完全不在规则表里，
    // 而公开仓库里真有一处厂商历史签名密钥就是这样写着的（heartbeatSecurity.test.js）。
    { name: '裸 SECRET 常量', sev: 'block', re: /(?:^|[^\w$."'])(?:JWT_|APP_|AUTH_|API_)?SECRET\s*[:=]\s*['"][^'"]{6,}['"]/gim },
    { name: 'GitHub token', sev: 'block', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
    { name: 'OpenAI key', sev: 'block', re: /sk-[A-Za-z0-9]{20,}/g },
    { name: 'AWS key', sev: 'block', re: /AKIA[0-9A-Z]{16}/g },
    { name: '私钥', sev: 'block', re: /BEGIN [A-Z ]*PRIVATE KEY/g },
    { name: 'Bearer token', sev: 'block', re: /Bearer\s+[A-Za-z0-9._-]{25,}/g }
];

// 一眼就是占位/测试值，不是凭据。只对 block 类放宽，info 类照报。
// 判据是「这条字符串有没有自报家门」。真实凭据是随机串，不会以 -secret / -password 结尾，
// 也不会自称 test/dummy/example。放宽的只是 block 类：命中的仍然打印、仍然要人复核。
const PLACEHOLDER = /^(<[^>]*>|\$\{.*|\{\{.*)$|test[-_]?only|not-a-credential|change[-_]?me|changeme|your[-_]|dummy|example|sample|placeholder|redacted|xxx|\*{3,}|[-_](secret|password|key)$|^(password|passwd|secret|jwt-secret|wrong-password|hash|abc|foo|bar)$|^\$2[aby]\$|^\d{4,}$/i;

const SKIP = /node_modules|[\/]dist[\/]|[\/]\.git[\/]|\.map$|package-lock\.json$/;
const out = [];
const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries) {
        const p = path.join(d, e.name);
        if (SKIP.test(p)) continue;
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(js|ts|json|md|yml|yaml|ps1|sh|html|css|cjs|mjs)$/i.test(e.name)) continue;
        let t; try { t = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
        for (const pat of PATTERNS) {
            pat.re.lastIndex = 0;
            let m;
            while ((m = pat.re.exec(t)) !== null) {
                const line = t.slice(0, m.index).split('\n').length;
                const value = (m[0].match(/['"]([^'"]*)['"]/) || [null, ''])[1];
                const sev = (pat.sev === 'block' && PLACEHOLDER.test(value)) ? 'info' : pat.sev;
                out.push({ file: path.relative(root, p), line, kind: pat.name, sev, text: m[0].trim().slice(0, 100) });
            }
        }
    }
};
walk(root);

const blocking = out.filter(h => h.sev === 'block');
console.log('命中 ' + out.length + ' 处（阻断 ' + blocking.length + ' / 提示 ' + (out.length - blocking.length) + '）：');
for (const h of out) console.log('  [' + h.sev + '] ' + h.file + ':' + h.line + '  [' + h.kind + ']  ' + h.text);
if (blocking.length) {
    console.log('\n❌ 阻断项 ' + blocking.length + ' 处 —— 处理前不要发布。');
    process.exit(1);
}
console.log('\n✅ 无阻断项。（提示项仍需人工确认不是真凭据）');