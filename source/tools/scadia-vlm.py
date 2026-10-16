# -*- coding: utf-8 -*-
"""
开诚智枢 SCADIA · VLM 视觉理解服务（本地多模态大模型）

定位（与人体检测追踪服务互补，不重叠）：
    scadia-ai-tracker.py  -> 逐帧"人在哪、走过哪"（YOLO+ByteTrack，高频、结构化）
    scadia-vlm.py         -> 事件级"画面在发生什么"（VLM，低频、自然语言）
                            对报警抓拍图 / 定时抽帧做描述与判定，落成可读字幕。

为什么是"事件级"而不是"逐帧"：VLM 单图推理 0.5~3 秒，做不了 25fps 实时；
强行逐帧会把显卡和平台配额都打爆。正确用法是低频触发 + 语言理解。

数据流：
    _images/alarm-shots/*.jpg（相机报警抓拍）  ─┐
    或 定时从 RTSP 抽帧                      ─┴─> VLM 描述/判定
        ─> 写 project/_images/ai-captions.json（静态文件，不受平台 API 限流）
        ─> （可选）POST /api/ai/events 回写平台，交报警联动

稳定性设计（本机实测约束，别删注释）：
  * 本机 GitHub 不通，所以模型与依赖必须走镜像；本脚本只读**本地模型目录**，
    运行期不联网、不拉 GitHub。
  * transformers 新版默认走 Xet 存储（xethub.hf.co），镜像不代理会 401 —— 下载时才需要
    设 HF_HUB_DISABLE_XET=1；运行期用本地目录不受影响。
  * 推理与模型加载分别 try/except：单张图失败不该让服务退出。
  * 与 YOLO 追踪器共用 16GB 显存：本服务模型常驻但低频调用，峰值可控。

配置：project/_appdata/vlm.json
用法：python scadia-vlm.py [配置文件路径]
"""

import json
import os
import sys
import time
import glob
from pathlib import Path
from urllib import error as urllib_error

# ---------------------------------------------------------------- 配置

DEFAULTS = {
    "platform": "http://127.0.0.1:1881",
    "user": "admin",
    "password": "123456",
    "cameraId": None,
    # 本地模型目录（运行期只读本地，不联网）
    "model_dir": r"D:\SCADIA-工作站迁移\SCADIA\models\Qwen2.5-VL-3B-Instruct",
    "device": "auto",              # auto | cpu | cuda
    "dtype": "float16",            # float16 | bfloat16 | float32
    "maxNewTokens": 96,
    "maxPixels": 640 * 28 * 28,    # 限制视觉 token，控显存与延迟（Qwen2.5-VL 用像素上限）
    "minPixels": 256 * 28 * 28,
    # 事件源：监听报警抓拍目录
    "watch": {
        "alarmShotsDir": None,     # None -> 自动解析为 project/_images/alarm-shots
        "pollMs": 3000,
    },
    # 事件源：定时从 RTSP 抽帧（默认关；开了才走）
    "periodic": {
        "enabled": False,
        "rtsp": None,
        "everyMs": 60000,
    },
    "prompt": ("你是工业视频监控助手。请用一句简洁中文描述画面中正在发生什么，"
               "重点说明：是否有人、大约几人、是否佩戴安全帽、有无异常或危险迹象。"
               "只输出描述本身，不要客套。"),
    "maxCaptions": 200,            # 字幕环形缓冲上限
    # 是否把字幕回写平台 API。默认关：字幕走静态文件 ai-captions.json（不受平台限流），
    # 平台 /api/ai/events 目前没有"文本"字段，硬塞会污染检测语义，故默认不推。
    "pushToPlatform": False,
}


def log(m):
    sys.stdout.write('%s [vlm] %s\n' % (time.strftime('%H:%M:%S'), m))
    sys.stdout.flush()


def load_cfg():
    here = Path(__file__).resolve().parent
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else (here / '..' / '..' / 'project' / '_appdata' / 'vlm.json')
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
    # 工程根 = _appdata 的上一级
    cfg['_projectDir'] = str(Path(cfg['_cfgDir']).resolve().parent)
    if not cfg['watch'].get('alarmShotsDir'):
        cfg['watch']['alarmShotsDir'] = str(Path(cfg['_projectDir']) / '_images' / 'alarm-shots')
    return cfg


