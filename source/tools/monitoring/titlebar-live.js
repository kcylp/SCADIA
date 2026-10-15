var m = window.__monitor;
var user = null;
try { user = JSON.parse(sessionStorage.getItem('currentUser') || 'null'); } catch (_) {}
if (m) {
    var tr = m.data.tracks, fresh = tr && Date.now() - tr.updatedAt < 8000 && !m.errors.tracks;
    document.querySelectorAll('[data-field="clock"]').forEach(function (e) { e.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); });
    document.querySelectorAll('[data-field="user"]').forEach(function (e) { e.textContent = user && user.username !== 'guest' ? '操作员 · ' + (user.fullname || user.username) : '访客 · 未登录'; });
    document.querySelectorAll('[data-field="engine"]').forEach(function (e) { e.textContent = fresh ? '人员检测 · 已更新' : '人员检测 · 陈旧 / 未取得'; });
    document.querySelectorAll('[data-field="data"]').forEach(function (e) { e.textContent = fresh ? '检测数据 ' + Math.round((Date.now() - tr.updatedAt) / 1000) + ' 秒前' : '检测数据未更新'; });
    document.querySelectorAll('[data-field="alarm-count"]').forEach(function (e) { e.textContent = m.data.alarms && !m.errors.alarms ? '当前报警 ' + m.data.alarms.length : '报警状态待取'; });
    document.querySelectorAll('[data-field="connection"]').forEach(function (e) { e.textContent = m.errors.counts ? '统计读取失败' : m.data.counts ? '统计已取得' : '状态待取'; });
}
