'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const script = name => fs.readFileSync(path.join(__dirname, '../../../tools/monitoring', name + '.js'), 'utf8');

// Only the SVG operations used by scheduled monitoring scripts; no network or live project.
function dom() {
    const ids = new Map();
    function node(tag, attrs = {}, text) {
        const e = { tag, attrs: {}, style: {}, children: [], parentNode: null,
            setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); ids.set(this.id, this); } },
            getAttribute(k) { return this.attrs[k]; },
            removeAttribute(k) { delete this.attrs[k]; },
            replaceChildren() { this.children = []; this.value = ''; },
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
        };
        Object.defineProperty(e, 'firstChild', { get() { return this.children[0] || null; } });
        Object.defineProperty(e, 'textContent', {
            get() { return (this.value || '') + this.children.map(c => c.textContent).join(''); },
            set(v) { this.value = String(v); this.children = []; }
        });
        Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
        if (text != null) { e.textContent = text; }
        return e;
    }
    const parent = node('g');
    ['vc_card_0', 'vc_card_1', 'vc_card_2', ...Array.from({ length: 3 }, (_, i) => ['vc_shot_' + i, 'vc_empty_' + i, 'vc_state_' + i,
        ...Array.from({ length: 4 }, (_, f) => 'vc_value_' + i + '_' + f)]).flat()].forEach(id => parent.appendChild(node('text', { id, x: 1364 })));
    return { ids, node, document: { getElementById: id => ids.get(id) || null, createElementNS: (_, tag) => node(tag), createElement: tag => node(tag), querySelector: () => null } };
}
function cards(data, errors = {}) {
    const d = dom();
    const m = { data, errors, node: d.node, load() {}, headers:()=>({}),
        set:(id,text)=>{const e=d.ids.get(id);if(e)e.textContent=text;}, sceneShots:{} };
    const requested=[], revoked=[];
    const run = () => vm.runInNewContext(script('video-cards'), { window: { __monitor: m }, document: d.document,
        AbortSignal, URL:{createObjectURL:()=> 'blob:event',revokeObjectURL:url=>revoked.push(url)},
        fetch:url=>{requested.push(url);return Promise.resolve({ok:false});} });
    run();
    return { ...d, m, run, requested, revoked };
}
const alarm = (name, time) => ({ name, type: 'highhigh', ontime: time, text: '视频事件：移动侦测（相机原生事件，经事件桥接器写入）' });

