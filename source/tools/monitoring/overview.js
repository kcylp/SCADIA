var m = window.__monitor;
if (m) {
    var tr = m.data.tracks, fresh = tr && Date.now() - tr.updatedAt < 8000 && !m.errors.tracks;
    m.set('ov_eng', fresh ? '检测更新 · 当前 ' + (tr.detections || []).length + ' 人' : '检测数据陈旧 / 不可用');
    m.set('ov_track', fresh ? Object.keys((m.trailStores || {}).tracks || {}).filter(function (id) { return Date.now() - m.trailStores.tracks[id].at <= 5000; }).length + ' 条在用轨迹' : '—（检测源未更新）');
    m.set('ov_fence', m.data.fence && m.data.fence.points ? '已配置 · 可见光检测区' : '未取得围栏配置');
    m.set('ov_ch', '2 路源 · 可见光 / 热成像');
    var stats = m.data.video && m.data.video.sources || {};
    m.set('ov_cam', m.errors.video ? '视频代理不可达' : Object.keys(stats).length ? '视频代理已响应 · 详见视频页' : '视频状态未取得');
    if (document.getElementById('ov_a0_0')) { m.load('alarms', '/api/alarms', 15000, true); }
    var rows = (m.data.alarms || []).slice().sort(function (a, b) { return b.ontime - a.ontime; });
    for (var r = 0; r < 5; r++) {
        var a = rows[r], values = a ? [Number(a.ontime) > 0 ? new Date(Number(a.ontime)).toLocaleString() : '—', a.channel || a.camera || '未关联', String(a.name || '').split('^~^')[0], Number(a.acktime) > 0 || String(a.status || '').indexOf('A') >= 0 ? '已确认' : '未确认'] : ['—', '—', '—', '—'];
        for (var c = 0; c < 4; c++) { m.set('ov_a' + r + '_' + c, values[c]); }
    }
    if (!rows.length) { m.set('ov_a0_0', m.errors.alarms ? '报警读取失败' : '暂无当前报警'); }
}
