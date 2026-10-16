var m = window.__monitor;
if (m) {
    var now = Date.now();
    m.panes().forEach(function (p) {
        var thermal = m.thermal(p), key = thermal ? 'thermalTracks' : 'tracks';
        var j = m.data[key];
        // Camera identity and modality must agree before any coordinates are reused.
        var cameraId = p.getAttribute('data-camera-id');
        var matches = j && cameraId && j.camera === cameraId && j.streamKind === (thermal ? 'thermal' : 'visible');
        var fresh = matches && Number(j.updatedAt) > now - 8000 && Number(j.updatedAt) <= now + 5000 && !m.errors[key];
        var dets = fresh ? (j.detections || []) : [];
        var stores = m.trailStores = m.trailStores || {};
        var trails = stores[key] = stores[key] || {};
        if (!fresh) { stores[key] = trails = {}; }
        dets.forEach(function (d) {
            if (!d.id || !d.region) { return; }
            var t = trails[d.id] = trails[d.id] || { points: [] };
            if (t.ts !== d.timestamp) { t.points.push({ x: d.region.x + d.region.w / 2, y: d.region.y + d.region.h }); t.points = t.points.slice(-30); }
            t.at = now; t.ts = d.timestamp;
        });
        Object.keys(trails).forEach(function (k) { if (now - trails[k].at > 5000) { delete trails[k]; } });
        var layer = m.layer(p, 'detection_' + p.id), b = m.box(p);
        if (!thermal) {
            var f = m.data.fence;
            if (f && f.camera === cameraId && f.points && f.points.length >= 3) {
                var scale = f.scale || 1000;
                var pts = f.points.map(function (q) { return (b.x + q[0] / scale * b.w) + ',' + (b.y + q[1] / scale * b.h); });
                layer.appendChild(m.node('polygon', { points: pts.join(' '), fill: 'none', stroke: '#35e08a', 'stroke-width': 2 }));
            }
        }
        dets.forEach(function (d) {
            var r = d.region; if (!r) { return; }
            layer.appendChild(m.node('rect', { x: b.x + r.x * b.w, y: b.y + r.y * b.h, width: r.w * b.w, height: r.h * b.h, fill: 'none', stroke: thermal ? '#ffc857' : '#36e6b0', 'stroke-width': 2 }));
            layer.appendChild(m.node('text', { x: b.x + r.x * b.w + 4, y: Math.max(b.y + 58, b.y + r.y * b.h - 5), fill: '#fff', 'font-size': 13 }, String(d.label || '人员') + (d.id ? ' #' + d.id : '')));
        });
        Object.keys(trails).forEach(function (k) {
            layer.appendChild(m.node('polyline', { points: trails[k].points.map(function (q) { return (b.x + q.x * b.w) + ',' + (b.y + q.y * b.h); }).join(' '), fill: 'none', stroke: '#ffc857', 'stroke-width': 2 }));
        });
        var status = thermal ? (fresh ? '红外辅助检测已更新 · 候选 ' + dets.length + ' 人' : '红外检测数据陈旧 / 不可用') : (fresh ? '人员检测已更新 · 当前 ' + dets.length + ' 人' : '人员检测数据陈旧 / 不可用');
        if (j && !matches) { status = '检测源与视频通道不匹配，已隐藏坐标'; }
        layer.appendChild(m.node('rect', { x: +p.getAttribute('x'), y: +p.getAttribute('y') + 27, width: Math.min(420, +p.getAttribute('width')), height: thermal ? 40 : 22, fill: '#071322', opacity: .9 }));
        layer.appendChild(m.node('text', { x: +p.getAttribute('x') + 8, y: +p.getAttribute('y') + 43, fill: fresh ? '#a7f3d0' : '#ffd166', 'font-size': 12 }, status));
        if (thermal) { layer.appendChild(m.node('text', { x: +p.getAttribute('x') + 8, y: +p.getAttribute('y') + 60, fill: '#ffd166', 'font-size': 12 }, '通用人员模型 · 非测温 / 火点判断，需现场标定')); }
    });
}
