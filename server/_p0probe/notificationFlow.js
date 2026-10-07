/**
 * 批次 P0 验收探针 —— 驱动**真实**的 notificator 管理器，不是对复刻品断言。
 *
 * 为什么需要它：notificator 的检查趟本体（_init / _loadNotifications / _checkNotifications）
 * 是私有的，而既有测试 test/runtime/notificatorLifecycle.test.js 的 runtime 桩**没有 project
 * 也没有 alarmsMgr**，状态机停在 INIT，那三段一行也没跑到（账本 N-35 记的就是这件事）。
 * 这里把 runtime 补全，让状态机真的走到 IDLE。
 *
 * 状态机时序（实测，不是猜的）：
 *   INIT --pass1--> LOAD --pass2--> IDLE --pass3--> 第一次 _checkNotifications
 * 这是因为一条通知第一次被看见时 ontime=0，checkToNotify 只起钟不发送；
 * 而 IDLE 分支要求距上次检查 > 60 秒，所以第一次真正复查落在 pass3。
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const SERVER = path.join(__dirname, '..');
process.chdir(SERVER);

const notificator = require(path.join(SERVER, 'runtime', 'notificator'));
const notifystorage = require(path.join(SERVER, 'runtime', 'notificator', 'notifications-storage'));
const storage = require(path.join(SERVER, 'runtime', 'storage', 'databases'));
const sqlite3 = require(path.join(SERVER, 'node_modules', 'sqlite3')).verbose();

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; } else { fail++; }
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label);
    if (detail !== undefined) { console.log('        ' + detail); }
}

function makeLogger(sink) {
    const mk = (lvl) => (m) => sink.push(lvl + ': ' + m);
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: () => {} };
}

const events = (() => {
    const L = {};
    return {
        on: (n, h) => { (L[n] = L[n] || []).push(h); },
        emit: async (n, d) => { for (const h of (L[n] || [])) { await h(d); } }
    };
})();

const ALARM_ID = 'n_alarm_1';
const ALARM_KIND_ID = 'n_alarmkind_1';
const ALARM_SINGLE_ID = 'n_alarmsingle_1';
const ALARM_LOAD_ID = 'n_alarmload_1';      // 正控：库里窗口已过
const ALARM_NOLOAD_ID = 'n_alarmnoload_1';  // 负控：库里窗口没过
const ACCESS_ID = 'n_access_1';
const POST_PORT = 9711;
const POST_URL = 'http://127.0.0.1:' + POST_PORT + '/notify?c=${content}';
const ALARM_STR = 'high - 炉温超限 - N - group1';

function configs() {
    return [
        { id: ALARM_ID, name: '炉温报警邮件', type: 'alarm', enabled: true, receiver: POST_URL,
          delay: 0, interval: 0, text: '', subscriptions: { high: true }, options: null, mode: 0 },
        // 订阅键就是 AlarmsType 的成员值（highhigh/high/low/info），不是 'alarm' 之类。
        // mode=1(single) 是刻意的：index.js:288 的计时重排会跳过 single，
        // 于是这条通知的 ontime 只能来自 _loadNotifications —— 否则重排会把它覆写成"现在"，
        // 使"读回来"和"没读回来"两种情形无法区分（对照实验 B 当场抓到过这个混淆）。
        { id: ALARM_KIND_ID, name: '报警类别通知', type: 'alarm', enabled: true, receiver: POST_URL,
          delay: 0, interval: 0, text: '', subscriptions: { highhigh: true }, options: null, mode: 0 },
        // mode=1(single)：index.js:288 的计时重排明确跳过 single，于是它的 ontime
        // 只可能来自 _loadNotifications —— 重排不会替它"假造"一个值。
        { id: ALARM_SINGLE_ID, name: '单次报警通知', type: 'alarm', enabled: true, receiver: POST_URL,
          delay: 0, interval: 0, text: '', subscriptions: { highhigh: true }, options: null, mode: 1 },
        // 决定性判据 —— 一对正负控，跑在**没有活报警**的类别上，所以 index.js:284 的
        // 计时重排不会介入（那条重排会把 ontime 覆写成"现在"，从而掩盖库里读回来的值）。
        //   · 正控：delay 60 分钟 + 库里 ontime 是 2 小时前 -> 窗口已过 -> 立即发 -> notifytime ≈ 现在
        //   · 负控：delay 60 分钟 + 库里 ontime 是 1 分钟前 -> 窗口未过 -> 不发 -> notifytime 仍是 0
        // 若 _loadNotifications 是空操作：正控的 ontime=0 -> 只起钟 -> notifytime 保持 0（正控红）。
        // 若加载逻辑被写成"无脑发报"：负控会发（负控红）。
        { id: ALARM_LOAD_ID, name: '重启窗口通知', type: 'alarm', enabled: true, receiver: POST_URL,
          delay: 0, interval: 0, text: '', subscriptions: { highhigh: true }, options: null, mode: 1 },
        { id: ALARM_NOLOAD_ID, name: '重启窗口负控', type: 'alarm', enabled: true, receiver: POST_URL,
          delay: 60, interval: 0, text: '', subscriptions: { highhigh: true }, options: null, mode: 1 },
        { id: ACCESS_ID, name: '登录通知', type: 'access', enabled: true, receiver: POST_URL,
          delay: 1, interval: 0, text: '', subscriptions: {}, options: null, mode: 0 }
    ];
}

const HIGH_ALARM = () => [
    { name: 'AlarmTag', type: 'high', status: 'N', ontime: Date.now() },
    { name: 'AlarmTag2', type: 'highhigh', status: 'N', ontime: Date.now() }
];

function makeRuntime(cfg) {
    const sink = [];
    const runtime = {
        logger: makeLogger(sink), logSink: sink,
        settings: { workDir: cfg.workDir, smtp: undefined },
        events,
        project: { getNotifications: () => Promise.resolve(JSON.parse(JSON.stringify(cfg.configs))) },
        alarmValues: cfg.alarmValues || []
    };
    runtime.alarmsMgr = {
        getAlarmsValues: () => runtime.alarmValues,
        getAlarmsString: () => cfg.alarmString || ''
    };
    runtime.notificatorMgr = {
        postMessage: (url) => new Promise((resolve, reject) => {
            http.get(url, (res) => { res.resume(); res.on('end', () => resolve('ok')); }).on('error', reject);
        }),
        sendMail: () => Promise.reject(new Error('probe: SMTP 未配置（本探针不走邮件）'))
    };
    return runtime;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function db(workDir) {
    return new sqlite3.Database(storage.resolveDbFile(workDir, 'notifications', null));
}
function allRows(workDir) {
    return new Promise((resolve, reject) => {
        const d = db(workDir);
        d.all('SELECT * FROM notifications;', [], (e, r) => { d.close(); e ? reject(e) : resolve(r); });
    });
}
async function rowById(workDir, id) {
    const rows = await allRows(workDir);
    return rows.filter((r) => r.id === id)[0] || null;
}
function updateRow(workDir, id, fields) {
    return new Promise((resolve, reject) => {
        const keys = Object.keys(fields);
        const d = db(workDir);
        d.run('UPDATE notifications SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?;',
            keys.map((k) => fields[k]).concat([id]), (e) => { d.close(); e ? reject(e) : resolve(); });
    });
}

/** 一次真正的强制检查（自建 20 秒轮询计时器，跑完立刻停）。 */
async function runPass(manager) { manager.forceCheck(); await sleep(900); }

