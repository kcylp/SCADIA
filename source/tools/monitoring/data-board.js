var m = window.__monitor;
if (m) {
    var ids = ['V1','V2','V3','V4','V5','V6','V7','T1'];
    var names = ['门口进入','蹲下 / 跌倒候选','点烟 / 吸烟候选','戴安全帽事件','人员聚集','原位静止','火苗 / 通道 / 画质','红外辅助'];
    var today = m.data.sceneToday, total = m.data.sceneTotal;
    var good = today && total && !m.errors.sceneToday && !m.errors.sceneTotal;
    var sum = function (data, id, predicate) { return (data && data.groups || []).filter(function (g) { return g.sceneId === id && (!predicate || predicate(g)); }).reduce(function (n,g) { return n+g.count; },0); };
    ids.forEach(function (id,i) {
        m.set('db_today_'+i,good?sum(today,id):'—');
        m.set('db_total_'+i,good?sum(total,id):'—');
        m.set('db_review_'+i,good?sum(today,id,function(g){return g.verdict==='支持';})+' / '+sum(today,id,function(g){return !g.acknowledged;}):'—');
    });
    // Existing four overview slots show pairs, not the obsolete four device-event classes.
    for(var i=0;i<4;i++){
        m.set('ov_n'+i,good?sum(today,ids[i*2])+' / '+sum(today,ids[i*2+1]):'—');
        m.set('ov_s'+i,ids[i*2]+' '+names[i*2]+' / '+ids[i*2+1]+' '+names[i*2+1]);
        m.set('ov_u'+i,'候选数 · 站点今日');
    }
    m.set('db_other',good?'八场景候选总数：今日 '+today.count+' / 历史 '+total.count+'（非去重事故数）':'统计读取失败或尚未取得，不代表零事件');
    m.set('db_time',good?'统计更新 '+new Date(today.generatedAt).toLocaleString()+' · '+today.timezone+' · 站点日界':'统计不可用');
    m.set('ov_brg',good?new Date(today.generatedAt).toLocaleString():'统计不可用');
    var link=document.getElementById('db_detail');
    if(link){link.setAttribute('role','link');link.setAttribute('tabindex','0');link.onclick=function(){location.href='/scene-records?scene=all';};link.onkeydown=function(e){if(e.key==='Enter'){link.onclick();}};}
}
