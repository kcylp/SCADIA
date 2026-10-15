"""Pose candidates are observations, never a smoking or accident verdict."""
import math


def angle(a, b, c):
    u, v = (a[0]-b[0], a[1]-b[1]), (c[0]-b[0], c[1]-b[1])
    size = math.hypot(*u)*math.hypot(*v)
    if size < 1e-6:
        return 180
    return math.degrees(math.acos(max(-1, min(1, (u[0]*v[0]+u[1]*v[1])/size))))


def posture(points, box):
    """COCO-17 keypoints in pixels, each [x,y,confidence]."""
    if len(points) != 17:
        return {'lowPosture': False, 'handToMouth': False, 'poseValid': False}
    valid = lambda i: len(points[i]) >= 3 and points[i][2] >= .4
    x1, y1, x2, y2 = box
    width, height = x2-x1, y2-y1
    if width < 12 or height < 24:
        return {'lowPosture': False, 'handToMouth': False, 'poseValid': False}
    legs = [(11, 13, 15), (12, 14, 16)]
    squat = any(all(valid(i) for i in leg) and angle(*(points[i] for i in leg)) < 110 and
                abs(points[leg[0]][1]-points[leg[1]][1]) < height*.3 for leg in legs)
    torso = all(valid(i) for i in [5, 6, 11, 12])
    lying = False
    if torso:
        sx, sy = (points[5][0]+points[6][0])/2, (points[5][1]+points[6][1])/2
        hx, hy = (points[11][0]+points[12][0])/2, (points[11][1]+points[12][1])/2
        lying = abs(sx-hx) > max(8, abs(sy-hy)*1.2) and width/height > .85
    hand = valid(0) and any(valid(i) and math.dist(points[i][:2], points[0][:2]) <= max(10, height*.16) for i in [9, 10])
    return {'lowPosture': bool(squat or lying), 'handToMouth': bool(hand), 'poseValid': bool(torso),
            'poseObservation': '蹲下/坐姿候选' if squat else '倒地姿态候选' if lying else '手靠近口鼻' if hand else '未见目标动作'}


def helmet_matches(person, helmet):
    """Associate helmet to upper third of a person, not whole-body IoU."""
    x1, y1, x2, y2 = person
    a, b, c, d = helmet
    return c-a >= 5 and d-b >= 5 and x1 <= (a+c)/2 <= x2 and y1-(y2-y1)*.1 <= (b+d)/2 <= y1+(y2-y1)*.35
