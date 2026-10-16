"""Shared scene rules. No model loading, transport or platform credentials here."""
import json
import math
import os
import time
import uuid
from pathlib import Path
from collections import deque
from scadia_entry_gate import inside

SCENES = [
    ('V1', '门口进入', 'visible'), ('V2', '跌倒复核', 'visible'),
    ('V3', '抽烟复核', 'visible'), ('V4', '安全帽', 'visible'),
    ('V5', '人员聚集', 'visible'), ('V6', '禁区 / 滞留', 'visible'),
    ('V7', '烟火 / 通道 / 画质', 'visible'), ('T1', '红外辅助', 'thermal')]


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(.02 * (attempt + 1))
    finally:
        if tmp.exists():
            tmp.unlink()


class EvidenceBuffer:
    def __init__(self, seconds=3, max_frames=12):
        self.frames = deque(maxlen=max_frames)
        self.seconds = seconds

    def add(self, frame, at, cv2):
        if self.frames and at - self.frames[-1][0] < 250:
            return
        ok, encoded = cv2.imencode('.jpg', frame)
        if ok:
            self.frames.append((at, encoded.tobytes()))
        while self.frames and at - self.frames[0][0] > self.seconds * 1000:
            self.frames.popleft()

    def sample(self):
        frames = list(self.frames)
        if len(frames) < 3:
            return frames
        return [frames[0], frames[len(frames) // 2], frames[-1]]


def queue_event(cfg, track, frame, kind, scene_id, cv2, evidence=None):
    event_id = uuid.uuid4().hex
    root = Path(cfg['_cfgDir'])
    inbox = root / 'scene-events'
    inbox.mkdir(exist_ok=True)
    shot_dir = root / 'scene-evidence'
    shot_dir.mkdir(exist_ok=True)
    ok, encoded = cv2.imencode('.jpg', frame)
    if not ok:
        raise RuntimeError('Cannot encode event evidence')
    shot = 'scene-' + event_id + '.jpg'
    (shot_dir / shot).write_bytes(encoded.tobytes())
    at = int(time.time() * 1000)
    frames = []
    for index, (frame_at, image) in enumerate(evidence or []):
        name = 'scene-' + event_id + '-' + str(index) + '.jpg'
        (shot_dir / name).write_bytes(image)
        frames.append({'file': name, 'at': frame_at})
    rule = (cfg.get('entryGate') or {}) if scene_id == 'V1' else (cfg.get('scenes') or {}).get(scene_id, {})
    atomic_json(inbox / (event_id + '.json'), {
        'eventId': event_id, 'camera': cfg['cameraId'], 'source': cfg.get('streamKind', 'visible'), 'kind': kind,
        'sceneId': scene_id, 'at': at,
        'trackId': str(track.get('id', 'region')), 'shot': shot,
        'calibrationVersion': str((cfg.get('entryGate') or {}).get('calibrationVersion', 'unverified')),
        'label': track.get('label', kind), 'reviewStatus': 'pending',
        'evidenceFrames': frames or [{'file': shot, 'at': at}],
        'context': {'rule': rule, 'model': Path(str(cfg.get('model', 'unconfigured'))).name,
                    'frameId': cfg.get('_frameId'), 'sessionId': cfg.get('_sessionId'),
                    'observation': {'label': track.get('label', kind), 'stationarySeconds': track.get('stationarySeconds'),
                                    'visual': track.get('observation')}, 'temporalEvidence': len(frames) > 1}})


class SceneEngine:
    def __init__(self, cfg):
        rules = cfg.get('scenes') or {}
        if not isinstance(rules, dict):
            raise ValueError('Invalid scene rules')
        for scene_id, rule in rules.items():
            if scene_id not in {s[0] for s in SCENES} or not isinstance(rule, dict):
                raise ValueError('Invalid scene rule')
            if 'enabled' in rule and not isinstance(rule['enabled'], bool):
                raise ValueError('Invalid scene enable flag')
            key = 'count' if scene_id == 'V5' else 'seconds' if scene_id == 'V6' else None
            if key and key in rule:
                value = rule[key]
                minimum, maximum = (2, 100) if key == 'count' else (1, 3600)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum or int(value) != value:
                    raise ValueError('Invalid scene threshold')
        self.cfg = cfg
        self.rules = cfg.get('scenes') or {}
        self.since = {}
        self.sent = {}
        self.session = uuid.uuid4().hex
        self.stationary = {}
        self.latched = set()

    def active(self, key, present, now, seconds, cooldown):
        if not present:
            self.since.pop(key, None)
            return False
        self.since.setdefault(key, now)
        if now - self.since[key] < seconds or now - self.sent.get(key, -1e12) < cooldown:
            return False
        self.sent[key] = now
        return True

    def update(self, tracks, width, height, now, visual=None):
        thermal = self.cfg.get('streamKind') == 'thermal'
        self.rules = self.cfg.get('scenes') or {}
        tracks = list({str(t['id']): t for t in tracks}.values())
        live = {str(t['id']) for t in tracks if t.get('tracked')}
        self.stationary = {k: v for k, v in self.stationary.items() if k in live and now-v['at'] <= 2}
        result, events = [], []
        seen = set()
        for scene_id, name, modality in SCENES:
            if thermal != (modality == 'thermal'):
                continue
            rule = self.rules.get(scene_id) or {}
            selected = []
            metrics = {}
            status, detail = 'limited', '专项模型或标定尚未验收；VLM只做图像复核'
            if rule.get('enabled') is False:
                result.append({'sceneId': scene_id, 'name': name, 'modality': modality,
                               'status': 'disabled', 'detail': '规则已停用；历史记录和证据保留',
                               'metrics': {}, 'trackIds': []})
                if scene_id == 'V6':
                    self.stationary.clear()
                continue
            if scene_id == 'V1':
                gate = self.cfg.get('entryGate') or {}
                status = 'trial' if gate.get('enabled') and gate.get('verified') else 'calibration_required'
                detail = '仅记录门口向内过线；进入次数不等于独立访客人数' if status == 'trial' else '门口方向线未确认，不生成进入记录'
                selected = [t for t in tracks if gate.get('points') and inside(self.foot(t, width, height), gate['points'])]
            elif scene_id in ('V2', 'V3', 'V4'):
                flag, kind, label = {'V2': ('lowPosture', 'fall', '蹲下/跌倒疑似'),
                                     'V3': ('handToMouth', 'smoking', '点烟/吸烟动作疑似'),
                                     'V4': ('helmet', 'helmet', '戴安全帽')}[scene_id]
                selected = [t for t in tracks if t.get(flag)]
                status = 'trial' if self.cfg.get('_helmetReady' if scene_id == 'V4' else '_poseReady') else 'limited'
                detail = {'V2': '蹲下或倒地姿态即存证；坐姿/遮挡需复核',
                          'V3': '手口动作候选即存证；香烟小目标需复核，喝水/电话可能混淆',
                          'V4': '办公室规则：戴安全帽检出，未戴正常'}[scene_id]
                for t in selected:
                    if t.get('tracked'):
                        key = scene_id + ':' + str(t['id']); seen.add(key)
                        if key not in self.latched and now - self.sent.get(key, -1e12) >= 15:
                            events.append((kind, scene_id, dict(t, label=label)))
                            self.latched.add(key)
                            self.sent[key] = now
            elif scene_id == 'V5':
                selected = tracks
                threshold = int(rule.get('count', 4))
                present = len(tracks) >= threshold
                key = 'V5:all'
                if present:
                    seen.add(key)
                    if key not in self.latched:
                        events.append(('crowding', scene_id, {'id': 'region', 'label': '人员聚集：同时%d人' % len(tracks)}))
                        self.latched.add(key)
                status = 'active' if present else 'normal'
                detail = '同时%d人；%d人及以上立即聚集，%d人及以下解除' % (len(tracks), threshold, threshold - 1)
                metrics = {'peopleCount': len(tracks), 'threshold': threshold}
            elif scene_id == 'V6':
                selected = [t for t in tracks if t.get('tracked')]
                seconds = max(1, float(rule.get('seconds', 30)))
                durations = {}
                for t in selected:
                    tid = str(t['id']); point = self.foot(t, width, height)
                    bw = (t['xyxy'][2]-t['xyxy'][0])/width
                    bh = (t['xyxy'][3]-t['xyxy'][1])/height
                    tolerance = max(.006, min(.025, min(bw, bh)*.2))
                    state = self.stationary.get(tid)
                    if not state or math.dist(point, state['anchor']) > tolerance:
                        state = {'anchor': point, 'since': now, 'at': now, 'sent': False}
                        self.stationary[tid] = state
                    state['at'] = now
                    duration = now-state['since']; durations[tid] = round(duration, 1)
                    if duration >= seconds and not state['sent']:
                        state['sent'] = True
                        events.append(('loitering', scene_id, dict(t, label='原位不动%.0f秒' % duration,
                                                                 stationarySeconds=round(duration, 1))))
                status = 'active' if any(v >= seconds for v in durations.values()) else 'normal'
                detail = '同人原位不动连续%.0f秒触发；明显走动或失联重新计时' % seconds
                metrics = {'stationarySeconds': durations, 'thresholdSeconds': seconds}
            elif scene_id in ('V7', 'T1'):
                visual = visual or {}
                selected = tracks if thermal else []
                metrics = visual
                status = 'candidate' if visual.get('signals') else 'limited'
                detail = ('红外人体为辅助轮廓；热源候选须复核；测温不可用，未取得真实测温数据' if thermal else
                          '点火/小火苗及画质候选独立存证；颜色候选须复核；通道尚待独立区域标定')
                for kind in visual.get('events', []):
                    events.append((kind, scene_id, {'id': 'visual', 'label': {
                        'fire': '点火/小火苗疑似', 'thermal_anomaly': '相对热区疑似：点火/焊接用途待复核',
                        'blackout': '画面过暗/遮挡候选', 'blur': '画质模糊候选'}[kind],
                        'observation': visual}))
            result.append({'sceneId': scene_id, 'name': name, 'modality': modality,
                           'status': status, 'detail': detail, 'metrics': metrics,
                           'trackIds': [str(t['id']) for t in selected]})
        self.latched.intersection_update(seen)
        self.since = {k: v for k, v in self.since.items() if k in seen}
        self.sent = {k: v for k, v in self.sent.items() if now - v < 3600}
        return result, events

    @staticmethod
    def valid_polygon(points):
        return isinstance(points, list) and 3 <= len(points) <= 32 and all(
            isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in p) for p in points)

    @staticmethod
    def foot(track, width, height):
        x1, _, x2, y2 = track['xyxy']
        return ((x1 + x2) / 2 / width, y2 / height)
