var m = window.__monitor;
if (m) {
    if (window.__aiOpsPoll) { clearInterval(window.__aiOpsPoll); window.__aiOpsPoll = null; }
    ['aiops-clear', 'aiops-mask', 'aiops-style'].forEach(function (id) { var old = document.getElementById(id); if (old) { old.remove(); } });
    m.isAcked = function (a) { return Number(a.acktime) > 0 || String(a.status || '').indexOf('A') >= 0; };
    m.openAlarms = function (name, ontime) {
        if (document.getElementById('alarm-confirm-dialog')) { return; }
        var d = document.createElement('dialog'); d.id = 'alarm-confirm-dialog';
        d.style.cssText = 'box-sizing:border-box;width:min(760px,94vw);max-height:85vh;overflow:auto;background:#14243a;color:#eef5ff;border:1px solid #6a87a4;padding:24px;font:15px Microsoft YaHei,sans-serif';
        d.innerHTML = '<h2 style="margin:0 0 12px">报警确认</h2><p>确认表示操作员已知晓，不会解除现场报警，也不会清除历史、抓拍或事件计数。</p><p role="status" aria-live="polite">正在读取当前报警…</p><div data-rows></div><button type="button" data-refresh>刷新</button> <button type="button" data-close>关闭</button>';
        var status = d.querySelector('[role=status]'), list = d.querySelector('[data-rows]');
        var buttonStyle = 'min-height:36px;padding:6px 14px;background:#214f79;color:#fff;border:1px solid #92b6d8;border-radius:4px;cursor:pointer';
        d.querySelectorAll('button').forEach(function (b) { b.style.cssText = buttonStyle; });
        d.querySelector('[data-close]').onclick = function () { d.close(); };
        var loading = false;
        var load = async function () {
            if (loading) { return false; }
            loading = true; m.pending.alarms = true;
            m.versions = m.versions || {};
            var version = m.versions.alarms = (m.versions.alarms || 0) + 1;
            try {
                var r = await fetch('/api/alarms', { headers: m.headers(), cache: 'no-store', signal: AbortSignal.timeout(8000) });
                if (!r.ok) { throw new Error(r.status === 401 || r.status === 403 ? '登录或权限不足' : 'HTTP ' + r.status); }
                var rows = await r.json(); if (!Array.isArray(rows)) { throw new Error('报警响应格式异常'); }
                if (version !== m.versions.alarms) { throw new Error('报警状态已刷新，请重试'); }
                m.data.alarms = rows; m.at.alarms = Date.now(); delete m.errors.alarms;
                list.replaceChildren();
                var selected = rows.filter(function (a) { return !name || a.name === name && Number(a.ontime) === Number(ontime); });
                status.textContent = selected.length ? '当前范围共 ' + selected.length + ' 条，未确认 ' + selected.filter(function (a) { return !m.isAcked(a); }).length + ' 条。' : name ? '该报警已恢复或已发生新事件，请刷新报警列表。' : '暂无当前报警。';
                selected.forEach(function (a) {
                    var row = document.createElement('div'); row.style.cssText = 'padding:14px 0;border-top:1px solid #385877;display:flex;gap:16px;align-items:center';
                    var text = document.createElement('div'); text.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere';
                    text.textContent = String(a.name || '').split('^~^')[0] + ' · ' + new Date(Number(a.ontime)).toLocaleString('zh-CN', { hour12:false }) + ' · ' + (a.text || '无描述');
                    var b = document.createElement('button'); b.type = 'button'; b.style.cssText = buttonStyle;
                    b.textContent = m.isAcked(a) ? '已确认' : '确认报警'; b.disabled = m.isAcked(a);
                    b.onclick = async function () {
                        b.disabled = true; b.textContent = '正在确认…';
                        try {
                            // Revalidate the event before the legacy name-keyed ACK endpoint.
                            var check = await fetch('/api/alarms', { headers:m.headers(), cache:'no-store', signal:AbortSignal.timeout(8000) });
                            if (!check.ok) { throw new Error('无法核验报警状态：HTTP ' + check.status); }
                            var current = (await check.json()).find(function (x) { return x.name === a.name && Number(x.ontime) === Number(a.ontime); });
                            if (!current) { throw new Error('报警已变化，请刷新后重新选择'); }
                            if (!m.isAcked(current)) {
                                var ack = await fetch('/api/alarmack', { method:'POST', headers:Object.assign({'Content-Type':'application/json'},m.headers()), body:JSON.stringify({params:a.name,expectedOntime:Number(a.ontime)}), signal:AbortSignal.timeout(8000) });
                                if (!ack.ok) { throw new Error(ack.status === 409 ? '报警已变化，请刷新重新选择' : ack.status === 401 || ack.status === 403 ? '登录或权限不足' : 'HTTP ' + ack.status); }
                            }
                            if (!await load()) { throw new Error('确认请求已提交，但服务器回读失败，请刷新核验'); }
                            var saved = (m.data.alarms || []).find(function (x) { return x.name === a.name && Number(x.ontime) === Number(a.ontime); });
                            if (saved && !m.isAcked(saved)) { throw new Error('回读尚未确认，请刷新核验'); }
                            status.textContent = saved ? '已确认，服务器回读通过。现场是否恢复请继续核实。' : '确认请求已提交，当前报警已变化，请核验历史记录。';
                            m.at.history = 0;
                        } catch (e) { status.textContent = '确认失败：' + e.message + '。可刷新后重试。'; b.disabled = false; b.textContent = '重试确认'; }
                    };
                    row.append(text,b); list.appendChild(row);
                });
                return true;
            } catch (e) { status.textContent = '读取失败：' + e.message + '。请检查登录与连接后刷新。'; return false; }
            finally { loading = false; if (version === m.versions.alarms) { m.pending.alarms = false; } }
        };
        d.querySelector('[data-refresh]').onclick = load;
        d.onclose = function () { d.remove(); };
        (document.fullscreenElement || document.body).appendChild(d); d.showModal(); load();
    };
    var ackEntry = document.getElementById('alarm-confirm-entry');
    if (!ackEntry) {
        ackEntry = document.createElement('button'); ackEntry.id = 'alarm-confirm-entry'; ackEntry.type = 'button';
        ackEntry.style.cssText = 'position:fixed;right:180px;bottom:24px;z-index:100;min-height:40px;padding:10px 16px;background:#16385b;color:#fff;border:1px solid #85b9e9;border-radius:4px;cursor:pointer';
        ackEntry.onclick = function () { m.openAlarms(); };
        (document.fullscreenElement || document.body).appendChild(ackEntry);
    }
    var hasHmi = !!document.querySelector('#content>svg');
    var sceneNav = document.getElementById('scene-navigation');
    if (!sceneNav) {
        sceneNav = document.createElement('nav'); sceneNav.id = 'scene-navigation'; sceneNav.setAttribute('aria-label','视频分析导航');
        sceneNav.style.cssText = 'position:fixed;right:24px;top:78px;z-index:100;display:flex;gap:8px;background:#10243a;padding:6px;border:1px solid #6585a4;border-radius:4px';
        [['八场景分析','/scenes'],['人员统计','/people']].forEach(function(item){var a=document.createElement('a');a.textContent=item[0];a.href=item[1];a.style.cssText='color:#edf4fc;padding:7px 10px;text-decoration:underline;text-underline-offset:3px';sceneNav.appendChild(a);});
        document.body.appendChild(sceneNav);
    }
    sceneNav.style.display = hasHmi ? 'flex' : 'none';
    ackEntry.style.display = hasHmi ? '' : 'none';
    ackEntry.textContent = m.data.alarms && !m.errors.alarms ? '报警确认（' + m.data.alarms.filter(function (a) { return !m.isAcked(a); }).length + '）' : '报警确认 / 状态待取';
    document.querySelectorAll('[data-field="alarm-count"]').forEach(function (e) {
        e.style.cursor = 'pointer'; e.setAttribute('role','button'); e.setAttribute('tabindex','0'); e.setAttribute('aria-label','打开报警确认');
        e.onclick = function () { m.openAlarms(); }; e.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); m.openAlarms(); } };
    });
    var show = document.getElementById('ov_n0') || document.getElementById('db_today_0') || document.getElementById('svg_72a58550-cebb43d5');
    var btn = document.getElementById('all-count-reset');
    if (!btn) {
        btn = document.createElement('button'); btn.id = 'all-count-reset'; btn.type = 'button';
        btn.textContent = '全部计数清零'; btn.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:100;padding:10px 16px;background:#16385b;color:#fff;border:1px solid #85b9e9;border-radius:4px;cursor:pointer';
        (document.fullscreenElement || document.body).appendChild(btn);
        btn.onclick = function () {
            if (m.resetBusy || document.getElementById('counter-dialog')) { return; }
            var d = document.createElement('dialog'); d.id = 'counter-dialog';
            d.style.cssText = 'max-width:440px;background:#14243a;color:#eef5ff;border:1px solid #6a87a4;padding:24px';
            d.innerHTML = '<h2>全部事件计数清零</h2><p>清空所有事件类型的今日和累计计数，包括别名及其他事件，所有统计页同步刷新。</p><p>报警记录、抓拍、当前报警和当前检测人数会保留。</p><p role="status"></p><button type="button">取消</button> <button type="button">确定清零</button>';
            var buttons = d.querySelectorAll('button'), msg = d.querySelector('[role=status]');
            buttons[0].onclick = function () { d.close(); };
            buttons[1].onclick = async function () {
                m.resetBusy = true; buttons[1].disabled = true; msg.textContent = '正在清零…';
                try {
                    var r = await fetch('/api/ai/events/reset', { method: 'POST', headers: m.headers(), signal: AbortSignal.timeout(8000) });
                    var body = await r.json();
                    if (!r.ok || body.status !== 'ok' || body.error) { throw new Error(r.status === 401 || r.status === 403 ? '需要管理员登录' : body.message || '清零未全部成功'); }
                    m.epoch = (m.epoch || 0) + 1; m.data.counts = body.counts; m.at.counts = 0;
                    msg.textContent = '全部事件统计已清零；此后新事件会重新计数。'; buttons[0].textContent = '关闭';
                } catch (e) { msg.textContent = '清零失败：' + e.message + '。请检查登录或连接后重试。'; buttons[1].disabled = false; }
                finally { m.resetBusy = false; }
            };
            d.onclose = function () { d.remove(); };
            (document.fullscreenElement || document.body).appendChild(d); d.showModal();
        };
    }
    btn.style.display = show ? '' : 'none';
    [btn,ackEntry].forEach(function (b) { var host = document.fullscreenElement || document.body; if (b.parentNode !== host) { host.appendChild(b); } });
}