def pick_device(cfg):
    want = str(cfg.get('device') or 'auto').lower()
    if want != 'auto':
        return want
    try:
        import torch
        return 'cuda' if torch.cuda.is_available() else 'cpu'
    except Exception:
        return 'cpu'


def pick_dtype(cfg, dev):
    import torch
    d = str(cfg.get('dtype') or 'float16').lower()
    if dev == 'cpu':
        return torch.float32
    if d == 'bfloat16':
        return torch.bfloat16
    if d == 'float32':
        return torch.float32
    return torch.float16


# ---------------------------------------------------------------- 平台（可选）

class Platform(object):
    def __init__(self, cfg):
        self.base = str(cfg.get('platform') or DEFAULTS['platform']).rstrip('/')
        self.user = cfg.get('user') or 'admin'
        self.password = cfg.get('password') or ''
        self.token = None

    def signin(self):
        try:
            st, body = self._http('/api/signin', {'username': self.user, 'password': self.password})
            self.token = (json.loads(body).get('data') or {}).get('token')
            log('平台登录成功' if self.token else '平台登录异常：%s' % str(body)[:120])
        except Exception as e:
            log('平台登录失败：%s' % e)

    def _http(self, path, body=None):
        import urllib.request
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method='POST' if data else 'GET')
        req.add_header('Content-Type', 'application/json')
        if self.token:
            req.add_header('x-access-token', self.token)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode('utf-8', 'replace')

    def post_caption(self, payload):
        try:
            st, body = self._http('/api/ai/events', payload)
            if st == 401:
                self.signin()
            return st
        except Exception as e:
            return str(e)


# ---------------------------------------------------------------- VLM 引擎

class Vlm(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.dev = pick_device(cfg)
        self.model = None
        self.processor = None

    def load(self):
        import torch
        from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
        md = str(self.cfg['model_dir'])
        if not Path(md).exists():
            raise RuntimeError('模型目录不存在：%s' % md)
        t0 = time.time()
        log('载入 VLM：%s（device=%s）' % (md, self.dev))
        dtype = pick_dtype(self.cfg, self.dev)
        self.processor = AutoProcessor.from_pretrained(md, min_pixels=int(self.cfg['minPixels']), max_pixels=int(self.cfg['maxPixels']), local_files_only=True)
        self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            md, torch_dtype=dtype, device_map=self.dev if self.dev == 'cuda' else None,
        )
        if self.dev != 'cuda':
            self.model = self.model.to(self.dev)
        self.model.eval()
        log('VLM 就绪（%.1fs）' % (time.time() - t0))

    def describe(self, image_path, prompt=None):
        import torch
        from PIL import Image
        cfg = self.cfg
        paths = image_path if isinstance(image_path, list) else [image_path]
        if not 1 <= len(paths) <= 3:
            raise ValueError('Review requires one to three evidence frames')
        images = [Image.open(p).convert('RGB') for p in paths]
        messages = [{
            'role': 'user',
            'content': [{'type': 'image', 'image': img} for img in images] + [
                {'type': 'text', 'text': prompt or cfg['prompt']},
            ],
        }]
        text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.processor(text=[text], images=images, return_tensors='pt').to(self.dev)
        self.last_input = {'imageCount': len(images),
                           'imageGrid': inputs.image_grid_thw.tolist(),
                           'inputTokens': int(inputs.input_ids.shape[1])}
        with torch.inference_mode():
            out = self.model.generate(
                **inputs, max_new_tokens=int(cfg['maxNewTokens']), do_sample=False,
                max_time=float(cfg.get('generationTimeoutSeconds', 12)), use_cache=True,
            )
        gen = out[:, inputs.input_ids.shape[1]:]
        eos = self.model.generation_config.eos_token_id
        eos = eos if isinstance(eos, list) else [eos]
        self.last_generation = {'generatedTokens': int(gen.shape[1]),
                                'finished': bool(gen.shape[1] and int(gen[0, -1]) in eos)}
        self.last_generation['limit'] = None if self.last_generation['finished'] else (
            'TOKEN_LIMIT' if gen.shape[1] >= int(cfg['maxNewTokens']) else 'GENERATION_TIME_LIMIT')
        ans = self.processor.batch_decode(gen, skip_special_tokens=True)[0].strip()
        return ans


# ---------------------------------------------------------------- 落盘

