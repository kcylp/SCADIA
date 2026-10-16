var m = window.__monitor, root = document.getElementById('aq_layer');
if (m && root) {
    var q = m.query = m.query || { time:'all', status:'new', page:0 };
    m.load('alarms','/api/alarms',15000,true);
    m.load('history','/api/alarmsHistory',30000,true);
    m.load('shots','/_images/alarm-shots/index.json',15000);
    var seen = {}, all = [];
    (m.data.alarms || []).concat(m.data.history || []).forEach(function (a) {
        var key = String(a.name||'').split('^~^')[0] + '|' + a.type + '|' + a.ontime;
        if (!seen[key]) { seen[key] = true; all.push(a); }
    });
    var start = new Date(); start.setHours(0,0,0,0);
    var isAcked = function (a) { return Number(a.acktime) > 0 || String(a.status || '').indexOf('A') >= 0; };
    var rows = all.filter(function (a) {
        if (q.time === 'today' && Number(a.ontime) < +start || q.time === 'week' && Number(a.ontime) < Date.now()-7*86400000) { return false; }
        return q.status === 'all' || (q.status === 'ack' ? isAcked(a) : !isAcked(a));
    }).sort(function (a,b) { return Number(b.ontime)-Number(a.ontime); });
    var pages = Math.max(1,Math.ceil(rows.length/10)); q.page = Math.min(q.page,pages-1);
    m.set('aq_count', (m.errors.alarms || m.errors.history ? '部分报警读取失败，显示已有数据 · ' : '') + '共 '+rows.length+' 条 · 第 '+(q.page+1)+' / '+pages+' 页');
    m.set('aq_hint','确认仅表示已知晓，不解除报警、不删除记录。历史事件不可确认到同名新事件。');
    var bind = function (id, fn, selected) {
        var e = document.getElementById(id); if (!e) { return; }
        e.setAttribute('role','button'); e.setAttribute('tabindex','0');
        e.onclick = fn; e.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fn(); } };
        var rect = e.querySelector('rect'); if (rect) { rect.setAttribute('fill',selected ? '#214f79' : '#102a44'); }
    };
    ['today','week','all'].forEach(function (value) { bind('aq_t_'+value,function () { q.time=value; q.page=0; },q.time===value); });
    ['new','ack','all'].forEach(function (value) { bind('aq_s_'+value,function () { q.status=value; q.page=0; },q.status===value); });
    bind('aq_refresh',function () { m.at.alarms=0; m.at.history=0; });
    bind('aq_prev',function () { q.page=Math.max(0,q.page-1); });
    bind('aq_next',function () { q.page=Math.min(pages-1,q.page+1); });
    var prio = {highhigh:'高高限',high:'高',low:'低',lowlow:'低低限',info:'提示',message:'提示'};
    for (var i=0;i<10;i++) {
        var a=rows[q.page*10+i], kind=a ? (a.sceneId ? a.sceneId + ' · ' + a.sceneName + ' · ' + (a.verdict || '候选待复核') : String(a.name||'').split('^~^')[0]) : '';
        var current=a && (m.data.alarms||[]).some(function (x) { return x.name===a.name && Number(x.ontime)===Number(a.ontime); });
        var values=a ? [new Date(Number(a.ontime)).toLocaleString('zh-CN',{hour12:false}),kind,prio[a.type]||a.type||'—',isAcked(a)?'已确认':current?'待确认':'历史未确认'] : ['—','—','—','—'];
        values.forEach(function (value,f) { var e=document.getElementById('aq_r'+i+'_'+f); if(e) { e.textContent=value.length>30?value.slice(0,29)+'…':value; e.setAttribute('aria-label',value); } });
        var ack=document.getElementById('aq_ack'+i), pic=document.getElementById('aq_pic'+i);
        if(ack) { ack.style.display=a&&!isAcked(a)&&current&&!m.errors.alarms?'':'none'; }
        if(pic) { pic.style.display=a?'':'none'; }
        (function (row, index) {
            bind('aq_ack'+index,function () { if(row && m.openAlarms) { m.openAlarms(row.name,row.ontime); } });
            bind('aq_pic'+index,function () {
                if(!row) { return; }
                if(row.eventId) { if(m.openSceneEvidence) { m.openSceneEvidence(row); } else { m.set('aq_hint','证据详情尚未就绪，请刷新页面重试。'); } return; }
                var kind=String(row.name||'').split('^~^')[0];
                var shot=((m.data.shots||{}).shots||[]).filter(function (s) { return s.label===kind && Math.abs(Number(s.at)-Number(row.ontime))<15000 && /^\/_images\/alarm-shots\/[^/]+\.(jpg|png)$/i.test(s.url); }).sort(function (a,b) { return Math.abs(a.at-row.ontime)-Math.abs(b.at-row.ontime); })[0];
                if(shot) { window.open(shot.url,'_blank','noopener'); } else { m.set('aq_hint','此条报警无时间和类型匹配的抓拍；不会显示其他报警图片。'); }
            });
        })(a,i);
    }
    if (!rows.length) { m.set('aq_r0_1',m.errors.alarms||m.errors.history?'读取失败，请检查登录或连接后刷新':'暂无符合条件的报警'); }
}
