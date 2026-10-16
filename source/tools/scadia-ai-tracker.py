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
import uuid
from pathlib import Path
from scadia_entry_gate import EntryGate
from scadia_scenes import SceneEngine, EvidenceBuffer, queue_event
from scadia_platform import Platform
from scadia_actions import posture, helmet_matches
from scadia_visual import VisualCandidates

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
    "password": "",
    "cameraId": None,
    "model": "../../models/yolov8n-pose.pt",
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
    # ---- 场景增强检测（都基于 YOLO 人员框推导，不额外起模型；安全帽除外）----
    # 闯入：人员脚点落入电子围栏多边形 => label 变“人员·闯入”。
    # 围栏自动读 video-events.json 的 fence.points（归一化 scale），与画面上画的是同一份。
    "intrusion": {"enabled": True, "fence": "auto"},
    # 跌倒：人橫纵比连续 N 帧超过阈值（躺倒时宽>高）=> label 变“人员·跌倒”。
    # 纯几何启发式，不加模型；闻值按现场实测再调。
    "fall": {"enabled": True, "aspect": 1.25, "frames": 4, "minHeight": 0.06},
    # 安全帽：外挂安全帽专用模型（本仓 models/helmet/， hf-mirror 下载），
    # 每 N 帧跑一次；模型类别 0=With-Helmet 1=Without Helmet（已实测）。
    "helmet": {
        "enabled": True,
        "model": "helmet/helmet_trained.pt",   # 相对 models 目录；不存在则自动禁用
        "everyN": 8,
        "conf": 0.30,
        "withoutClass": 1,
        "matchIou": 0.15,   # 人员框与“未戴帽”框的重叠阈值（头在人身上，重叠天然较低）
    },
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
    cfg['_cfgPath'] = str(path)
    src = cfg.get('source') or {}
    if not src.get('rtsp') and not src.get('snapshot'):
        src['rtsp'] = 'rtsp://%s:%s@%s:554/Streaming/Channels/102' % (
            (cfg.get('camera') or {}).get('user', 'admin'),
            (cfg.get('camera') or {}).get('password', ''),
            (cfg.get('camera') or {}).get('host', '192.168.110.21'))
    cfg['source'] = src
    return cfg


def resolve_model(cfg):
    """模型路径：显式路径优先 -> 配置文件目录 -> 内置名（ultralytics 会自动下载）。"""
    m = str(cfg.get('model') or 'yolov8n-pose.pt')
    if Path(m).name == 'yolov8n.pt':
        pose = Path(__file__).resolve().parent.parent.parent / 'models' / 'yolov8n-pose.pt'
        if pose.exists():
            m = str(pose)
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
            'label': t.get('label', cfg['label']),   # 逐人标签：人员/闯入/跌倒/未戴安全帽
            'score': round(float(t['conf']), 3),
            'region': {'x': round(x, 5), 'y': round(y, 5), 'w': round(ww, 5), 'h': round(hh, 5)},
            'normalized': True,
            'timestamp': int(time.time() * 1000),
        })
    return {
        'camera': cfg['cameraId'],
        'streamKind': cfg.get('streamKind', 'visible'),
        'model': str(cfg.get('model', 'yolov8n.pt')),
        'imageWidth': w,
        'imageHeight': h,
        'updatedAt': int(time.time() * 1000),
        'detections': dets,
        'entryGate': {k: v for k, v in (cfg.get('entryGate') or {}).items()
                      if k in ['enabled', 'points', 'line', 'insidePoint', 'label']},
    }


# ---------------------------------------------------------------- 场景增强检测

def load_fence(cfg):
    """读 video-events.json 的电子围栏，归一化成 0..1 多边形。auto = 与画面同一份。"""
    try:
        p = Path(cfg['_cfgDir']) / 'video-events.json'
        d = json.loads(p.read_text(encoding='utf-8'))
        f = (d.get('fence') or {})
        scale = float(f.get('scale') or 1000)
        pts = f.get('points') or []
        if len(pts) < 3:
            return None
        return [(float(x) / scale, float(y) / scale) for x, y in pts]
    except Exception as e:
        log('围栏读取失败（闯入检测禁用）：%s' % e)
        return None


