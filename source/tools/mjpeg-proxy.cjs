'use strict';
/**
 * 实时视频代理（MJPEG）：把相机的 RTSP 转成浏览器能直接显示的 MJPEG 流。
 *
 * 为什么需要它：相机抓拍接口每帧要 ~0.36 秒（最多约 2 帧/秒），画面会卡、会不同步；
 * RTSP 拉流实测 28 帧/秒，转 MJPEG 后 10~25 帧/秒，画面才连续。
 * 一个源只拉一次 RTSP，多个画面窗共享同一路流（扇出给所有连接）。
 *
 * 配置：project/_appdata/mjpeg-sources.json
 *   { "sources": [ { "name": "kuangqu1", "rtsp": "rtsp://user:pass@ip:554/Streaming/Channels/102", "fps": 10 } ] }
 * 访问：http://<主机>:<端口>/mjpeg/<name>   （画面里把视频窗的图片地址指向它）
 *       http://<主机>:<端口>/tile/<name>    （极简页面，便于 iframe 内嵌）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SCADIA_MJPEG_PORT || 1886);
const cfgPath = process.argv[2] || path.join(__dirname, '..', '..', 'project', '_appdata', 'mjpeg-sources.json');
const FFMPEG = process.env.SCADIA_FFMPEG || 'ffmpeg';

function loadSources() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return (j && j.sources) ? j.sources.filter(s => s && s.name && s.rtsp) : [];
  } catch (e) { console.log('[mjpeg] 配置读取失败 ' + cfgPath + ': ' + e.message); return []; }
}

const sources = new Map();
function ensureSource(s) {
  if (sources.has(s.name)) { return sources.get(s.name); }
  const st = { name: s.name, rtsp: s.rtsp, fps: String(s.fps || 20), clients: new Set(), frames: 0, since: Date.now(), proc: null };
  sources.set(s.name, st);
  startFfmpeg(st);
  return st;
}

function startFfmpeg(st) {
  // 低延迟参数是必须的：ffmpeg 拉 RTSP 默认会缓冲 1~3 秒，画面会“慢半拍”。
  // nobuffer/low_delay + 小 probesize + 不分析时长，能把延迟压到几百毫秒级。
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    // 注意：probesize/analyzeduration 调太小会让 RTSP 解复用器认不出流，
    // ffmpeg 会以 “Output file does not contain any stream” 启动失败（实测踩过）。
    '-rtsp_transport', 'tcp',
    '-i', st.rtsp,
    '-an',
    '-c:v', 'mjpeg', '-q:v', '5', '-r', st.fps,
    '-f', 'mpjpeg', '-'
  ];
  st.proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // 按边界切出“完整帧”，并且**给慢客户端丢帧**：
  // 无脑把每个字节写进连接会让 Node 的发送缓冲越堆越多，画面就会越落越后
  //（现象：手已经拿开了，画面才显示手移过来）。丢帧换来的是延迟恒定。
  let pending = Buffer.alloc(0);
  const BOUND = '--ffmpeg';
  const MAX_BUFFERED = 256 * 1024;
  st.proc.stdout.on('data', d => {
    pending = Buffer.concat([pending, d]);
    let idx = pending.indexOf(BOUND, 1);
    while (idx > 0) {
      const frame = pending.slice(0, idx);
      pending = pending.slice(idx);
      st.frames++;
      for (const res of st.clients) {
        try {
          if (res.writableLength > MAX_BUFFERED) { st.lagged = (st.lagged || 0) + 1; continue; }
          res.write(frame);
        } catch (e) { }
      }
      idx = pending.indexOf(BOUND, 1);
    }
    if (pending.length > 4 * 1024 * 1024) { pending = Buffer.alloc(0); }
  });
  st.proc.stderr.on('data', d => { const t = d.toString().trim(); if (t) console.log('[mjpeg:' + st.name + '] ' + t.slice(0, 160)); });
  st.proc.on('error', e => console.log('[mjpeg:' + st.name + '] ffmpeg 启动失败: ' + e.message));
  st.proc.on('exit', code => { st.proc = null; console.log('[mjpeg:' + st.name + '] ffmpeg 退出 ' + code + '，1.5 秒后重连'); setTimeout(() => startFfmpeg(st), 1500); });
  console.log('[mjpeg:' + st.name + '] 已启动 ' + st.rtsp.replace(/:[^:@/]*@/, ':***@') + '  fps=' + st.fps);
}

http.createServer((req, res) => {
  const m = /^\/(mjpeg|tile)\/([A-Za-z0-9_-]+)/.exec(req.url || '');
  if (!m) {
    if ((req.url || '').indexOf('/stats') === 0) {
      const out = { port: PORT, sources: {} };
      // clientIds: 画面脚本用 ?c=<窗 id> 自报身份；页面读这个名单判断"我这条连接是不是已经死了"
      // （实测：Chrome 对断掉的 MJPEG 流永不自动重连，只能靠页面自己发现并换地址重连）
      for (const [k, v] of sources) { out.sources[k] = { clients: v.clients.size, clientIds: Array.from(v.clients).map(c => c.__cid).filter(Boolean), frames: v.frames, seconds: Math.round((Date.now() - v.since) / 1000), fps: Math.round(v.frames / Math.max(1, (Date.now() - v.since) / 1000) * 10) / 10 }; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(out)); return;
    }
    res.writeHead(404); res.end('not found'); return;
  }
  const kind = m[1], name = m[2];
  const def = loadSources().find(s => s.name === name);
  if (!def) { res.writeHead(404); res.end('source not configured: ' + name); return; }
  const st = ensureSource(def);
  if (kind === 'tile') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#000;overflow:hidden}img{width:100%;height:100%;object-fit:cover;display:block}</style></head><body><img src="/mjpeg/' + name + '"></body></html>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg', 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  res.__cid = (/[?&]c=([A-Za-z0-9_-]{1,24})/.exec(req.url || '') || [])[1] || '';
  st.clients.add(res);
  req.on('close', () => st.clients.delete(res));
}).listen(PORT, '0.0.0.0', () => {
  const list = loadSources().map(s => s.name).join(', ') || '(配置里没有源)';
  console.log('[mjpeg] 代理已启动 :' + PORT + '  可用源: ' + list);
});