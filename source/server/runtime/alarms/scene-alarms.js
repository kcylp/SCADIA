'use strict';
const names = { V1: '门口进入', V2: '跌倒复核', V3: '抽烟复核', V4: '安全帽', V5: '人员聚集',
    V6: '禁区 / 滞留', V7: '烟火 / 通道 / 画质', T1: '红外辅助' };
const canView = (runtime, permission) => !runtime.settings?.secureEnabled || [-1, 255].includes(permission?.groups ?? permission);
function project(event) {
    const verdict = event.reviewStatus === 'completed' ? event.review?.verdict : null;
    const assessment = verdict === '支持' ? '复核支持（仍需现场核实）' : verdict === '不支持' ? '复核不支持' : verdict === '证据不足' ? '复核证据不足' : '候选待复核';
    return { name: 'scene:' + event.eventId, eventId: event.eventId, sceneId: event.sceneId,
        sceneName: names[event.sceneId], kind: event.kind, camera: event.camera,
        type: event.sceneId === 'V1' ? 'info' : 'high', ontime: event.at, offtime: 0,
        acktime: event.ackAt || 0, userack: event.ackBy || '', status: event.ackAt ? 'A' : 'N',
        text: names[event.sceneId] + ' · ' + event.label + ' · ' + assessment,
        group: event.sceneId, toack: event.ackAt ? 0 : 1, value: event.kind,
        reviewStatus: event.reviewStatus, verdict, evidenceUrl: '/api/ai/scene-events/' + event.eventId + '/evidence-manifest' };
}
async function values(runtime, permission, query = {}, filter) {
    if (!canView(runtime, permission) || !runtime.cameraScenes) { return []; }
    const events = await runtime.cameraScenes.alarmEvents(query);
    return events.map(project).filter(a => !filter ||
        ((!filter.priority?.length || filter.priority.includes(a.type)) &&
        (!filter.text || a.text.toLowerCase().includes(filter.text.toLowerCase())) &&
        (!filter.group || a.group.toLowerCase().includes(filter.group.toLowerCase())) &&
        !filter.tagIds?.length));
}
module.exports = { canView, values };