def captions_path(cfg):
    return Path(cfg['_projectDir']) / '_images' / 'ai-captions.json'


def load_captions(cfg):
    p = captions_path(cfg)
    try:
        if p.exists():
            return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        pass
    return {'camera': cfg.get('cameraId'), 'captions': []}


def write_captions(cfg, doc):
    p = captions_path(cfg)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + '.tmp')
        tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding='utf-8')
        os.replace(str(tmp), str(p))
    except Exception as e:
        log('写字幕文件失败：%s' % e)


def add_caption(cfg, doc, text, source):
    doc['captions'].append({
        'ts': int(time.time() * 1000),
        'time': time.strftime('%Y-%m-%d %H:%M:%S'),
        'text': text,
        'source': source,
        'camera': cfg.get('cameraId'),
    })
    lim = int(cfg['maxCaptions'])
    if len(doc['captions']) > lim:
        doc['captions'] = doc['captions'][-lim:]
    doc['updatedAt'] = int(time.time() * 1000)
    write_captions(cfg, doc)


# ---------------------------------------------------------------- 帧源

class RtspGrabber(object):
    """低频抽帧：只在 periodic 模式用，独立于追踪器的 RTSP 连接。"""
    def __init__(self, rtsp):
        self.rtsp = rtsp
        self.cap = None

    def grab(self):
        import cv2
        if self.cap is None or not self.cap.isOpened():
            self.cap = cv2.VideoCapture(self.rtsp, cv2.CAP_FFMPEG)
        if not self.cap.isOpened():
            return None
        ok, frame = self.cap.read()
        if not ok or frame is None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
            return None
        return frame


# ---------------------------------------------------------------- 主循环

def main():
    cfg = load_cfg()
    vlm = Vlm(cfg)
    try:
        vlm.load()
    except Exception as e:
        log('VLM 载入失败，服务退出：%s' % e)
        return 2

    plat = None
    if cfg.get('pushToPlatform'):
        plat = Platform(cfg)
        plat.signin()

    doc = load_captions(cfg)
    doc['camera'] = cfg.get('cameraId')

    watch = cfg['watch']
    seen = set()
    shots = Path(watch['alarmShotsDir'])
    log('监听报警抓拍目录：%s' % shots)
    if shots.exists():
        seen = set(p.name for p in shots.glob('*.jpg'))

    grabber = None
    if cfg['periodic'].get('enabled') and cfg['periodic'].get('rtsp'):
        grabber = RtspGrabber(cfg['periodic']['rtsp'])
        log('定时抽帧已启用：每 %d ms' % int(cfg['periodic']['everyMs']))

    last_periodic = 0.0
    poll = max(500, int(watch['pollMs'])) / 1000.0

    while True:
        # A. 报警抓拍目录：新文件 -> 描述
        try:
            if shots.exists():
                for f in sorted(glob.glob(str(shots / '*.jpg'))):
                    name = os.path.basename(f)
                    if name in seen:
                        continue
                    seen.add(name)
                    try:
                        t0 = time.time()
                        text = vlm.describe(f)
                        dur = time.time() - t0
                        log('抓拍 %s -> %s（%.1fs）' % (name, text[:60], dur))
                        add_caption(cfg, doc, text, 'alarm-shot:' + name)
                    except Exception as e:
                        log('描述失败 %s：%s' % (name, e))
        except Exception as e:
            log('扫描抓拍目录异常：%s' % e)

        # B. 定时抽帧
        if grabber is not None:
            now = time.time()
            if (now - last_periodic) * 1000 >= int(cfg['periodic']['everyMs']):
                last_periodic = now
                frame = grabber.grab()
                if frame is not None:
                    tmp = Path(cfg['_projectDir']) / '_images' / '_vlm_live.jpg'
                    try:
                        import cv2
                        tmp.parent.mkdir(parents=True, exist_ok=True)
                        cv2.imwrite(str(tmp), frame)
                        t0 = time.time()
                        text = vlm.describe(str(tmp))
                        log('定时帧 -> %s（%.1fs）' % (text[:60], time.time() - t0))
                        add_caption(cfg, doc, text, 'periodic')
                    except Exception as e:
                        log('定时帧描述失败：%s' % e)

        time.sleep(poll)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log('收到中断，退出')
        sys.exit(0)
