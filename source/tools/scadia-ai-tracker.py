# -*- coding: utf-8 -*-
"""
开诚智枢 SCADIA · 人体检测与轨迹追踪服务（外部 AI 引擎）

为什么需要它：现场那台相机（海康 DS-2ZCN3007(D)）实测 isSupportPeopleDetection=false、
无智能跟踪、无聚集、无人脸 —— 它只能报"有没有事件"，给不了"人在哪、走过哪条线"。
要真正的检测框和人的轨迹，必须外接模型。本服务就是那一路。

数据流：
    RTSP 子码流 --> YOLOv8 人体检测 + ByteTrack 追踪 --> POST /api/ai/events
    （平台侧零改动：把 trackId 放进 detection.id，normalize.js 的白名单里有 id）

可移植性（这是硬要求：本机无 N 卡，将来要移植到有显卡的工作站）：
  * device = "auto" 时自动探测 CUDA，有卡用卡、没卡用 CPU；可显式指定 "cpu" / "cuda" / "0"
  * 没有任何写死的机器路径：一切相对【配置文件】解析
  * 模型文件缺失时自动下载；也可指定本地路径
  * Windows / Linux 通用（pathlib）
  * 有 GPU 的工作站上装 CUDA 版 torch 即可，本文件不用改：
        pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
        pip install ultralytics opencv-python

配置：project/_appdata/ai-tracker.json（与 mjpeg-sources.json / video-events.json 并列）
用法：python scadia-ai-tracker.py [配置文件路径]
"""

import json
import os
import sys
import time
import threading
from pathlib import Path
from urllib import error as urllib_error

try:
    import cv2
    from ultralytics import YOLO
except Exception as e:  # 依赖缺失时给出人能看懂的提示，而不是堆栈
    sys.stderr.write('[tracker] 缺少依赖：%s\n' % e)
    sys.stderr.write('[tracker] 请先执行：pip install ultralytics opencv-python\n')
    sys.exit(2)


# --------------------------------------------------------------------- 配置

DEFAULTS = {
    "platform": "http://127.0.0.1:1881",
    "user": "admin",
    "password": "123456",
    "cameraId": None,
    "model": "yolov8n.pt",
    "device": "auto",          # auto | cpu | cuda | 0
    "imgsz": 640,
    "conf": 0.35,
    "iou": 0.5,
    "classes": [0],            # COCO 0 = person
    "label": "人员",
    "targetFps": 8,            # 处理帧率（CPU 上 8fps 留足余量；有卡可提到 15~25）
    # 上报平台的频率。平台 API 限流是 1000 次 / 5 分钟（apiRateLimitMax），**所有客户端共享**，
    # 浏览器画面也要用这份配额。所以这里必须低频：1Hz = 300 次/5 分钟，安全。
    # 高频数据走 project/_images/ai-tracks.json 静态文件（不受限流），画面脚本读它。
    "pushHz": 1,
    "tracker": "bytetrack.yaml",
    "endAfterMs": 2000,        # 视野内连续无目标这么久，就通知平台清框
    "reconnectMs": 5000,
    "debugDir": None,          # 设了就落盘带框的调试图
    "debugEvery": 30,
}


def log(m):
    sys.stdout.write('%s [tracker] %s\n' % (time.strftime('%H:%M:%S'), m))
    sys.stdout.flush()


def load_cfg():
    here = Path(__file__).resolve().parent
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else (here / '..' / '..' / 'project' / '_appdata' / 'ai-tracker.json')
    path = path.resolve()
    cfg = dict(DEFAULTS)
    if path.exists():
        try:
            cfg.update(json.loads(path.read_text(encoding='utf-8')))
            log('配置已载入：%s' % path)
        except Exception as e:
            log('配置解析失败，改用默认值：%s' % e)
    else:
        log('未找到配置 %s，改用默认值' % path)
    cfg['_cfgDir'] = str(path.parent)
    src = cfg.get('source') or {}
    if not src.get('rtsp'):
        src['rtsp'] = 'rtsp://%s:%s@%s:554/Streaming/Channels/102' % (
            (cfg.get('camera') or {}).get('user', 'admin'),
            (cfg.get('camera') or {}).get('password', ''),
            (cfg.get('camera') or {}).get('host', '192.168.110.21'))
    cfg['source'] = src
    return cfg


def resolve_model(cfg):
    """模型路径：显式路径优先 -> 配置文件目录 -> 内置名（ultralytics 会自动下载）。"""
    m = str(cfg.get('model') or 'yolov8n.pt')
    p = Path(m)
    if p.is_absolute() and p.exists():
        return str(p)
    cand = Path(cfg['_cfgDir']) / m
    if cand.exists():
        return str(cand)
    here = Path(__file__).resolve().parent
    cand2 = here / m
    if cand2.exists():
        return str(cand2)
    return m  # 交给 ultralytics 下载到当前目录