def point_in_poly(x, y, poly):
    """射线法：点是否在多边形内。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class FallDetector(object):
    """跌倒 = 人框横纵比连续 N 帧超阈值（躺倒时宽>高）。状态挂实例，跨帧累积。"""
    def __init__(self, cfg):
        c = cfg.get('fall') or {}
        self.enabled = bool(c.get('enabled'))
        self.aspect = float(c.get('aspect', 1.25))
        self.frames = int(c.get('frames', 4))
        self.minH = float(c.get('minHeight', 0.06))
        self.hist = {}      # tid -> 连续“疑似躺倒”帧数
    def update(self, tid, xyxy, w, h):
        if not self.enabled:
            return False
        bw = (xyxy[2] - xyxy[0]) / max(1.0, w)
        bh = (xyxy[3] - xyxy[1]) / max(1.0, h)
        if bh < self.minH:
            return False    # 太远/太小的人不判，误报举高
        lying = (bw / max(1e-6, bh)) >= self.aspect
        if lying:
            self.hist[tid] = self.hist.get(tid, 0) + 1
        else:
            self.hist[tid] = 0
        if self.hist.get(tid, 0) >= self.frames:
            return True
        return False
    def forget(self, live_ids):
        for k in list(self.hist.keys()):
            if k not in live_ids:
                del self.hist[k]


def _iou(a, b):
    ax1, ay1, ax2, ay2 = a; bx1, by1, bx2, by2 = b
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = max(1e-9, (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter)
    return inter / ua


class HelmetDetector(object):
    """Office rule: detect With-Helmet; absence of a helmet is normal."""
    def __init__(self, cfg):
        c = cfg.get('helmet') or {}
        self.enabled = False
        self.everyN = max(2, int(c.get('everyN', 8)))
        self.conf = float(c.get('conf', 0.30))
        self.with_class = None
        self.matchIou = float(c.get('matchIou', 0.15))
        self.model = None
        self.last = {}       # tid -> 是否未戴（保持到下一次检测刷新
        if not c.get('enabled'):
            return
        # 模型路径：models 目录下相对路径
        mp = str(c.get('model') or '')
        p = Path(mp)
        if not p.is_absolute():
            root = Path(__file__).resolve().parent.parent.parent / 'models'
            p = root / mp
        if not p.exists():
            log('安全帽模型不存在，安全帽检测禁用：%s' % p)
            return
        try:
            self.model = YOLO(str(p))
            self.with_class = next((int(i) for i, name in self.model.names.items() if str(name).lower().replace('_', '-').replace(' ', '-') == 'with-helmet'), None)
            if self.with_class is None:
                raise ValueError('With-Helmet class missing')
            self.enabled = True
            log('安全帽模型就绪：%s（类别 %s）' % (p.name, self.model.names))
        except Exception as e:
            log('安全帽模型加载失败（禁用）：%s' % e)
    def mark(self, frame, tracks, dev, frameNo):
        if not self.enabled:
            return
        if not tracks:
            self.last.clear()
            return
        live = {t['id'] for t in tracks}
        self.last = {k: v for k, v in self.last.items() if k in live}
        if frameNo % self.everyN != 0:
            return
        try:
            r = self.model.predict(frame, conf=self.conf, imgsz=640,
                                   device=dev, verbose=False)[0]
        except Exception as e:
            log('安全帽推理异常（忽略本轮）：%s' % e)
            return
        nohat = []
        if r.boxes is not None and len(r.boxes):
            names = r.names
            for b in r.boxes:
                cid = int(b.cls[0].item()) if b.cls is not None else -1
                if cid == self.with_class:
                    nohat.append([float(v) for v in b.xyxy[0].tolist()])
        for t in tracks:
            hit = False
            for hb in nohat:
                if helmet_matches(t['xyxy'], hb):
                    hit = True; break
            self.last[t['id']] = hit
        # 离场的人清状态
        live = set(t['id'] for t in tracks)
        for k in list(self.last.keys()):
            if k not in live:
                del self.last[k]
    def has_helmet(self, tid):
        return bool(self.last.get(tid))


def enrich_labels(cfg, tracks, w, h, fence, fall, helmet, frame, dev, frameNo):
    """逐人打标签：跌倒 > 闯入 > 未戴安全帽 > 人员（优先级高的胜出）。"""
    helmet.mark(frame, tracks, dev, frameNo)
    live = set(t['id'] for t in tracks)
    fall.forget(live)
    for t in tracks:
        x1, y1, x2, y2 = t['xyxy']
        label = cfg['label']
        t['helmet'] = helmet.has_helmet(t['id'])
        if t.get('lowPosture'):
            label = '人员·蹲下/跌倒疑似'
        elif fence and point_in_poly((x1 + x2) / 2.0 / w, y2 / h, fence):
            label = '人员·闯入'
        elif t['helmet']:
            label = '人员·戴安全帽'
        t['label'] = label
    return tracks


def public_path(cfg):
    """高频数据落这里：/_images 由 express.static 直出，**不受 API 限流**，
    画面脚本可以高频率读它来画平滑轨迹（平台 API 的 1000 次/5 分钟配额要留给全站）。"""
    name = cfg.get('publicFile', 'ai-tracks.json')
    if Path(name).name != name or not name.endswith('.json'):
        raise ValueError('publicFile must be a JSON basename')
    return Path(cfg['_cfgDir']).resolve().parent / '_images' / name


def write_public(cfg, payload):
    """原子写：先写 .tmp 再 replace，避免画面读到写了一半的 JSON。"""
    p = public_path(cfg)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        if payload is None:
            payload = {'camera': cfg['cameraId'], 'updatedAt': int(time.time() * 1000), 'detections': []}
        tmp = p.with_name(p.name + '.' + uuid.uuid4().hex + '.tmp')
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        # Windows static-file readers can briefly deny delete-sharing.
        for attempt in range(6):
            try:
                os.replace(str(tmp), str(p))
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(.02 * (attempt + 1))
    except Exception as e:
        log('写公开轨迹文件失败：%s' % e)


def queue_entry(cfg, track, frame):
    """Durable local outbox; the bridge owns counters, alarm tags and shot index."""
    event_id = uuid.uuid4().hex
    root = Path(cfg['_cfgDir'])
    inbox = root / 'entry-events'
    inbox.mkdir(exist_ok=True)
    shot_dir = root.parent / '_images' / 'alarm-shots'
    shot_dir.mkdir(exist_ok=True)
    shot = 'entry-' + event_id + '.jpg'
    ok, encoded = cv2.imencode('.jpg', frame)
    if not ok:
        raise RuntimeError('Entry snapshot encoding failed')
    (shot_dir / shot).write_bytes(encoded.tobytes())
    payload = {'eventId': event_id, 'camera': cfg['cameraId'], 'kind': 'doorentry',
               'at': int(time.time() * 1000), 'trackId': str(track['id']), 'shot': shot}
    temp = inbox / (event_id + '.tmp')
    temp.write_text(json.dumps(payload), encoding='utf-8')
    os.replace(temp, inbox / (event_id + '.json'))
    log('门口进入已记录：轨迹 %s' % track['id'])


def reload_scene_rules(cfg, latest):
    """从最新配置构造替换后的 cfg/gate/scenes。

    只有整体构造成功才返回；任何字段/几何无效都会抛异常，由调用方保留上一有效规则。
    applied 版本描述的是已构造成功的规则，从不描述一次失败的尝试。
    """
    current = latest.get('entryGate') or {}
    next_cfg = dict(cfg, entryGate=current, scenes=latest.get('scenes') or {},
                    rulesVersion=latest.get('rulesVersion'))
    return next_cfg, EntryGate.for_scenes(next_cfg), SceneEngine(next_cfg)


def main():
    cfg = load_cfg()
    gate_config = dict(cfg.get('entryGate') or {})
    gate = EntryGate.for_scenes(cfg)
    scenes = SceneEngine(cfg)
    evidence = EvidenceBuffer()
    visual_detector = VisualCandidates(cfg.get('streamKind') == 'thermal')
    log('可见光记录规则：%s' % ('仅门口向内进入，工位不统计' if gate.enabled else '独立通道检测'))
    if not cfg.get('cameraId'):
        log('配置缺少 cameraId，无法上报'); return 2

    dev, why = pick_device(cfg)
    log('推理设备：%s（%s）' % (dev, why))

    mp = resolve_model(cfg)
    log('载入模型：%s' % mp)
    t0 = time.time()
    model = YOLO(mp)
    cfg['_poseReady'] = model.task == 'pose'
    log('模型就绪（%.1fs）' % (time.time() - t0))

    plat = Platform(cfg, log)
    plat.signin()

    # 场景增强检测初始化：围栏（闯入）/ 跌倒 / 安全帽
    fence = load_fence(cfg) if (cfg.get('intrusion') or {}).get('enabled') else None
    log('闯入检测：%s' % ('围栏已载入（%d 点）' % len(fence) if fence else '禁用（无围栏）'))
    fall = FallDetector(cfg)
    log('跌倒检测：%s（横纵比≥%.2f 连续 %d 帧）' % ('开' if fall.enabled else '关', fall.aspect, fall.frames))
    helmet = HelmetDetector(cfg)
    cfg['_helmetReady'] = helmet.enabled
    log('安全帽检测：%s' % ('开（每 %d 帧）' % helmet.everyN if helmet.enabled else '关'))

    snapshot = cfg['source'].get('snapshot')
    rtsp = cfg['source'].get('rtsp')
    log('视频源：%s' % _mask(snapshot or rtsp))

    interval = 1.0 / max(1.0, float(cfg['targetFps']))
    pushEvery = max(1, int(round(float(cfg['targetFps']) / max(0.1, float(cfg['pushHz'])))))
    endAfter = float(cfg['endAfterMs']) / 1000.0

    state = {'last429Log': 0.0}
    cap = None
    config_at = 0.0
    gate_version = gate_config.get('calibrationVersion')
    calibration_error = None
    lastPush = 0.0
    lastSeen = 0.0
    pushed = False
    frameNo = 0
    dbgDir = cfg.get('debugDir')
    if dbgDir:
        Path(dbgDir).mkdir(parents=True, exist_ok=True)

    while True:
        if time.monotonic() - config_at > 2:
            config_at = time.monotonic()
            try:
                latest = json.loads(Path(cfg['_cfgPath']).read_text(encoding='utf-8'))
                current = latest.get('entryGate') or {}
                if current.get('calibrationVersion') != gate_version or latest.get('rulesVersion') != cfg.get('rulesVersion'):
                    cfg, gate, scenes = reload_scene_rules(cfg, latest)
                    gate_version = current.get('calibrationVersion')
                    log('门口标定已更新，轨迹状态重新初始化')
                calibration_error = None
            except Exception as error:
                code = type(error).__name__
                if calibration_error != code:
                    log('标定读取失败：%s；保留上一有效规则' % code)
                calibration_error = code
        if not snapshot and (cap is None or not cap.isOpened()):
            if cap is not None:
                cap.release()
            cap = cv2.VideoCapture(rtsp, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000])
            if not cap.isOpened():
                log('RTSP 打不开，%d 秒后重试' % (int(cfg['reconnectMs'] / 1000)))
                time.sleep(float(cfg['reconnectMs']) / 1000.0)
                continue
            log('RTSP 已连接')

        t_start = time.time()
        if snapshot:
            # Pull the latest proxy frame instead of draining a throttled RTSP queue.
            import urllib.request
            import numpy as np
            try:
                with urllib.request.urlopen(snapshot, timeout=5) as response:
                    raw = response.read(4 * 1024 * 1024)
                frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
                ok = frame is not None
            except Exception:
                ok, frame = False, None
        else:
            ok, frame = cap.read()
        if not ok or frame is None:
            log('取帧失败，等待新帧')
            # A capture gap starts a new observation session; candidates cannot bridge it.
            gate = EntryGate.for_scenes(cfg)
            scenes = SceneEngine(cfg)
            evidence = EvidenceBuffer()
            visual_detector = VisualCandidates(cfg.get('streamKind') == 'thermal')
            for tracker in getattr(getattr(model, 'predictor', None), 'trackers', []):
                tracker.reset()
            if cap is not None:
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
            fatal = any(word in str(e).lower() for word in ['illegal memory', 'device-side assert', 'out of memory'])
            log('推理失败：%s；%s' % (type(e).__name__, 'GPU上下文不可用，退出等待重启' if fatal else '本轮退避'))
            if fatal:
                return 3
            time.sleep(1)
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
                observation = posture(res.keypoints.data[i].tolist(), b.xyxy[0].tolist()) if res.keypoints is not None else {}
                tracks.append({
                    **observation,
                    'id': tid if tid is not None else (100000 + i),
                    'tracked': tid is not None,
                    'xyxy': [float(v) for v in b.xyxy[0].tolist()],
                    'conf': float(b.conf[0]),
                })

        evidence.add(frame, int(time.time() * 1000), cv2)
        cfg['_frameId'], cfg['_sessionId'] = str(frameNo), scenes.session
        all_tracks = tracks
        tracks, entries = gate.update(all_tracks, w, h, time.monotonic())
        for entry in entries:
            try:
                queue_event(cfg, entry, frame, 'doorentry', 'V1', cv2, evidence.sample())
            except Exception as e:
                log('门口事件保存失败：%s' % e)
        # Door statistics and safety scenes have independent scopes. Never discard
        # full-frame tracks before evaluating the separately configured safety rules.
        if all_tracks:
            try:
                enrich_labels(cfg, all_tracks, w, h, fence, fall, helmet, frame, dev, frameNo)
            except Exception as e:
                log('场景标签异常（忽略本帧，不影响基础检测）：%s' % e)

        visual_state = visual_detector.update(frame, time.monotonic())
        scene_state, scene_events = scenes.update(all_tracks, w, h, time.monotonic(), visual_state)
        for kind, scene_id, event_track in scene_events:
            try:
                queue_event(cfg, event_track, frame, kind, scene_id, cv2, evidence.sample())
            except Exception as e:
                log('场景事件保存失败：%s' % e)
        scene_payload = build_payload(cfg, all_tracks, w, h)
        scene_payload.update(scenes=scene_state, frameId=str(frameNo), sessionId=scenes.session,
                             inferenceMs=round((time.time() - t_start) * 1000, 1),
                             delivery=dict(plat.delivery), appliedCalibrationVersion=gate_version,
                             calibrationError=calibration_error,
                             appliedRulesVersion=cfg.get('rulesVersion', 'none'),
                             entryGate=dict({k: cfg.get('entryGate', {}).get(k) for k in ['points', 'line', 'insidePoint', 'calibrationVersion']},
                                            enabled=gate.enabled, verified=cfg.get('entryGate', {}).get('verified') is True))
        scene_cfg = dict(cfg, publicFile='ai-scenes-thermal.json' if cfg.get('streamKind') == 'thermal' else 'ai-scenes.json')
        write_public(scene_cfg, scene_payload)
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
            if not gate.enabled and cfg.get('reportDetections', True) and (now - lastPush) >= (interval * pushEvery):
                st, body = plat.send(payload)
                lastPush = now
                pushed = True
                if st == 429:
                    # 限流期间别每帧刷屏，30 秒提示一次就够
                    if now - state['last429Log'] > 30:
                        state['last429Log'] = now
                        log('平台限流(429)：低频上报暂停（轨迹不受影响，仍走静态文件）')
                elif st is not None and st != 200:
                    log('上报异常 status=%s %s' % (st, str(body)[:140]))
        else:
            # A successfully decoded empty frame is fresh evidence too. Without this
            # heartbeat an idle camera retains yesterday's tracks until a person appears.
            write_public(cfg, build_payload(cfg, [], w, h))
            if pushed and (now - lastSeen) > endAfter:
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
