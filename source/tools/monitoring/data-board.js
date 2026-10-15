var m = window.__monitor;
if (m) {
    var keys = ['fielddetection', 'tamper', 'VMD', 'videoloss'], names = ['区域入侵', '遮挡报警', '移动侦测', '视频丢失'];
    var alias = { shelteralarm: 'tamper', tamperdetection: 'tamper', motiondetection: 'VMD', vmd: 'VMD', badvideo: 'videoloss' };
    m.by = function (raw) { var b = {}; Object.keys(raw || {}).forEach(function (k) { var nk = alias[k] || k; b[nk] = (b[nk] || 0) + Number(raw[k] || 0); }); return b; };
    m.set = function (id, text) { var e = document.getElementById(id); if (e) { e.textContent = String(text); } };
    var counts = m.data.counts, good = counts && !m.errors.counts;
    var today = new Date().toISOString().slice(0, 10);
    var by = m.by(counts && counts.today === today ? counts.byKind : {}), total = m.by(counts && counts.total);
    for (var i = 0; i < 4; i++) {
        m.set('ov_n' + i, good ? by[keys[i]] || 0 : '—');
        m.set('ov_s' + i, names[i] + ' · 事件统计');
        m.set('ov_u' + i, '次 · 今日 UTC');
        m.set('db_today_' + i, good ? by[keys[i]] || 0 : '—');
        m.set('db_total_' + i, good ? total[keys[i]] || 0 : '—');
    }
    Object.keys(total).filter(function (k) { return keys.indexOf(k) < 0; }).forEach(function (k) {});
    var other = Object.keys(total).filter(function (k) { return keys.indexOf(k) < 0; }).reduce(function (n, k) { return n + total[k]; }, 0);
    m.set('db_other', good ? '其他事件累计：' + other + ' 次（包含未归入四类的事件）' : '计数读取失败 / 尚未取得');
    m.set('db_time', good ? '计数更新时间：' + new Date(counts.updatedAt).toLocaleString() + ' · 统计日界 UTC' : '计数尚未取得');
    m.set('ov_brg', good ? new Date(counts.updatedAt).toLocaleString() : '计数读取失败');
    var positions = [[590, 263, 662, 281], [590, 351, 662, 369], [590, 439, 662, 457], [590, 527, 662, 545]];
    if (document.getElementById('svg_72a58550-cebb43d5')) {
        document.querySelectorAll('svg text').forEach(function (e) {
            var x = +e.getAttribute('x'), y = +e.getAttribute('y');
            positions.forEach(function (p, i) {
                if (Math.abs(x - p[0]) < .6 && Math.abs(y - p[1]) < .6) { e.textContent = good ? '今日累计 ' + (by[keys[i]] || 0) + ' 次' : '计数不可用'; }
                if (Math.abs(x - p[2]) < .6 && Math.abs(y - p[3]) < .6) { e.textContent = good ? by[keys[i]] || 0 : '—'; }
            });
            [206, 634, 1062, 1490].forEach(function (cx, i) { if (Math.abs(x - cx) < .6 && y === 1001) { e.textContent = good ? by[keys[i]] || 0 : '—'; } });
        });
    }
}