def pick_device(cfg):
    want = str(cfg.get('device') or 'auto').lower()
    if want != 'auto':
        return want, 'config'
    try:
        import torch
        if torch.cuda.is_available():
            return 'cuda', 'cuda:%s' % torch.cuda.get_device_name(0)
        return 'cpu', 'no CUDA device'
    except Exception as e:
        return 'cpu', 'torch unavailable (%s)' % e


# ------------------------------------------------------------------ 平台通信

class Platform(object):
    """平台灌入口。401 时自动重新登录并重发一次，现场无人值守。"""

    def __init__(self, cfg):
        self.base = str(cfg.get('platform') or DEFAULTS['platform']).rstrip('/')
        self.user = cfg.get('user') or 'admin'
        self.password = cfg.get('password') or ''
        self.camera = cfg.get('cameraId')
        self.token = None
        self._last_signin = 0.0

    def _http(self, path, body=None):
        import urllib.request
        url = self.base + path
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(url, data=data, method='POST' if data else 'GET')
        req.add_header('Content-Type', 'application/json')
        if self.token:
            req.add_header('x-access-token', self.token)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode('utf-8', 'replace')

    def signin(self):
        try:
            st, body = self._http('/api/signin', {'username': self.user, 'password': self.password})
            self.token = (json.loads(body).get('data') or {}).get('token')
            log('平台登录成功' if self.token else '平台登录返回异常：%s' % body[:120])
        except Exception as e:
            log('平台登录失败：%s' % e)

    def send(self, payload):
        """上报一次。**绝不因失败而连环重登** —— 那会把登录限流打爆（实测 429 风暴）。"""
        for attempt in (1, 2):
            try:
                st, body = self._http('/api/ai/events', payload)
                if st == 401 and attempt == 1:
                    if not self.signin_throttled():
                        return 401, 'signin throttled'
                    continue
                return st, body
            except urllib_error.HTTPError as e:
                # 429 = 被限流。重登只会更糟；退避交给主循环。
                if e.code == 429:
                    return 429, 'rate limited'
                if e.code == 401 and attempt == 1 and self.signin_throttled():
                    continue
                return e.code, str(e)
            except Exception as e:
                return None, str(e)
        return None, 'unreachable'

    def signin_throttled(self):
        """登录节流：30 秒内最多登一次（登录限流是 100 次/5 分钟）。"""
        now = time.time()
        if now - self._last_signin < 30:
            return False
        self._last_signin = now
        self.signin()
        return True


# ------------------------------------------------------------------ 主循环

def build_payload(cfg, tracks, w, h):
    dets = []
    for t in tracks:
        x1, y1, x2, y2 = t['xyxy']
        x = max(0.0, min(1.0, x1 / w))
        y = max(0.0, min(1.0, y1 / h))
        ww = max(0.0, min(1.0 - x, (x2 - x1) / w))
        hh = max(0.0, min(1.0 - y, (y2 - y1) / h))
        dets.append({
            'id': 'T%d' % t['id'],            # <- trackId 走 id 字段，normalize.js 会保留
            'label': cfg['label'],
            'score': round(float(t['conf']), 3),
            'region': {'x': round(x, 5), 'y': round(y, 5), 'w': round(ww, 5), 'h': round(hh, 5)},
            'normalized': True,
            'timestamp': int(time.time() * 1000),
        })
    return {
        'camera': cfg['cameraId'],
        'imageWidth': w,
        'imageHeight': h,
        'detections': dets,
    }


def public_path(cfg):
    """高频数据落这里：/_images 由 express.static 直出，**不受 API 限流**，
    画面脚本可以高频率读它来画平滑轨迹（平台 API 的 1000 次/5 分钟配额要留给全站）。"""
    return Path(cfg['_cfgDir']).resolve().parent / '_images' / 'ai-tracks.json'


def write_public(cfg, payload):
    """原子写：先写 .tmp 再 replace，避免画面读到写了一半的 JSON。"""
    p = public_path(cfg)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        if payload is None:
            payload = {'camera': cfg['cameraId'], 'updatedAt': int(time.time() * 1000), 'detections': []}
        tmp = p.with_name(p.name + '.tmp')
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        os.replace(str(tmp), str(p))
    except Exception as e:
        log('写公开轨迹文件失败：%s' % e)


