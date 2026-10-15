var m = window.__monitor;
if (m && document.getElementById('vc_card_0')) {
    m.load('alarms', '/api/alarms', 15000, true);
    m.load('history', '/api/alarmsHistory', 30000, true);
    m.load('shots', '/_images/alarm-shots/index.json', 15000);
    var seen = {}, rows = [];
    (m.data.alarms || []).concat(m.data.history || []).forEach(function (a) {
        var key = String(a.name || '').split('^~^')[0] + '|' + String(a.type || '') + '|' + a.ontime;
        if (!seen[key]) { seen[key] = true; rows.push(a); }
    });
    rows.sort(function (a, b) { return Number(b.ontime) - Number(a.ontime); });
    var prio = { highhigh: '高高限', high: '高', low: '低', lowlow: '低低限', message: '提示' };
    for (var i = 0; i < 3; i++) {
        var a = rows[i], kind = a ? String(a.name || '').split('^~^')[0] : '';
        var date = a && Number(a.ontime) > 0 ? new Date(Number(a.ontime)) : null;
        var values = a ? [date && !isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—', a.channel || a.camera || '未关联', kind + ' · ' + (prio[a.type] || a.type || '未标级'), a.text || '无描述'] : ['—', '未关联', '—', m.errors.alarms || m.errors.history ? '报警读取失败，请检查权限或连接' : '暂无报警记录'];
        // Historical shots carry type and time; match only within a bounded event window.
        var shots = m.data.shots && m.data.shots.shots || [];
        var shot = a && shots.filter(function (s) { return s.label === kind && Math.abs(Number(s.at) - Number(a.ontime)) < 15000; }).sort(function (x, y) { return Math.abs(x.at - a.ontime) - Math.abs(y.at - a.ontime); })[0];
        var image = document.getElementById('vc_shot_' + i), empty = document.getElementById('vc_empty_' + i);
        if (shot && /^\/_images\/alarm-shots\/[^/]+\.(jpg|png)$/i.test(shot.url)) {
            image.setAttribute('href', shot.url); image.style.display = ''; empty.style.display = 'none';
            image.onerror = function () { this.style.display = 'none'; var placeholder = document.getElementById(this.id.replace('vc_shot_', 'vc_empty_')); if (placeholder) { placeholder.textContent = '抓拍加载失败'; placeholder.style.display = ''; } };
            image.onload = function () { var placeholder = document.getElementById(this.id.replace('vc_shot_', 'vc_empty_')); if (placeholder) { placeholder.textContent = '暂无对应抓拍'; placeholder.style.display = 'none'; } };
        } else { image.removeAttribute('href'); image.style.display = 'none'; empty.textContent = '暂无对应抓拍'; empty.style.display = ''; }
        for (var f = 0; f < 4; f++) {
            var e = document.getElementById('vc_value_' + i + '_' + f); if (!e) { continue; }
            e.replaceChildren();
            var txt = String(values[f]), max = f === 3 ? 23 : 25;
            [txt.slice(0, max), txt.slice(max, max * 2)].forEach(function (line, n) { if (line) { e.appendChild(m.node('tspan', { x: e.getAttribute('x'), dy: n ? 16 : 0 }, line)); } });
            e.setAttribute('aria-label', txt);
            var titleId = 'vc_title_' + i + '_' + f, title = document.getElementById(titleId);
            if (!title) { title = m.node('title', { id: titleId }); e.parentNode.appendChild(title); }
            title.textContent = txt; e.setAttribute('aria-describedby', titleId);
        }
        var current = a && (m.data.alarms || []).find(function (x) { return x.name === a.name && Number(x.ontime) === Number(a.ontime); });
        var acked = a && (Number(a.acktime) > 0 || String(a.status || '').indexOf('A') >= 0);
        var state = document.getElementById('vc_state_' + i);
        if (state) { state.textContent = m.errors.alarms || m.errors.history ? '部分数据读取失败 · 显示缓存' : '最新报警 ' + (i + 1) + (a ? acked ? ' · 已确认' : current ? ' · 待确认' : ' · 历史记录' : ''); }
        var hostId = 'vc_ack_' + i, host = document.getElementById(hostId);
        if (!host) {
            host = m.node('foreignObject', { id:hostId, x:1168, y:65+i*292+218, width:180, height:44 });
            var button = document.createElement('button'); button.type = 'button';
            button.style.cssText = 'width:100%;min-height:40px;background:#214f79;color:#fff;border:1px solid #92b6d8;border-radius:4px;cursor:pointer;font:14px Microsoft YaHei,sans-serif';
            host.appendChild(button); document.getElementById('vc_card_'+i).appendChild(host);
        }
        host.firstChild.textContent = acked ? '已确认' : current ? '确认此报警' : '查看当前报警';
        host.firstChild.disabled = !a || acked || !!m.errors.alarms;
        (function (row, live, button) { button.onclick = function () { if (m.openAlarms) { m.openAlarms(live ? row.name : undefined, live ? row.ontime : undefined); } }; })(a,current,host.firstChild);
    }
}