describe('Monitoring UI script contracts', () => {
    const event = (i=1) => ({eventId:String(i).padStart(32,'a'),sceneId:'V3',source:'visible',camera:'camera',at:Date.now(),label:'吸烟候选',reviewStatus:'pending'});
    it('reads durable scene identities only and never matches legacy alarms or nearby shots', async () => {
        const row=event(),d=cards({sceneLatest:{rows:[row]},alarms:[alarm('移动侦测',row.at)],shots:{shots:[{at:row.at,url:'/wrong.jpg'}]}});
        assert.equal(d.ids.get('vc_value_0_2').textContent,'吸烟候选 · pending');
        assert.deepEqual(d.requested,['/api/ai/scene-events/'+row.eventId+'/evidence']);
        d.run();assert.equal(d.requested.length,1);
        await new Promise(r=>setImmediate(r));d.run();
        assert(d.ids.get('vc_empty_0').textContent.includes('缺失或读取失败'));
        assert.equal(d.ids.get('vc_shot_0').getAttribute('href'),undefined);
    });
    it('does not duplicate visible text or buttons on redraw and binds the exact evidence identity', () => {
        const row=event(),d=cards({sceneLatest:{rows:[row]}});let opened;
        d.m.openSceneEvidence=r=>opened=r;d.run();d.ids.get('vc_ack_0').firstChild.onclick();
        assert.equal(opened.eventId,row.eventId);assert.equal(opened.sceneId,'V3');
        assert.equal(d.ids.get('vc_value_0_3').textContent,row.eventId);
        assert.equal(d.ids.get('vc_value_0_3').getAttribute('aria-label'),row.eventId);
        assert.equal(d.ids.get('vc_card_0').children.length,1);
    });
    it('shows image decode failures, recovers on load and revokes evidence after the event disappears', () => {
        const row=event(),d=cards({sceneLatest:{rows:[row]}});
        d.m.sceneShots[row.eventId]={url:'blob:saved'};d.run();
        const image=d.ids.get('vc_shot_0'),empty=d.ids.get('vc_empty_0');
        image.onerror();assert(empty.textContent.includes('无法显示'));assert.equal(empty.style.display,'');
        image.onload();assert.equal(empty.style.display,'none');
        d.m.data.sceneLatest.rows=[];d.run();assert.equal(image.getAttribute('href'),undefined);
        assert.deepEqual(d.revoked,['blob:saved']);assert(empty.textContent.includes('暂无场景事件'));
    });
    it('hides cached evidence on a read failure and renders unsafe labels only as text', () => {
        const row=event(),d=cards({sceneLatest:{rows:[row]}});
        row.label='<script>alert(1)</script>';d.run();
        assert(d.ids.get('vc_value_0_2').getAttribute('aria-label').includes(row.label));
        assert.equal(d.ids.get('vc_value_0_2').children.length,0);
        d.m.sceneShots[row.eventId]={url:'blob:cached'};d.m.errors.sceneLatest='HTTP 403';d.run();
        assert(d.ids.get('vc_state_0').textContent.includes('读取失败'));
        assert.equal(d.ids.get('vc_shot_0').getAttribute('href'),undefined);
        assert.equal(d.ids.get('vc_ack_0').firstChild.disabled,true);
        assert.deepEqual(d.revoked,['blob:cached']);
    });
    it('keeps thermal coordinates and trails isolated from visible light and mismatched cameras', () => {
        const d = dom();
        const visible = d.node('image', {id:'visible', 'data-camera-id':'cam-visible'});
        const thermal = d.node('image', {id:'thermal', 'data-camera-id':'cam-thermal'});
        const layers = {};
        const detection = {id:'T1',timestamp:Date.now(),region:{x:.1,y:.2,w:.3,h:.4}};
        const m = {data:{
            tracks:{camera:'cam-visible',streamKind:'visible',updatedAt:Date.now(),detections:[detection]},
            thermalTracks:{camera:'cam-thermal',streamKind:'thermal',updatedAt:Date.now(),detections:[detection]},
            fence:{camera:'cam-visible',points:[[0,0],[1,0],[1,1]],scale:1}
        },errors:{},panes:()=>[visible,thermal],thermal:p=>p===thermal,node:d.node,
            layer:(p,id)=>(layers[p.id]=d.node('g',{id})),box:()=>({x:0,y:0,w:100,h:100})};
        const run=()=>vm.runInNewContext(script('ai-boxes'),{window:{__monitor:m},document:d.document});
        run();
        assert(layers.visible.children.some(e=>e.tag==='polygon'));
        assert(!layers.thermal.children.some(e=>e.tag==='polygon'));
        assert.notStrictEqual(m.trailStores.tracks,m.trailStores.thermalTracks);
        m.data.thermalTracks.camera='other-camera'; run();
        assert.equal(Object.keys(m.trailStores.thermalTracks).length,0);
        assert(!layers.thermal.children.some(e=>e.tag==='polyline'));
        assert(layers.thermal.textContent.includes('不匹配'));
        assert.equal(Object.keys(m.trailStores.tracks).length,1);
    });
    it('does not restore pending alarms from a poll issued before confirmation readback', async () => {
        const d = dom(), pending = [];
        const sandbox = { window: {}, document: d.document, location: { protocol: 'http:', hostname: 'localhost' }, AbortSignal,
            fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
        vm.runInNewContext(script('camera-live'), sandbox);
        const m = sandbox.window.__monitor;
        const oldVersion = m.versions.alarms;
        m.versions.alarms++; m.pending.alarms = true;
        m.data.alarms = [{ name:'selected', acktime:123 }];
        pending.forEach(p => p.resolve({ok:true,json:async () => [{name:'selected',acktime:0}]}));
        await new Promise(r => setImmediate(r));
        assert.equal(m.versions.alarms, oldVersion+1);
        assert.equal(m.data.alarms[0].acktime,123);
        assert.equal(m.pending.alarms,true);
    });
    it('does not let a failed pre-reset poll mark the new counters as failed', async () => {
        const d = dom(), pending = [];
        const sandbox = { window: {}, document: d.document, location: { protocol: 'http:', hostname: 'localhost' }, AbortSignal,
            fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
        vm.runInNewContext(script('camera-live'), sandbox);
        const m = sandbox.window.__monitor;
        m.epoch = 1; m.data.counts = { total: {}, byKind: {} };
        pending.forEach(p => p.reject(new Error('old request failed')));
        await new Promise(r => setImmediate(r));
        assert.equal(m.errors.counts, undefined);
        assert.deepEqual(m.data.counts.total, {});
        m.at.counts = 0; m.load('counts', '/counts', 0);
        pending[pending.length - 1].reject(new Error('new request failed'));
        await new Promise(r => setImmediate(r));
        assert.equal(m.errors.counts, 'new request failed');
    });
});
