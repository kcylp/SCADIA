var m = window.__monitor;
if (m) {
    m.panes().forEach(function (p) {
        var g = m.layer(p, 'pane_title_' + p.id), x = +p.getAttribute('x'), y = +p.getAttribute('y');
        g.appendChild(m.node('rect', { x: x, y: y, width: 230, height: 26, fill: '#071322', opacity: .85 }));
        g.appendChild(m.node('text', { x: x + 8, y: y + 18, fill: '#a2e8ff', 'font-size': 14 }, m.thermal(p) ? '红外 · 热成像画面' : '可见光 · 实时画面'));
    });
}
