'use strict';
/**
 * 相机事件桥接器：把相机自带的事件（遮挡/区域入侵/越界/移动/网络）送进平台的 AI 检测通道。
 *
 * 为什么用相机自带事件：这台相机原生支持 tamper/field/line/VMD（已实测），零 CPU 开销；
 * 类别级识别（安全帽/聚集/跌倒）它做不了，那部分留给外部模型。
 *
 * 数据流：相机 /ISAPI/Event/notification/alertStream --curl(digest)--> 本程序
 *        --> POST /api/ai/events （平台灌入口）--> 画面画框 + 报警联动 + 计数
 *
 * 配置：project/_appdata/video-events.json
 *   { "platform": "http://127.0.0.1:1881", "user": "admin", "password": "123456",
 *     "cameraId": "cam_...", "holdMs": 8000, "debounceMs": 8000,
 *     "camera": { "host": "192.168.110.21", "user": "admin", "password": "..." } }
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CFG = process.argv[2] || path.join(__dirname, '..', '..', 'project', '_appdata', 'video-events.json');
const COUNTERS = path.join(path.dirname(CFG), 'video-events-count.json');
// 相机的事件名来自 /ISAPI/Event/triggers 的 <eventType>。这里必须**逐字**对上，
// 否则事件会被当成本地未知类型静默记进另一个桶 —— 实测踩过：相机的遮挡事件名是
// 'tamperdetection'，而本表原先只有 'tamper'，于是"遮挡报警永远为 0"，看着像功能没做。
const LABELS = {
  // 实测：这台 DS-2ZCN3007(D) 在 alertStream 上把遮挡事件叫 **shelteralarm**，
  // 而 /ISAPI/Event/triggers 里写的是 tamperdetection —— 两处不一致，只有抓原始流才发现。
  // 三个名字都留着，别的地方的机型任取其一。
  shelteralarm: '遮挡报警', tamperdetection: '遮挡报警', tamper: '遮挡报警',
  fielddetection: '区域入侵', linedetection: '越界',
  VMD: '移动侦测', motiondetection: '移动侦测',
  videoloss: '视频丢失', badvideo: '视频丢失',
  audioexception: '音频异常', storageDetection: '存储异常',
  nicbroken: '网络断开', ipconflict: 'IP 冲突', illaccess: '非法访问',
  videomismatch: '视频不匹配'
};
// 计数桶：多个原始事件名可以归到同一个业务桶，画面脚本按桶读数。
const BUCKET = {
  shelteralarm: 'tamper', tamperdetection: 'tamper', tamper: 'tamper',
  motiondetection: 'VMD', VMD: 'VMD',
  fielddetection: 'fielddetection', linedetection: 'linedetection',
  videoloss: 'videoloss', badvideo: 'videoloss'
};
const KNOWN = new Set(Object.keys(LABELS));
const warned = {};

function log(m) { console.log(new Date().toISOString().slice(11, 19) + ' [bridge] ' + m); }
function cfg() { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return null; } }

function bump(kind) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(COUNTERS, 'utf8')); } catch (e) { }
  const day = new Date().toISOString().slice(0, 10);
  all[day] = all[day] || {};
  all[day][kind] = (all[day][kind] || 0) + 1;
  try { fs.writeFileSync(COUNTERS, JSON.stringify(all, null, 1), 'utf8'); } catch (e) { }
  // 同一份计数另外写进 _images（平台静态目录，画面脚本无需鉴权即可读）
  try {
    const pub = path.join(path.dirname(CFG), '..', '_images', 'ai-counts.json');
    const kinds = {};
    for (const d of Object.keys(all)) { for (const k of Object.keys(all[d])) { kinds[k] = (kinds[k] || 0) + all[d][k]; } }
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(pub, JSON.stringify({ today: today, byKind: (all[today] || {}), total: kinds, updatedAt: Date.now() }, null, 1), 'utf8');
  } catch (e) { }
}

// ---------------------------------------------------------------- 报警抓拍
// 报警发生时存一张相机快照，供画面"报警图片预览"用。
// 两个必须的约束：
//   1) 节流 —— 移动侦测一天能报两百多次，不节流会把相机和磁盘一起打死
//   2) 保留上限 —— 只留最近 N 张 + 只留最近若干天，否则无人值守的机器迟早撑爆
const SHOTS_DIR = path.join(path.dirname(CFG), '..', '_images', 'alarm-shots');
const SHOTS_INDEX = path.join(SHOTS_DIR, 'index.json');
let lastShotAt = 0;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function captureShot(c, kind, label) {
  const now = Date.now();
  const gap = Number(c.shotMinGapMs || 20000);
  if (now - lastShotAt < gap) { return; }
  lastShotAt = now;
  try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch (e) { }
  const d = new Date(now);
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  const file = stamp + '-' + kind + '.jpg';
  const out = path.join(SHOTS_DIR, file);
  const ch = c.camera.shotChannel || '102';
  const url = 'http://' + c.camera.host + '/ISAPI/Streaming/channels/' + ch + '/picture';
  const cp = spawn('curl.exe', ['-s', '--noproxy', '*', '--digest', '-u',
    (c.camera.user || 'admin') + ':' + (c.camera.password || ''), '--max-time', '8', url, '-o', out],
    { stdio: 'ignore', env: Object.assign({}, process.env, { no_proxy: '*', NO_PROXY: '*', all_proxy: '', ALL_PROXY: '' }) });
  cp.on('exit', code => {
    let size = 0;
    try { size = fs.statSync(out).size; } catch (e) { size = 0; }
    if (code !== 0 || size < 1000) {
      try { fs.unlinkSync(out); } catch (e) { }
      log('抓拍失败（curl ' + code + '，' + size + ' 字节）');
      return;
    }
    try {
      let idx = { shots: [] };
      try { idx = JSON.parse(fs.readFileSync(SHOTS_INDEX, 'utf8')); } catch (e) { }
      idx.shots = (idx.shots || []).filter(s => s.file !== file);
      idx.shots.unshift({
        file: file,
        url: '/_images/alarm-shots/' + file,
        at: now,
        kind: kind,
        label: label,
        alarm: '视频报警^~^highhigh'
      });
      const keep = Number(c.shotKeep || 200);
      if (idx.shots.length > keep) { idx.shots = idx.shots.slice(0, keep); }
      const cutoff = now - Number(c.shotKeepDays || 7) * 86400000;
      const kept = [];
      for (const s of idx.shots) {
        if (s.at < cutoff) { try { fs.unlinkSync(path.join(SHOTS_DIR, s.file)); } catch (e) { } }
        else { kept.push(s); }
      }
      idx.shots = kept;
      idx.updatedAt = now;
      fs.writeFileSync(SHOTS_INDEX, JSON.stringify(idx, null, 1), 'utf8');
      log('已抓拍 ' + label + ' -> ' + file + '（' + Math.round(size / 1024) + 'KB，共 ' + idx.shots.length + ' 张）');
    } catch (e) { log('抓拍索引写入失败: ' + e.message); }
  });
}

// ---------------------------------------------------------------- 电子围栏发布
// 围栏多边形在相机里（FieldDetection 区域 1），画面看不到。把配置和"刚刚触发"的状态
// 一起写到静态文件，画面脚本读它就能画出围栏并在触发时高亮 —— 全程零平台 API 开销。
const FENCE_FILE = path.join(path.dirname(CFG), '..', '_images', 'ai-fence.json');

function publishFence(c, activeKind) {
  // 围栏多边形要【现读】配置：c 是启动时冻结的对象，改过 video-events.json 后
  // 旧 c 会把旧坐标一遍遍写回 ai-fence.json，画面上的框永远缩不小（实测踩过）。
  c = cfg() || c;
  try {
    const fence = c.fence || { points: [], scale: 1000, highlightMs: 3000 };
    const prev = (() => { try { return JSON.parse(fs.readFileSync(FENCE_FILE, 'utf8')); } catch (e) { return {}; } })();
    const out = {
      camera: c.cameraId || null,
      scale: fence.scale || 1000,
      points: fence.points || [],
      label: fence.label || '电子围栏',
      highlightMs: fence.highlightMs || 3000,
      activeKind: activeKind || null,
      activeAt: activeKind ? Date.now() : (prev.activeAt || 0),
      updatedAt: Date.now()
    };
    fs.writeFileSync(FENCE_FILE, JSON.stringify(out, null, 1), 'utf8');
  } catch (e) { log('围栏发布失败: ' + e.message); }
}

let token = null;
function signin(c, cb) {
  const body = JSON.stringify({ username: c.user || 'admin', password: c.password || '' });
  const req = http.request({ host: '127.0.0.1', port: 1881, path: '/api/signin', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
    let d = ''; res.on('data', x => d += x); res.on('end', () => { try { token = JSON.parse(d).data.token; log('已登录平台，token 就绪'); } catch (e) { log('登录失败: ' + d.slice(0, 120)); } cb && cb(); });
  });
  req.on('error', e => { log('登录请求错误: ' + e.message); cb && cb(); });
  req.write(body); req.end();
}

function send(c, payload) {
  const body = JSON.stringify(payload);
  const opt = { host: '127.0.0.1', port: 1881, path: '/api/ai/events', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
  if (token) { opt.headers['x-access-token'] = token; }
  const req = http.request(opt, res => {
    let d = ''; res.on('data', x => d += x); res.on('end', () => {
      if (res.statusCode === 401) { signin(c, () => send(c, payload)); return; }
      const what = (payload.detections && payload.detections[0]) ? payload.detections[0].label : (payload.type === 'end' ? '(清除)' : '(无检测项)');
      log('灌入 ' + what + ' -> ' + res.statusCode + ' ' + d.slice(0, 140));
    });
  });
  req.on('error', e => log('灌入失败: ' + e.message));
  req.write(body); req.end();
}

const last = {};
const active = {};
function onEvent(c, kind, state) {
  // 现读配置：debounceMs 是现场会反复调的参数（延迟优化），冻结在启动时刻的话
  // 每改一次 video-events.json 都得重启桥接器才生效（和 publishFence 同一个坑）。
  c = cfg() || c;
  // 字典里没有的事件名**不许静默**：打一次日志，人就看得见"有个事件类型没被接住"。
  if (!KNOWN.has(kind) && !warned[kind]) {
    warned[kind] = true;
    log('⚠ 未识别的事件类型: ' + kind + '（字典里没有，已按原名上报；若该类型应显示中文名，请补进 LABELS）');
  }
  const label = LABELS[kind] || kind;
  const bucket = BUCKET[kind] || 'other';
  const now = Date.now();
  if (state === 'inactive') {
    // 相机每 ~10 秒会发一次 inactive 的周期性通知（实测 videoloss）。只有我们确实报过
    // active 的那种事件才需要发清除，否则就是白白的空转流量。
    if (!active[kind]) { return; }
    active[kind] = false;
    setTimeout(() => send(c, { camera: c.cameraId, type: 'end' }), 300);
    log('事件结束: ' + label + '（' + kind + '）');
    return;
  }
  const db = Number(c.debounceMs || 8000);
  if (last[kind] && now - last[kind] < db) { return; }
  last[kind] = now;
  active[kind] = true;
  bump(bucket);
  log('事件触发: ' + label + '（' + kind + ' -> 桶 ' + bucket + '，今日累计已记）');
  captureShot(c, kind, label);
  publishFence(c, bucket);
  send(c, {
    camera: c.cameraId,
    imageWidth: 1920, imageHeight: 1080,
    detections: [{ label: label, score: 1, region: { x: 0, y: 0, w: 1, h: 1 }, normalized: true, timestamp: now }]
  });
}

function parseChunk(chunk) {
  const events = [];
  let p = 0;
  while (true) {
    const a = chunk.indexOf('<EventNotificationAlert', p);
    if (a < 0) break;
    const b = chunk.indexOf('</EventNotificationAlert>', a);
    if (b < 0) break;
    const xml = chunk.slice(a, b);
    p = b + 1;
    const grab = (tag) => { const s = xml.indexOf('<' + tag + '>'); if (s < 0) return null; const e = xml.indexOf('</' + tag + '>', s); return e < 0 ? null : xml.slice(s + tag.length + 2, e).trim(); };
    events.push({ kind: grab('eventType'), state: grab('eventState') || 'active' });
  }
  return events;
}

let proc = null;
let backoffMs = 5000;
function startStream(c) {
  const url = 'http://' + c.camera.host + '/ISAPI/Event/notification/alertStream';
  // 关键：局域网相机必须直连。机器上若设了全局代理（例如 Clash 7897），
  // curl 会把 http://192.168.x.x 也送到代理去，长连接事件流会被代理反复掐断
  //（实测每 2 秒断一次、事件大量漏收、统计全不准）。--noproxy '*' 让它对相机直连。
  proc = spawn('curl.exe', ['-s', '-N', '--noproxy', '*', '--digest', '-u', (c.camera.user || 'admin') + ':' + (c.camera.password || ''), '--max-time', '0', url], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { no_proxy: '*', NO_PROXY: '*', all_proxy: '', ALL_PROXY: '' }) });
  log('已连接相机事件流: ' + url);
  backoffMs = 5000;
  // 单条事件解析/上报异常绝不允许把桥接器打死：现场是无人值守的。
  proc.stdout.on('data', buf => {
    try {
      for (const ev of parseChunk(buf.toString())) { if (ev.kind) { onEvent(c, ev.kind, ev.state); } }
    } catch (e) { log('解析事件失败（已忽略）: ' + e.message); }
  });
  proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) { log('curl: ' + t.slice(0, 120)); } });
  // 退避重连：相机对 HTTP 会话数有限制，刚断开就立刻重连会互相踩（实测 curl 退出码 7 反复出现，
  // 每次只连上约 2 秒，事件大量漏掉）。所以退避逐步拉长到 15 秒，连上后自动归零。
  proc.on('exit', code => {
    proc = null;
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs + 5000, 15000);
    log('事件流断开(' + code + ')，' + Math.round(wait / 1000) + ' 秒后重连（退避 ' + Math.round(backoffMs / 1000) + 's）');
    setTimeout(() => startStream(c), wait);
  });
}

const c = cfg();
if (c && c.camera && c.camera.host) { publishFence(c, null); }
if (!c || !c.camera || !c.camera.host) {
  log('缺少配置 ' + CFG + '（需要 camera.host 与 cameraId）');
  process.exit(1);
}
signin(c, () => startStream(c));
process.on('SIGTERM', () => { if (proc) { proc.kill(); } process.exit(0); });