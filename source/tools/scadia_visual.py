"""Low-cost visual candidates. Rendered thermal pixels are never temperatures."""
import cv2
import numpy as np


class VisualCandidates:
    def __init__(self, thermal=False):
        self.thermal = thermal
        self.previous = None
        self.previous_at = None
        self.since = {}
        self.sent = set()

    def update(self, frame, now):
        height, width = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        signals, regions = [], []
        if self.thermal:
            # Palette and automatic gain limit interpretation to relative hotspots.
            mask = np.uint8((gray >= max(220, float(np.percentile(gray, 99.5)))) * 255)
            prefix, minimum = 'thermal_anomaly', 2
        else:
            mask = cv2.inRange(hsv, np.array([0, 80, 200]), np.array([45, 255, 255]))
            prefix, minimum = 'fire', 2
        for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
            a, b, c, d = cv2.boundingRect(contour)
            area = c*d
            if minimum <= area <= width*height*.02 and c >= 1 and d >= 2:
                # Keep bounded candidate regions; classification belongs to review.
                regions.append({'kind': prefix, 'region': {'x': a/width, 'y': b/height, 'w': c/width, 'h': d/height}})
        regions = sorted(regions, key=lambda r: r['region']['w']*r['region']['h'], reverse=True)[:8]
        if regions:
            signals.append(prefix)
        brightness = float(gray.mean())
        blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if not self.thermal:
            if brightness < 8:
                signals.append('blackout')
            elif blur < 12:
                signals.append('blur')
        active = set(signals)
        events = []
        for kind in signals:
            self.since.setdefault(kind, now)
            delay = .25 if kind in ['fire', 'thermal_anomaly'] else 5
            if now-self.since[kind] >= delay and kind not in self.sent:
                events.append(kind); self.sent.add(kind)
        self.since = {k: v for k, v in self.since.items() if k in active}
        self.sent.intersection_update(active)
        return {'regions': regions, 'signals': signals, 'events': events,
                'brightness': round(brightness, 1), 'sharpness': round(blur, 1),
                'temperature': {'status': 'unavailable', 'reason': '红外渲染流未提供辐射测温数据', 'value': None},
                'limitations': '相对亮热区候选；受调色板与自动增益影响' if self.thermal else '颜色/画质候选；火苗须复核排除灯光、屏幕和反光',
                'passage': {'status': 'calibration_required', 'reason': '尚无独立通道占用区域'}}
