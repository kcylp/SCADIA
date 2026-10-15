// Shared runtime cache; scheduled scripts only read these snapshots.
var m = window.__monitor = window.__monitor || { data: {}, errors: {}, pending: {}, at: {} };
m.set = function (id, text) { var e = document.getElementById(id); if (e) { e.textContent = String(text); } };
m.headers = function () {
    var h = {};
    var t = window.scadiaAccessToken;
    if (t) { h['x-access-token'] = t; }
    return h;
};
m.load = function (key, url, interval, api) {
    if (m.pending[key] || Date.now() - (m.at[key] || 0) < interval) { return; }
    m.at[key] = Date.now(); m.pending[key] = true;
    var epoch = m.epoch || 0;
    m.versions = m.versions || {};
    var version = m.versions[key] = (m.versions[key] || 0) + 1;
    fetch(url, { cache: 'no-store', headers: api ? m.headers() : {}, signal: AbortSignal.timeout(7000) })
        .then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); })
        .then(function (j) { if (epoch !== (m.epoch || 0) || version !== m.versions[key]) { return; } m.data[key] = j; delete m.errors[key]; })
        .catch(function (e) { if (epoch === (m.epoch || 0) && version === m.versions[key]) { m.errors[key] = e.message; } })
        .finally(function () { if (version === m.versions[key]) { m.pending[key] = false; } });
};
m.panes = function () {
    return ['vc_video_1', 'vc_video_thermal', 'svg_72a58550-cebb43d5', 'svg_a04071af-964841aa', 'svg_bd400e8b-0ac3445b', 'svg_3e127f1a-eea34106']
        .map(function (id) { return document.getElementById(id); }).filter(Boolean);
};
m.thermal = function (p) { return /thermal|bd400e8b|3e127f1a/.test(p.id); };
m.source = function (p) { return m.thermal(p) ? 'kuangqu1-thermal' : 'kuangqu1'; };
m.box = function (p) {
    var x = +p.getAttribute('x'), y = +p.getAttribute('y'), w = +p.getAttribute('width'), h = +p.getAttribute('height');
    var im = document.getElementById('live_img_' + p.id);
    var iw = im && im.naturalWidth, ih = im && im.naturalHeight;
    if (iw && ih) { var s = Math.min(w / iw, h / ih), dw = iw * s, dh = ih * s; x += (w - dw) / 2; y += (h - dh) / 2; w = dw; h = dh; }
    return { x: x, y: y, w: w, h: h };
};
m.node = function (name, attrs, text) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) { e.textContent = text; } return e;
};
m.layer = function (p, id) {
    var old = document.getElementById(id); if (old) { old.remove(); }
    var g = m.node('g', { id: id, 'pointer-events': 'none' }); p.parentNode.appendChild(g); return g;
};
m.load('counts', '/_images/ai-counts.json', 3000);
m.load('tracks', '/_images/ai-tracks.json', 3000);
m.load('thermalTracks', '/_images/ai-tracks-thermal.json', 3000);
m.load('alarms', '/api/alarms', 15000, true);
m.load('captions', '/_images/ai-captions.json', 10000);
m.load('fence', '/_images/ai-fence.json', 10000);
if (document.querySelector('#content>svg')) { m.load('video', location.protocol + '//' + location.hostname + ':1886/stats', 5000); }
