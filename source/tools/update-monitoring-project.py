"""Apply the monitoring UI correction to selected project records through the platform API."""
import copy
import datetime
import json
import pathlib
import sqlite3
import urllib.request
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[2]
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')


def node(parent, tag, text=None, **attrs):
    e = ET.SubElement(parent, '{' + NS + '}' + tag, {k.replace('_', '-'): str(v) for k, v in attrs.items()})
    if text is not None:
        e.text = text
    return e


def label(parent, x, y, text, id=None, size=16, color='#e8f0fa'):
    attrs = dict(x=x, y=y, font_size=size, fill=color, font_family='Microsoft YaHei')
    if id:
        attrs['id'] = id
    return node(parent, 'text', text, **attrs)


def main_content(root):
    existing = next((e for e in root.iter() if e.get('transform') == 'translate(150,87)'), None)
    return existing if existing is not None else list(root)[0]


def video_content(g):
    for e in list(g):
        g.remove(e)
    label(g, 32, 38, '双光视频监控 · 最新三条报警', size=24)
    # Verified source sizes: visible 704x576, thermal 384x288. Keep the frame as well
    # as the image close to its source ratio; a wide letterbox is not a second camera.
    for id, x, y, w, h in [('vc_video_1', 34, 180, 520, 426), ('vc_video_thermal', 590, 198, 520, 390)]:
        node(g, 'rect', x=x-2, y=y-2, width=w+4, height=h+4, rx=6, fill='#050b14', stroke='#385877')
        node(g, 'image', id=id, x=x, y=y, width=w, height=h, preserveAspectRatio='xMidYMid meet', href='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=')
    for i in range(3):
        y = 65 + i * 292
        card = node(g, 'g', id='vc_card_' + str(i))
        node(card, 'rect', x=1150, y=y, width=590, height=278, rx=6, fill='#102a44', stroke='#385877')
        label(card, 1168, y+24, '正在读取报警…', id='vc_state_' + str(i), size=14)
        node(card, 'image', id='vc_shot_'+str(i), x=1168, y=y+36, width=180, height=110, preserveAspectRatio='xMidYMid meet')
        label(card, 1168, y+90, '暂无对应抓拍', id='vc_empty_'+str(i), size=14, color='#b6c8dc')
        for f, text in enumerate(['发生时间', '报警通道', '类型 / 级别', '报警描述']):
            fy = y+55+f*49
            label(card, 1364, fy, text, size=13, color='#b6c8dc')
            label(card, 1364, fy+18, '—', id='vc_value_'+str(i)+'_'+str(f), size=14)
    label(g, 32, 963, '双光视频分别显示，检测框与轨迹按各自通道独立关联。', size=15, color='#b6c8dc')


def data_content(g):
    for e in list(g):
        g.remove(e)
    label(g, 40, 58, '事件统计 · 今日与累计', size=26)
    label(g, 40, 100, '—', id='db_time', size=16, color='#b6c8dc')
    for i, name in enumerate(['区域入侵', '遮挡报警', '移动侦测', '视频丢失']):
        y = 170+i*130
        node(g, 'rect', x=40, y=y-42, width=1650, height=108, rx=6, fill='#102a44', stroke='#385877')
        label(g, 65, y, name, size=22)
        label(g, 610, y, '今日 UTC', size=16, color='#b6c8dc')
        label(g, 800, y, '—', id='db_today_'+str(i), size=24)
        label(g, 1130, y, '累计', size=16, color='#b6c8dc')
        label(g, 1340, y, '—', id='db_total_'+str(i), size=24)
    label(g, 40, 744, '—', id='db_other', size=18)
    label(g, 40, 804, '统计事件次数，不代表当前报警或当前检测人数。', size=17, color='#b6c8dc')
    label(g, 40, 850, '历史趋势：本页尚未绑定真实历史序列。', size=17, color='#b6c8dc')


