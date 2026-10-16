var m = window.__monitor;
if (m && document.getElementById('vc_card_0')) {
    var ledger = m.data.sceneLatest, rows = m.errors.sceneLatest ? [] : ledger && ledger.rows || [];
    m.sceneShots = m.sceneShots || {};
    Object.keys(m.sceneShots).forEach(function (id) {
        if (!rows.some(function(r){return r.eventId===id;})) {
            if(m.sceneShots[id].url) URL.revokeObjectURL(m.sceneShots[id].url);
            delete m.sceneShots[id];
        }
    });
    for (var i=0;i<3;i++) {
        var row=rows[i], image=document.getElementById('vc_shot_'+i), empty=document.getElementById('vc_empty_'+i);
        var valid=row && /^[a-f0-9]{32}$/.test(row.eventId), shot=valid && m.sceneShots[row.eventId];
        if(valid && (!shot || shot.failed && Date.now()-(shot.failedAt||0)>15000)){
            shot=m.sceneShots[row.eventId]={pending:true};
            (function(id,entry,epoch){
                fetch('/api/ai/scene-events/'+id+'/evidence',{headers:m.headers(),cache:'no-store',signal:AbortSignal.timeout(8000)})
                    .then(function(r){if(!r.ok)throw new Error('evidence_unavailable');return r.blob();})
                    .then(function(blob){if(m.sceneShots[id]===entry && epoch===(m.epoch||0)){entry.url=URL.createObjectURL(blob);}})
                    .catch(function(){entry.failed=true;entry.failedAt=Date.now();}).finally(function(){entry.pending=false;});
            })(row.eventId,shot,m.epoch||0);
        }
        if(image && empty){
            if(shot && shot.url){
                image.onerror=function(){this.style.display='none';var e=document.getElementById(this.id.replace('vc_shot_','vc_empty_'));if(e){e.textContent='此事件证据无法显示';e.style.display='';}};
                image.onload=function(){this.style.display='';var e=document.getElementById(this.id.replace('vc_shot_','vc_empty_'));if(e){e.style.display='none';}};
                if(image.getAttribute('href')!==shot.url){image.setAttribute('href',shot.url);}image.style.display='';empty.style.display='none';
            }
            else {image.removeAttribute('href');image.style.display='none';empty.textContent=shot?.failed?'此事件证据缺失或读取失败':valid?'正在读取此事件证据':'暂无场景事件证据';empty.style.display='';}
        }
        var values=row?[new Date(row.at).toLocaleString('zh-CN',{hour12:false}),row.sceneId+' · '+row.source+' / '+row.camera,
            row.label+' · '+(row.review?.verdict || row.reviewStatus),row.eventId]:['—','—','—',m.errors.sceneLatest?'场景账本读取失败':'暂无候选事件'];
        values.forEach(function(value,f){var e=document.getElementById('vc_value_'+i+'_'+f);if(e){e.textContent=String(value).slice(0,f===3?32:44);e.setAttribute('aria-label',String(value));}});
        m.set('vc_state_'+i,m.errors.sceneLatest?'读取失败 · 缓存不可作为当前状态':row?(row.ackAt?'人工已确认':'人工待确认')+' · 候选不等于事故':'暂无事件');
        var host=document.getElementById('vc_ack_'+i);
        if(!host){host=m.node('foreignObject',{id:'vc_ack_'+i,x:1168,y:65+i*292+218,width:180,height:44});var button=document.createElement('button');button.type='button';button.style.cssText='width:100%;min-height:40px;background:#214f79;color:#fff;border:1px solid #92b6d8;cursor:pointer;font:14px Microsoft YaHei,sans-serif';host.appendChild(button);document.getElementById('vc_card_'+i).appendChild(host);}
        host.firstChild.textContent='查看此事件证据';host.firstChild.disabled=!valid || !!m.errors.sceneLatest;
        (function(event,button){button.onclick=function(){if(event && m.openSceneEvidence)m.openSceneEvidence({eventId:event.eventId,sceneId:event.sceneId,text:event.label,ontime:event.at});};})(row,host.firstChild);
    }
}