/** 走到 IDLE，再多给 n 趟，让 IDLE 分支真的跑起来。 */
async function drive(runtime, manager, extraPasses) {
    await manager.start();
    await runPass(manager);                       // INIT -> LOAD
    await runPass(manager);                       // LOAD -> IDLE
    for (let i = 0; i < (extraPasses || 1); i++) { await runPass(manager); }
    return { runtime, manager };
}

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-p0-'));
    console.log('workDir = ' + workDir);

    const hits = [];
    const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200); res.end('ok'); });
    await new Promise((r) => server.listen(POST_PORT, '127.0.0.1', r));

    try {
        console.log('');
        console.log('【0】存储层落地（走仓库已有的存储平面开点）');
        await notifystorage.init({ workDir }, makeLogger([]));
        const dbFile = storage.resolveDbFile(workDir, 'notifications', null);
        check('0.1 域库文件按单一命名规则', path.basename(dbFile) === 'notifications.scadiap.db', dbFile);
        check('0.2 落在 workDir 下（没有 _appdata/_appdata 重复一层）',
            path.dirname(dbFile) === workDir, 'dirname = ' + path.dirname(dbFile));

        // ================== 清单第 1 项：持久化 ==================
        console.log('');
        console.log('【1 / 清单第 1 项】通知能持久化（写 -> 重启 -> 读回）');

        // 1a. 活报警，让写路径被执行
        const r1 = makeRuntime({ workDir, configs: configs(), alarmValues: HIGH_ALARM(), alarmString: ALARM_STR });
        const m1 = notificator.create(r1);
        await drive(r1, m1, 1);
        const written = await rowById(workDir, ALARM_KIND_ID);
        check('1.1 检查趟把运行态写进了库（写入路径存在）',
            !!written, 'row = ' + JSON.stringify(written));
        check('1.2 写入的 ontime 是有效时间戳（> 0）',
            !!written && Number(written.ontime) > 0, 'ontime = ' + (written && written.ontime));
        await m1.stop();

        // 1b. 真重启：种入旧值 -> 全新 runtime + 全新管理器 -> 看**内存里到底是不是旧值**。
        //     直接种行（不依赖此前写过没有）。两个观察点都刻意选在
        //     index.js:288 的计时重排够不到的地方，否则重排会把 ontime 覆写成"现在"，
        //     两条路径就区分不开了：
        //       · 报警类别通知 mode=single —— 288 行的 if 明确跳过 single
        //       · access 类型通知       —— 不走 _checkNotifications，压根没有重排
        const seeded = Date.now() - 20 * 60 * 1000;             // 二十分钟前
        const seededSingle = Date.now() - 25 * 60 * 1000;       // 二十五分钟前
        const seededAccess = Date.now() - 30 * 60 * 1000;       // 三十分钟前
        const seededLoad = Date.now() - 120 * 60 * 1000;        // 2 小时前（delay 0 -> 窗口恒过）
        const seededNoLoad = Date.now() - 1 * 60 * 1000;        // 1 分钟前（delay 60 -> 窗口未过）
        const seed = (id, name, type, ontime, mode) => new Promise((resolve, reject) => {
            const d = db(workDir);
            d.run('INSERT OR REPLACE INTO notifications (id, name, type, enabled, receiver, ontime, notifytime, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
                [id, name, type, 1, POST_URL, ontime, 0, mode], (e) => { d.close(); e ? reject(e) : resolve(); });
        });
        await seed(ALARM_KIND_ID, '报警类别通知', 'alarm', seeded, '0');
        await seed(ALARM_SINGLE_ID, '单次报警通知', 'alarm', seededSingle, '1');
        await seed(ACCESS_ID, '登录通知', 'access', seededAccess, '0');
        await seed(ALARM_LOAD_ID, '重启窗口通知', 'alarm', seededLoad, '1');
        await seed(ALARM_NOLOAD_ID, '重启窗口负控', 'alarm', seededNoLoad, '1');

        // 时序：先以"无活跃报警"走完 LOAD（_loadNotifications 在此合并），再让 highhigh 变活跃。
        // 状态从无到有那一趟，index.js:289 的计时重排会再起一次钟 —— 这一趟必然不发；
        // 真正的判据在**其后**几趟：
        //   · 正控 delay=0：一旦 ontime 不是 0，下一趟就发。ontime 只可能来自库里（2 小时前）。
        //     若 _loadNotifications 是空操作 -> ontime=0 -> checkToNotify 只起钟 -> 永不发。
        //   · 负控 delay=60：ontime 同样来自库里（1 分钟前）——窗口没过，就不该发。
        const hitsBefore1b = hits.length;
        const r2 = makeRuntime({ workDir, configs: configs(), alarmValues: [], alarmString: ALARM_STR });
        const m2 = notificator.create(r2);
        await m2.start();
        await runPass(m2);     // INIT -> LOAD（_loadNotifications 在此合并）
        await runPass(m2);     // LOAD -> IDLE
        r2.alarmValues = HIGH_ALARM();
        await runPass(m2);     // IDLE：状态变更 -> 重排再起钟（这一趟必不发）
        await runPass(m2);     // IDLE：正控在此发报
        await runPass(m2);     // IDLE
        await runPass(m2);     // IDLE
        await sleep(400);

        const inMem = m2.getInMemoryNotifications();
        const single = inMem.filter((n) => n.id === ALARM_SINGLE_ID)[0];
        const access = inMem.filter((n) => n.id === ACCESS_ID)[0];
        const kind = inMem.filter((n) => n.id === ALARM_KIND_ID)[0];
        const load = inMem.filter((n) => n.id === ALARM_LOAD_ID)[0];
        const noLoad = inMem.filter((n) => n.id === ALARM_NOLOAD_ID)[0];
        check('1.3 正控：库里窗口已过的通知，重启后确实发了报（ontime 只能来自库）',
            !!load && Number(load.notifytime) > 0 && Math.abs(Number(load.notifytime) - Date.now()) < 120000,
            'notifytime = ' + (load && load.notifytime) + '（若 _loadNotifications 是空操作，这里会是 0）');
        check('1.3b 负控：库里窗口**未**过的通知没有发报（排除"无脑发报"式假绿）',
            !!noLoad && Number(noLoad.notifytime) === 0,
            'notifytime = ' + (noLoad && noLoad.notifytime) + '（应当为 0）');
        // 正控与负控的 name 不同，但收件人 URL 一样；用"本条通知自身是否发出"计数：
        // 正控订阅在 highhigh、负控也在 highhigh，所以看 notifytime 才准；
        // 这里只做外部旁证：重启段确实发生了投递。
        const loadHits = hits.slice(hitsBefore1b).map((u) => decodeURIComponent(u));
        check('1.3c 外部旁证：重启段确实观察到投递（正控发出）',
            loadHits.length > 0, '重启段投递 ' + loadHits.length + ' 条');
        check('1.4 重启后 access 通知：内存 ontime = 库里的旧值',
            !!access && Math.abs(Number(access.ontime) - seededAccess) < 100,
            '内存 ontime = ' + (access && access.ontime) + '，种入 ' + seededAccess);
        check('1.6 对照：mode=0 那条仍会被计时重排覆写成"现在"（这正是它不可用作判据的原因）',
            !!kind && Math.abs(Number(kind.ontime) - Date.now()) < 30000,
            '内存 ontime = ' + (kind && kind.ontime) + ' = 约现在（种入 ' + seeded + '）');
        await m2.stop();

        // ================== 清单第 2 项：报警触发 ==================
        console.log('');
        console.log('【2 / 清单第 2 项】报警触发（用非邮箱收件人走 postMessage，绕开 SMTP）');
        const hitsBefore2 = hits.length;
        const r3 = makeRuntime({ workDir, configs: configs(), alarmValues: HIGH_ALARM(), alarmString: ALARM_STR });
        const m3 = notificator.create(r3);
        await drive(r3, m3, 2);
        await sleep(500);
        check('2.1 通知真的发了出去（本地 HTTP 服务收到请求）',
            hits.length > hitsBefore2, '新增 = ' + JSON.stringify(hits.slice(hitsBefore2)));
        const decoded = hits.slice(hitsBefore2).map((u) => decodeURIComponent(u));
        check('2.2 载荷是报警摘要（${content} 被真实摘要替换）',
            decoded.some((u) => u.indexOf('high') !== -1 && u.indexOf('炉温超限') !== -1),
            '示例 = ' + (decoded[0] || '(无)'));
        const fired = await rowById(workDir, ALARM_KIND_ID);
        check('2.3 发送成功后 notifytime 落库（不是只动内存）',
            !!fired && Number(fired.notifytime) > 0, 'notifytime = ' + (fired && fired.notifytime));
        await m3.stop();

        // ================== 清单第 3 项：登录通知 ==================
        console.log('');
        console.log('【3 / 清单第 3 项】登录通知（access 事件通道）');
        const r4 = makeRuntime({ workDir, configs: configs(), alarmValues: [], alarmString: '' });
        const m4 = notificator.create(r4);
        await drive(r4, m4, 1);
        const hitsBefore3 = hits.length;
        await events.emit('access:login', { username: 'probe_user' });
        await sleep(500);
        const newHits = hits.slice(hitsBefore3).map((u) => decodeURIComponent(u));
        check('3.1 access:login 触发了一次投递', newHits.length > 0, JSON.stringify(newHits));
        check('3.2 载荷带上了用户名', newHits.some((u) => u.indexOf('probe_user') !== -1), JSON.stringify(newHits));
        const hitsBefore4 = hits.length;
        await events.emit('access:logout', { username: 'probe_user' });
        await sleep(500);
        check('3.3 access:logout 同样触发',
            hits.length > hitsBefore4,
            JSON.stringify(hits.slice(hitsBefore4).map((u) => decodeURIComponent(u))));
        await m4.stop();

        // ================== 清单第 4 项：历史 ==================
        console.log('');
        console.log('【4 / 清单第 4 项】通知历史（直接查库）');
        const rows = await allRows(workDir);
        check('4.1 库里有记录', rows.length > 0, 'rows = ' + rows.length);
        check('4.2 记录含 ontime / notifytime 两列',
            rows.length > 0 && rows.every((r) => 'ontime' in r && 'notifytime' in r),
            '列 = ' + JSON.stringify(Object.keys(rows[0] || {})));
        console.log('        全部行：' + JSON.stringify(rows));

        // ================== 清单第 5 项：清除历史 ==================
        console.log('');
        console.log('【5 / 清单第 5 项】clearNotifications(true) 清空');
        const r5 = makeRuntime({ workDir, configs: configs(), alarmValues: HIGH_ALARM(), alarmString: ALARM_STR });
        const m5 = notificator.create(r5);
        await drive(r5, m5, 1);
        const cleared = await m5.clearNotifications(true);
        const rowsAfter = await allRows(workDir);
        // 既有测试把这个方法的返回钉成 undefined（notificatorLifecycle.test.js:110）。
        // 任务卡写的 resolve(true) 会与那条断言冲突，故按既有契约保留 undefined。
        check('5.1 clearNotifications(true) 按既有契约解析为 undefined（不抛）',
            cleared === undefined, 'returned = ' + JSON.stringify(cleared));
        check('5.2 库真的空了', rowsAfter.length === 0, 'rows after = ' + rowsAfter.length);
        await m5.stop();

        // ============ 附：卡 §3「清除历史」标准自身的问题（实测） ============
        console.log('');
        console.log('【6】卡 §3「清除历史」若指 reset() 路径，则永远不可能清空（实测）');
        const r6 = makeRuntime({ workDir, configs: configs(), alarmValues: HIGH_ALARM(), alarmString: ALARM_STR });
        const m6 = notificator.create(r6);
        await drive(r6, m6, 1);
        const beforeReset = (await allRows(workDir)).length;
        m6.reset();                 // 置 clearNotifications = true
        await drive(r6, m6, 1);     // _loadNotifications 走 clearNotifications() 分支（不传 all）
        const rowsAfterReset = await allRows(workDir);
        check('6.1 reset() 路径按卡的原样保留（不传 all），只删 7 天前的行',
            rowsAfterReset.length > 0,
            'reset 前 ' + beforeReset + ' 行 -> reset 后 ' + rowsAfterReset.length + ' 行（notifytime 都是刚才的，删不掉）');
        await m6.stop();

    } finally {
        server.close();
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* sqlite3 句柄可能还持有 */ }
    }

    console.log('');
    console.log('================ P0 验收合计：' + pass + ' passing / ' + fail + ' failing ================');
    process.exitCode = fail ? 1 : 0;
    global.__P0_DONE = true;
}

main().catch((err) => { console.error('PROBE CRASHED:', err); process.exitCode = 2; });

// 存储平面持有 sqlite3 句柄，事件循环不会自己空掉（test:storage 因此带 --exit）。
// 探针是脚本不是套件，直接显式退出，退出码照上面算好的来。
global.__P0_DONE = false;
setInterval(() => { if (global.__P0_DONE) { process.exit(process.exitCode || 0); } }, 500);