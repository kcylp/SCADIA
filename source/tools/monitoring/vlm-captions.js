var m = window.__monitor;
if (m) {
    m.panes().forEach(function (p) {
        var g = m.layer(p, 'caption_' + p.id), x = +p.getAttribute('x'), y = +p.getAttribute('y'), h = +p.getAttribute('height'), w = +p.getAttribute('width');
        var list = m.data.captions && m.data.captions.captions || [];
        var c = list.filter(function (r) { return r.camera && r.camera === (m.data.tracks && m.data.tracks.camera); }).sort(function (a, b) { return b.ts - a.ts; })[0];
        var text = m.thermal(p) ? '热成像：暂无独立视觉描述' : m.errors.captions ? '视觉描述读取失败' : !c ? '等待对应报警抓拍描述' : Date.now() - c.ts > 900000 ? '历史抓拍描述已陈旧 · ' + Math.round((Date.now() - c.ts) / 60000) + ' 分钟前' : '报警抓拍描述：' + c.text;
        g.appendChild(m.node('rect', { x: x, y: y + h - 40, width: w, height: 40, fill: '#071322', opacity: .88 }));
        var t = m.node('text', { x: x + 8, y: y + h - 22, fill: '#e8f0fa', 'font-size': 12 });
        var chars = Math.max(12, Math.floor((w - 16) / 12));
        [text.slice(0, chars), text.slice(chars, chars * 2)].forEach(function (line, i) { t.appendChild(m.node('tspan', { x: x + 8, dy: i ? 15 : 0 }, line)); });
        t.appendChild(m.node('title', {}, text)); g.appendChild(t);
    });
}
