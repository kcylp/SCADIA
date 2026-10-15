"""Directional doorway gate. Coordinates are normalized; no image/model dependencies."""
import math


def inside(point, polygon):
    x, y = point
    hit = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


class EntryGate:
    def __init__(self, config):
        self.enabled = bool(config.get('enabled'))
        self.config = config
        self.states = {}
        if not self.enabled:
            return
        self.roi = config['points']
        self.a, self.b = config['line']
        self.interior = config['insidePoint']
        coordinates = [*self.roi, self.a, self.b, self.interior]
        if len(self.roi) < 3 or any(len(p) != 2 or any(not math.isfinite(v) or not 0 <= v <= 1 for v in p) for p in coordinates):
            raise ValueError('Invalid doorway geometry')
        dx, dy = self.b[0] - self.a[0], self.b[1] - self.a[1]
        self.length = math.hypot(dx, dy)
        if self.length < .01:
            raise ValueError('Door threshold is too short')
        self.sign = 1 if self.cross(self.interior) > 0 else -1
        if abs(self.cross(self.interior)) / self.length < .01:
            raise ValueError('Interior must be away from the threshold')
        self.margin = float(config.get('margin', .012))
        self.frames = max(2, int(config.get('stableFrames', 2)))
        self.max_gap = float(config.get('maxGapSeconds', 2))
        if not all(math.isfinite(v) and v > 0 for v in [self.margin, self.max_gap]):
            raise ValueError('Invalid doorway stability budget')
        if not inside(self.interior, self.roi):
            raise ValueError('Interior must be in the doorway ROI')
        distances = [self.cross(p) / self.length for p in self.roi]
        if min(distances) >= -self.margin or max(distances) <= self.margin:
            raise ValueError('Threshold must have stable space on both sides')

    def cross(self, p):
        return (self.b[0] - self.a[0]) * (p[1] - self.a[1]) - (self.b[1] - self.a[1]) * (p[0] - self.a[0])

    def update(self, tracks, width, height, now):
        if not self.enabled:
            return tracks, []
        self.states = {k: s for k, s in self.states.items() if now - s['at'] < 30}
        candidates, entries = [], []
        observed = set()
        for track in tracks:
            # Frame-local fallback IDs cannot prove a trajectory.
            if track.get('tracked') is False or track['id'] in observed:
                continue
            observed.add(track['id'])
            x1, _, x2, y2 = track['xyxy']
            point = ((x1 + x2) / 2 / width, y2 / height)
            if not inside(point, self.roi):
                state = self.states.get(track['id'])
                if state:
                    state['outside'] = 0
                    state['inside'] = 0
                    state['armed'] = False
                continue
            candidates.append(track)
            distance = self.sign * self.cross(point) / self.length
            side = -1 if distance < -self.margin else 1 if distance > self.margin else 0
            state = self.states.get(track['id'])
            if state is None or now - state['at'] > self.max_gap:
                state = {'at': now, 'outside': 0, 'inside': 0, 'armed': False, 'done': False, 'anchor': point}
                self.states[track['id']] = state
            state['at'] = now
            if side < 0:
                state['outside'] += 1
                state['inside'] = 0
                state['anchor'] = point
                state['armed'] = state['outside'] >= self.frames
                if state['armed']:
                    state['done'] = False
            elif side > 0 and state['armed'] and not state['done']:
                state['inside'] += 1
                if state['inside'] < self.frames:
                    continue
                anchor = state['anchor']
                d0, d1 = self.cross(anchor), self.cross(point)
                t = d0 / (d0 - d1) if d0 != d1 else -1
                crossing = (anchor[0] + t * (point[0] - anchor[0]), anchor[1] + t * (point[1] - anchor[1]))
                projection = ((crossing[0] - self.a[0]) * (self.b[0] - self.a[0]) + (crossing[1] - self.a[1]) * (self.b[1] - self.a[1])) / self.length ** 2
                if not 0 <= t <= 1 or not 0 <= projection <= 1:
                    state['armed'] = False
                    state['inside'] = state['outside'] = 0
                    continue
                # Only a complete outside-to-inside path counts. Spatial proximity
                # alone cannot distinguish an ID switch from two adjacent people.
                state['done'] = True
                state['armed'] = False
                state['inside'] = state['outside'] = 0
                entries.append(dict(track, label='门口进入'))
            elif side > 0:
                state['outside'] = 0
            elif side == 0:
                state['outside'] = 0
                state['inside'] = 0
        # Missing observations break consecutive stability; a previously counted ID
        # remains counted so a short occlusion cannot duplicate the same passage.
        for tid, state in self.states.items():
            if tid not in observed:
                state['outside'] = state['inside'] = 0
                state['armed'] = False
        return candidates, entries
