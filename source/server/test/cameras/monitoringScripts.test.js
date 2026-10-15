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
    const m = { data, errors, node: d.node, load() {} };
    const run = () => vm.runInNewContext(script('video-cards'), { window: { __monitor: m }, document: d.document });
    run();
    return { ...d, m, run };
}
const alarm = (name, time) => ({ name, type: 'highhigh', ontime: time, text: '视频事件：移动侦测（相机原生事件，经事件桥接器写入）' });

describe('Monitoring UI script contracts', () => {
    it('deduplicates current/history suffixes and keeps the next distinct alarm', () => {
        const time = Date.now();
        const d = cards({ alarms: [alarm('移动侦测^~^highhigh', time)], history: [alarm('移动侦测', time), alarm('区域入侵', time - 30000)] });
        assert.equal(d.ids.get('vc_value_0_2').textContent, '移动侦测 · 高高限');
        assert.equal(d.ids.get('vc_value_1_2').textContent, '区域入侵 · 高高限');
        assert.equal(d.ids.get('vc_value_2_2').textContent, '—');
        assert.equal(d.ids.get('vc_value_0_1').textContent, '未关联');
    });
    it('does not duplicate visible text with the accessible full description on redraw', () => {
        const d = cards({ alarms: [alarm('移动侦测', Date.now())] });
        d.run();
        const field = d.ids.get('vc_value_0_3');
        assert.equal(field.textContent, field.getAttribute('aria-label'));
        assert(field.children.every(c => c.tag === 'tspan'));
        assert.equal(d.ids.get('vc_title_0_3').textContent, field.textContent);
        assert.equal(d.ids.get('vc_value_0_0').children.length, 1);
    });
    it('shows shot load failures, recovers on load and does not invent a missing shot', () => {
        const time = Date.now();
        const d = cards({ alarms: [alarm('移动侦测', time)], shots: { shots: [{ label: '移动侦测', at: time, url: '/_images/alarm-shots/motion.jpg' }] } });
        const image = d.ids.get('vc_shot_0'), empty = d.ids.get('vc_empty_0');
        image.onerror(); assert.equal(empty.textContent, '抓拍加载失败'); assert.equal(empty.style.display, '');
        image.onload(); assert.equal(empty.style.display, 'none');
        d.m.data.shots.shots = []; d.run(); assert.equal(empty.textContent, '暂无对应抓拍'); assert.equal(empty.style.display, '');
    });
    it('distinguishes a read failure from no alarms and renders unsafe text as text', () => {
        const d = cards({ alarms: [] }, { history: 'HTTP 403' });
        assert(d.ids.get('vc_value_0_3').textContent.includes('读取失败'));
        const a = alarm('移动侦测', Date.now()); a.text = '<script>alert(1)</script>';
        d.m.data.alarms = [a]; d.run();
        assert.equal(d.ids.get('vc_value_0_3').getAttribute('aria-label'), a.text);
        assert(d.ids.get('vc_value_0_3').children.every(c => c.tag === 'tspan'));
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