def changed_view(v):
    v = copy.deepcopy(v)
    r = ET.fromstring(v['svgcontent'])
    parents = {e: p for p in r.iter() for e in p}
    # Size is defined by the actual SVG, not a stale editor profile (notably the shot page).
    v.setdefault('profile', {}).update(width=float(r.get('width')), height=float(r.get('height')), scaleMode='contain')
    # These three raster templates already contain the old menu/header/body labels.
    # Keep one vector layer instead of painting two versions on top of one another.
    ghost_images = ['svg_1f00935c-1c584f2d', 'svg_a2d6af4b-2aad402b', 'svg_2f47c4cf-a7f44d07', 'svg_f6dbb58b-df964331', 'svg_f27eed48-7a9449e0']
    for e in list(r.iter()):
        id = e.get('id', '')
        if e.tag.endswith('image') and (id in ghost_images or id.startswith('svg_backdrop_')):
            e.tag = '{'+NS+'}rect'
            e.attrib.pop('href', None)
            e.attrib.pop('{http://www.w3.org/1999/xlink}href', None)
            e.set('fill', '#0a1017')
        if e.get('data-field') == 'connection' or (e.tag.endswith('text') and ''.join(e.itertext()).strip() == '连接正常'):
            # Old status occupied the MES baseline. Its sibling dot/divider must move too.
            y = float(e.get('y', '0'))
            if y < 800:
                dy = 900 - y
                e.set('y', '900')
                siblings = list(parents[e])
                index = siblings.index(e)
                for sibling in siblings[max(0, index-2):index]:
                    if sibling.tag.endswith('circle'):
                        sibling.set('cy', str(float(sibling.get('cy')) + dy))
                    elif sibling.tag.endswith('line'):
                        for attr in ['y1', 'y2']:
                            sibling.set(attr, str(float(sibling.get(attr)) + dy))
        if id in ['nav_mes_icon', 'nav_ems_icon']:
            parents[e].remove(e)
        if id in ['svg_nav_mes_label', 'svg_nav_ems_label']:
            e.set('x', '32')
        if e.tag.endswith('text'):
            text = ''.join(e.itertext()).strip()
            field = None
            if text.startswith('AI 推理'): field = 'engine'
            elif text.startswith(('数据 ', 'YOLOv8', '抓拍约')): field = 'data'
            elif text.startswith('未确认'): field = 'alarm-count'
            elif text.startswith(('值班员 ·', '管理员 ·')): field = 'user'
            elif text == '连接正常': field = 'connection'
            elif len(text) == 8 and text[2] == ':' and text[5] == ':': field = 'clock'
            if field: e.set('data-field', field)
        if e.tag.endswith('image') and id in ['svg_72a58550-cebb43d5','svg_a04071af-964841aa','svg_bd400e8b-0ac3445b','svg_3e127f1a-eea34106']:
            e.set('href', 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=')
            e.attrib.pop('{http://www.w3.org/1999/xlink}href', None)
            e.set('preserveAspectRatio', 'xMidYMid meet')
    if v['id'] == 'v_zc_g5':
        layer = next(e for e in r.iter() if e.get('id') == 'aq_layer')
        if not any(e.get('id') == 'aq_prev' for e in layer):
            for id, x, text in [('aq_prev', 1460, '上一页'), ('aq_next', 1620, '下一页')]:
                group = node(layer, 'g', id=id, style='cursor:pointer')
                node(group, 'rect', x=x, y=930, width=130, height=42, rx=4, fill='#102a44', stroke='#92b6d8')
                label(group, x+32, 958, text, size=16)
        for e in layer.iter():
            if e.tag.endswith('text') and e.get('fill') in ['#54687c', '#6f8296', '#7f93a6']:
                e.set('fill', '#b6c8dc')
    if v['id'] == 'v_zc_g4': video_content(main_content(r))
    if v['id'] == 'v_zc_g2': data_content(main_content(r))
    with sqlite3.connect(str(ROOT/'project/_appdata/cameras.db')) as cameras:
        camera_ids = dict(cameras.execute('select channel,id from cameras where enabled=1').fetchall())
    for e in r.iter():
        id = e.get('id', '')
        if id in ['vc_video_1','vc_video_thermal','svg_72a58550-cebb43d5','svg_a04071af-964841aa','svg_bd400e8b-0ac3445b','svg_3e127f1a-eea34106']:
            channel = 2 if any(s in id for s in ['thermal','bd400e8b','3e127f1a']) else 1
            e.set('data-camera-id', camera_ids.get(channel, 'unconfigured'))
    # The application shell now owns the header and navigation. Keep only business
    # layers; retaining the old drawing underneath would duplicate menus and status.
    layer_id = {'v_zc_g5': 'aq_layer', 'v_zc_g6': 'sp_layer'}.get(v['id'])
    content = next((e for e in r.iter() if e.get('id') == layer_id), None) if layer_id else None
    if v['id'] == 'v_zc_g2':
        content = main_content(r)
    if content is not None:
        business = copy.deepcopy(content)
        business.attrib.pop('transform', None)
        for child in list(r):
            r.remove(child)
        r.append(business)
        # Alarm and snapshot layers use absolute original coordinates.
        viewbox = '0 0 1770 993' if v['id'] == 'v_zc_g2' else '150 87 1770 993'
        r.set('viewBox', viewbox)
        r.set('width', '1770')
        r.set('height', '993')
        v['profile'].update(width=1770, height=993)
    v['svgcontent'] = ET.tostring(r, encoding='unicode')
    ET.fromstring(v['svgcontent'])
    return v


def request(path, body, token=None):
    h = {'Content-Type': 'application/json'}
    if token: h['x-access-token'] = token
    req = urllib.request.Request('http://127.0.0.1:1881'+path, data=json.dumps(body).encode(), headers=h)
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


def configure_trackers(backups):
    cfg_dir = ROOT/'project/_appdata'
    visible_path = cfg_dir/'ai-tracker.json'
    (backups/visible_path.name).write_bytes(visible_path.read_bytes())
    visible = json.loads(visible_path.read_text(encoding='utf-8'))
    visible['source'] = {'snapshot': 'http://127.0.0.1:1886/snapshot/kuangqu1'}
    visible['streamKind'] = 'visible'
    visible['publicFile'] = 'ai-tracks.json'
    visible_path.write_text(json.dumps(visible, ensure_ascii=False, indent=2), encoding='utf-8')
    with sqlite3.connect(str(cfg_dir/'cameras.db')) as cameras:
        camera = cameras.execute('select id from cameras where channel=2 and enabled=1').fetchone()
    if not camera:
        raise RuntimeError('No enabled thermal channel; configure camera first')
    thermal_path = cfg_dir/'ai-tracker-thermal.json'
    if thermal_path.exists(): (backups/thermal_path.name).write_bytes(thermal_path.read_bytes())
    thermal = copy.deepcopy(visible)
    thermal.update(cameraId=camera[0], streamKind='thermal', publicFile='ai-tracks-thermal.json',
                   source={'snapshot': 'http://127.0.0.1:1886/snapshot/kuangqu1-thermal'},
                   targetFps=4, conf=0.45, label='人员候选（红外辅助）',
                   intrusion={'enabled': False}, fall={'enabled': False}, helmet={'enabled': False})
    thermal_path.write_text(json.dumps(thermal, ensure_ascii=False, indent=2), encoding='utf-8')
    proxy_path = cfg_dir/'mjpeg-sources.json'
    (backups/proxy_path.name).write_bytes(proxy_path.read_bytes())
    proxy = json.loads(proxy_path.read_text(encoding='utf-8'))
    for source in proxy.get('sources', []):
        if source['name'] == 'kuangqu1': source['cameraId'] = visible['cameraId']
        elif source['name'] == 'kuangqu1-thermal': source['cameraId'] = thermal['cameraId']
    proxy_path.write_text(json.dumps(proxy, ensure_ascii=False, indent=2), encoding='utf-8')


def apply():
    db = ROOT/'project/_appdata/project.scadiap.db'
    conn = sqlite3.connect(str(db))
    backups = ROOT/'project/_backups'/('monitoring-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backups.mkdir(parents=True)
    with sqlite3.connect(str(backups/'project.scadiap.db')) as dest: conn.backup(dest)
    views = {n: json.loads(v) for n, v in conn.execute('select name,value from views')}
    scripts = {n: json.loads(v) for n, v in conn.execute('select name,value from scripts')}
    layout = json.loads(conn.execute("select value from general where name='layout'").fetchone()[0])
    for item in layout['navigation']['items']:
        if item['id'] in ['nav_mes','nav_ems']: item['icon'] = ''
    target_views = {k: changed_view(v) for k, v in views.items()}
    files = {'s_camera_live':'camera-live','s_live_overlay':'live-overlay','s_ai_boxes':'ai-boxes','s_data_board':'data-board','s_overview':'overview','s_pane_titles':'pane-titles','s_vlm_captions':'vlm-captions','s_video_cards':'video-cards','s_alarm_ops':'alarm-ops','s_titlebar_live':'titlebar-live','s_alarm_query':'alarm-query'}
    for id, file in files.items():
        scripts[id]['code'] = (ROOT/'source/tools/monitoring'/ (file+'.js')).read_text(encoding='utf-8')
    # Establish a deterministic polling and drawing order within the existing scheduler.
    order = list(files)
    layout['start'] = layout.get('start', 'v_zc_g1')
    layout['viewScaleMode'] = 'contain'
    cfg = json.loads((ROOT/'project/_appdata/video-events.json').read_text(encoding='utf-8'))
    login = request('/api/signin', {'username':cfg['user'], 'password':cfg['password']})
    token = login['data']['token']
    for k, v in target_views.items():
        if v != views[k]: request('/api/projectData', {'cmd':'set-view','data':v}, token)
    request('/api/projectData', {'cmd':'layout','data':layout}, token)
    for k in order: request('/api/projectData', {'cmd':'set-script','data':scripts[k]}, token)
    demo = ROOT/'project/_demos/demo-kuangqu.json'
    data = json.loads(demo.read_text(encoding='utf-8'))
    (backups/'demo-kuangqu.json').write_bytes(demo.read_bytes())
    # The demo HMI is stored at the root; only corresponding UI records are synchronized.
    for k in target_views:
        if isinstance(data['hmi']['views'], list):
            for i, v in enumerate(data['hmi']['views']):
                if v['id'] == k: data['hmi']['views'][i] = target_views[k]
        elif k in data['hmi']['views']: data['hmi']['views'][k] = target_views[k]
    data['hmi']['layout'] = layout
    for k in order:
        if isinstance(data['scripts'], list):
            for i, s in enumerate(data['scripts']):
                if s['id'] == k: data['scripts'][i] = scripts[k]
        else: data['scripts'][k] = scripts[k]
    demo.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    for k in target_views:
        saved = json.loads(conn.execute('select value from views where name=?',(k,)).fetchone()[0])
        assert saved == target_views[k], 'view readback mismatch: '+k
    for k in order:
        saved = json.loads(conn.execute('select value from scripts where name=?',(k,)).fetchone()[0])
        assert saved['code'] == scripts[k]['code'], 'script readback mismatch: '+k
    if '--ui-only' not in __import__('sys').argv:
        configure_trackers(backups)
    print('Updated target UI records and independent tracker configs; SQLite readback passed. Backup:', backups)


if __name__ == '__main__':
    apply()