def main():
    cfg = load_cfg()
    if not cfg.get('cameraId'):
        log('配置缺少 cameraId，无法上报'); return 2

    dev, why = pick_device(cfg)
    log('推理设备：%s（%s）' % (dev, why))

    mp = resolve_model(cfg)
    log('载入模型：%s' % mp)
    t0 = time.time()
    model = YOLO(mp)
    log('模型就绪（%.1fs）' % (time.time() - t0))

    plat = Platform(cfg)
    plat.signin()

    rtsp = cfg['source']['rtsp']
    log('视频源：%s' % _mask(rtsp))

    interval = 1.0 / max(1.0, float(cfg['targetFps']))
    pushEvery = max(1, int(round(float(cfg['targetFps']) / max(0.1, float(cfg['pushHz'])))))
    endAfter = float(cfg['endAfterMs']) / 1000.0

    state = {'last429Log': 0.0}
    cap = None
    lastPush = 0.0
    lastSeen = 0.0
    pushed = False
    frameNo = 0
    dbgDir = cfg.get('debugDir')
    if dbgDir:
        Path(dbgDir).mkdir(parents=True, exist_ok=True)

    while True:
        if cap is None or not cap.isOpened():
            if cap is not None:
                cap.release()
            cap = cv2.VideoCapture(rtsp, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                log('RTSP 打不开，%d 秒后重试' % (int(cfg['reconnectMs'] / 1000)))
                time.sleep(float(cfg['reconnectMs']) / 1000.0)
                continue
            log('RTSP 已连接')

        t_start = time.time()
        ok, frame = cap.read()
        if not ok or frame is None:
            log('取帧失败，重连')
            cap.release(); cap = None
            time.sleep(1.0)
            continue

        h, w = frame.shape[0], frame.shape[1]
        frameNo += 1
        try:
            res = model.track(frame, persist=True, classes=cfg['classes'],
                              conf=float(cfg['conf']), iou=float(cfg['iou']),
                              imgsz=int(cfg['imgsz']), device=dev,
                              tracker=cfg['tracker'], verbose=False)[0]
        except Exception as e:
            log('推理/追踪异常（已忽略本帧）：%s' % e)
            continue

        tracks = []
        if res.boxes is not None and len(res.boxes):
            ids = res.boxes.id
            for i, b in enumerate(res.boxes):
                tid = None
                if ids is not None and i < len(ids):
                    try:
                        tid = int(ids[i].item())
                    except Exception:
                        tid = None
                tracks.append({
                    'id': tid if tid is not None else (100000 + i),
                    'xyxy': [float(v) for v in b.xyxy[0].tolist()],
                    'conf': float(b.conf[0]),
                })

        now = time.time()
        # 自愈：启动脚本里本服务可能早于平台起来（登录必然失败），没有目标时也不会走上报路径，
        # 所以这里主动补登录。signin_throttled 保证 30 秒最多试一次。
        if plat.token is None:
            plat.signin_throttled()
        if tracks:
            lastSeen = now
            if now - state['last429Log'] > 30 and state['last429Log'] > 0:
                state['last429Log'] = 0
                log('平台限流已过，恢复低频上报')
            payload = build_payload(cfg, tracks, w, h)
            # 高频通道：静态文件，不限流 —— 供画面画框与轨迹
            write_public(cfg, payload)
            # 低频通道：平台 API，配额宝贵 —— 供报警联动与平台侧检测框
            if (now - lastPush) >= (interval * pushEvery):
                st, body = plat.send(payload)
                lastPush = now
                pushed = True
                if st == 429:
                    # 限流期间别每帧刷屏，30 秒提示一次就够
                    if now - state['last429Log'] > 30:
                        state['last429Log'] = now
                        log('平台限流(429)：低频上报暂停（轨迹不受影响，仍走静态文件）')
                    plat.token = None
                elif st != 200:
                    log('上报异常 status=%s %s' % (st, str(body)[:140]))
        elif pushed and (now - lastSeen) > endAfter:
            write_public(cfg, None)
            plat.send({'camera': cfg['cameraId'], 'type': 'end'})
            pushed = False
            log('无目标，已清框并通知平台')

        if dbgDir and frameNo % int(cfg['debugEvery']) == 0:
            for t in tracks:
                x1, y1, x2, y2 = [int(v) for v in t['xyxy']]
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
                cv2.putText(frame, 'ID%d' % t['id'], (x1, max(20, y1 - 6)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
            cv2.imwrite(str(Path(dbgDir) / ('f%06d.jpg' % frameNo)), frame)

        spent = time.time() - t_start
        if spent < interval:
            time.sleep(interval - spent)


def _mask(url):
    import re
    return re.sub(r'//([^:]+):([^@]+)@', r'//\1:***@', url)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log('收到中断，退出')
        sys.exit(0)
