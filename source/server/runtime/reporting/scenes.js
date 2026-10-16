'use strict';

/** The PDF and scheduled job render the same immutable ledger snapshot. */
async function sceneContent(store, filter, range, size = 9) {
    if (!store) throw new Error('场景账本未就绪');
    const query = { ...filter, from: range.begin.getTime(), to: range.end.getTime() };
    const data = await store.exportEvents(query);
    const stamp = at => new Date(at).toLocaleString('zh-CN', { hour12: false });
    const table = (header, rows) => ({ layout: 'lightHorizontalLines', fontSize: size,
        table: { headerRows: 1, widths: header.map(() => '*'), body: [header, ...(rows.length ? rows : [header.map(() => '—')])] } });
    return { stack: [
        { text: '八场景候选事件 · ' + data.scenes.join(' / ') + '\n窗口 [' + stamp(query.from) + ', ' + stamp(query.to+1) + ') · 时区 ' + data.timezone + '\n生成时间 ' + stamp(data.generatedAt) + ' · 候选数 ' + data.count + ' · 完整明细 ' + data.exportedCount + ' 条', fontSize: size },
        { text: '候选事件数不等于独立事故数；复核完成不等于支持；人工知晓不等于恢复。以下汇总、趋势和明细来自同一快照。', fontSize: size },
        table(['场景','类型','复核状态','结论','知晓','数量'], data.groups.map(g => [g.sceneId,g.kind,g.reviewStatus,g.verdict || '未得出',g.acknowledged?'已确认':'待确认',String(g.count)])),
        table(['小时起点','场景','候选数'], data.trend.map(g => [stamp(g.at),g.sceneId,String(g.count)])),
        table(['事件ID / 时间','场景 / 来源','候选','复核 / 知晓','证据文件'],data.rows.map(r => [r.eventId+'\n'+stamp(r.at),r.sceneId+' / '+(r.source || (r.sceneId==='T1'?'thermal':'visible')),r.label || r.kind,(r.review?.verdict || r.reviewStatus)+' / '+(r.ackAt?'已确认':'待确认'),(r.shot || '缺失')+'\n规则 / 标定 '+r.calibrationVersion]))
    ] };
}
module.exports = { sceneContent };
