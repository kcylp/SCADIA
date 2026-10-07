/**
 * ic-to-scadia: convert a decrypted 展厅 (展厅) view XML into a
 * JiangZhiFang-scada (SCADIA) view object.
 *
 * This is an OFFLINE dev tool. The 展厅 .gxdoc is decrypted first with the
 * vendor's own serializer (see docs/展厅 and PLAN_展厅画面.md §9), which
 * yields a plain XML with this shape:
 *
 *   <Root Name="..." Size="W,H" ...>
 *     <Layers><Layer .../></Layers>
 *     <Background ...><BitmapImage ResId="N"/></Background>
 *     <Shapes>
 *       <Rectangle .../><RoundRectangle Radius="..."/><Ellipse .../><Line .../>
 *       <Text Content="..."><Font/><Fill/><TextFill/><Stroke/></Text>  ...
 *     </Shapes>
 *   </Root>
 *
 * The converter maps every shape to an SVG element with the SAME geometry and
 * SAME colours (1:1). Colours are AARRGGBB + a separate 0..100 opacity in
 * 展厅; SCADIA uses #rrggbbaa, so the conversion is explicit.
 *
 * Usage:  node ic-to-scadia.js <in.xml> <out.json> [--name Foo] [--images <dir>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sax = require('../node_modules/sax');

/* ------------------------------------------------------------------ parsing */

/** Parse an XML string into an ordered node tree: {name, attrs, children, text}. */
function parseXml(xml) {
    const parser = sax.parser(true, { trim: false, normalize: false });
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    parser.onopentag = (node) => {
        const el = { name: node.name, attrs: node.attributes || {}, children: [], text: '' };
        stack[stack.length - 1].children.push(el);
        stack.push(el);
    };
    parser.onclosetag = () => { if (stack.length > 1) { stack.pop(); } };
    parser.ontext = (t) => { stack[stack.length - 1].text += t; };
    parser.onerror = () => {};
    parser.write(xml).close();
    return root;
}

function child(node, name) {
    return (node.children || []).find(c => c.name === name) || null;
}
function attrNum(node, key, dflt) {
    const v = node.attrs[key];
    if (v === undefined || v === null || v === '') { return dflt; }
    const n = parseFloat(v);
    return isNaN(n) ? dflt : n;
}

/* ------------------------------------------------------------------ colours */

/**
 * 展厅 stores colours as AARRGGBB and opacity as a separate 0..100 value.
 * SCADIA uses #rrggbbaa. 展厅's opacity 0 means "unset" (fully opaque, use
 * the colour's own alpha); 1..100 scales it. Panels routinely carry
 * FillOpacity="0" and are still solid, so treating 0 as transparent would
 * erase every panel.
 */
function icColor(hexAARRGGBB, opacityPercent) {
    if (!hexAARRGGBB || typeof hexAARRGGBB !== 'string') { return null; }
    let h = hexAARRGGBB.replace(/^#/, '');
    let a = 255, r, g, b;
    if (h.length === 8) {
        a = parseInt(h.substr(0, 2), 16);
        r = parseInt(h.substr(2, 2), 16);
        g = parseInt(h.substr(4, 2), 16);
        b = parseInt(h.substr(6, 2), 16);
    } else if (h.length === 6) {
        r = parseInt(h.substr(0, 2), 16);
        g = parseInt(h.substr(2, 2), 16);
        b = parseInt(h.substr(4, 2), 16);
    } else {
        return null;
    }
    if (opacityPercent !== undefined && opacityPercent !== null && opacityPercent !== '') {
        const o = parseFloat(opacityPercent);
        if (!isNaN(o) && o > 0) { a = Math.round(a * Math.max(0, Math.min(100, o)) / 100); }
    }
    return '#' + [r, g, b, a].map(x => (x < 16 ? '0' : '') + x.toString(16)).join('');
}

/** Font descriptor from a <Font fml size sty unit>. */
function icFont(node) {
    const f = child(node, 'Font');
    const out = {};
    if (f) {
        if (f.attrs.fml) { out['font-family'] = f.attrs.fml; }
        if (f.attrs.size) { out['font-size'] = f.attrs.size; }
        const sty = parseInt(f.attrs.sty, 10);
        if (sty === 1 || sty === 3) { out['font-weight'] = 'bold'; }
        if (sty === 2 || sty === 3) { out['font-style'] = 'italic'; }
    }
    return out;
}

/** Fill colour: <Fill FillColor FillOpacity>. A Text shape only gets a visible
 *  background box when an opacity > 0 is explicitly set (else it would paint an
 *  opaque rectangle behind every label). */
function icFill(node, isText) {
    const f = child(node, 'Fill');
    if (!f) { return null; }
    if (isText) {
        const o = parseFloat(f.attrs.FillOpacity);
        if (!(o > 0)) { return null; }
    }
    return icColor(f.attrs.FillColor, f.attrs.FillOpacity);
}

/** Text colour: prefer the gradient's first stop, else <TextFill FillColor>. */
function icTextFill(node) {
    const tf = child(node, 'TextFill');
    if (!tf) { return null; }
    if (tf.attrs.FillColor !== undefined) { return icColor(tf.attrs.FillColor, tf.attrs.FillOpacity); }
    const colors = child(tf, 'Colors');
    if (colors && colors.children.length) {
        return icColor(colors.children[0].attrs.Value, tf.attrs.StartOpacity);
    }
    return icColor(tf.attrs.StartColor, tf.attrs.StartOpacity);
}

/** Stroke: <Stroke PenColor PenWidth PenOpacity>. */
function icStroke(node) {
    const s = child(node, 'Stroke');
    if (!s) { return null; }
    const color = icColor(s.attrs.PenColor, s.attrs.PenOpacity);
    const width = attrNum(s, 'PenWidth', 1);
    if (!color) { return null; }
    return { color, width };
}

/* --------------------------------------------------------------- svg output */

function esc(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function attrsStr(map) {
    return Object.keys(map)
        .filter(k => map[k] !== undefined && map[k] !== null && map[k] !== '')
        .map(k => `${k}="${esc(map[k])}"`).join(' ');
}

/** System.Drawing.ContentAlignment -> SVG text anchoring. */
function anchorFor(alignment) {
    const a = parseInt(alignment, 10);
    let anchor = 'start', baseline = 'hanging';
    if (a === 2 || a === 32 || a === 512) { anchor = 'middle'; }
    else if (a === 4 || a === 64 || a === 1024) { anchor = 'end'; }
    if (a === 16 || a === 32 || a === 64) { baseline = 'central'; }
    else if (a === 256 || a === 512 || a === 1024) { baseline = 'text-after-edge'; }
    return { anchor, baseline };
}

/* ------------------------------------------------------ control renderers */

/** First descendant with the given tag name (depth-first). */
function findDescendant(node, name) {
    for (const c of (node.children || [])) {
        if (c.name === name) { return c; }
        const deeper = findDescendant(c, name);
        if (deeper) { return deeper; }
    }
    return null;
}

/** Column labels for the alarm table, by 展厅 MsgProperty. */
const MSG_LABEL = {
    Time: '时间', User: '用户', Name: '报警名称', Server: '服务器', Category: '报警类型',
    Group: '分组', Type: '类型', Priority: '优先级', IsAcked: '已确认', AckTime: '确认时间',
    AckUser: '确认用户', IsResumed: '已恢复', ResumeTime: '恢复时间', Detail: '详情', Description: '描述'
};

/**
 * The alarm table (CE.NX.TVM MessageCtrlData). Rebuilt as a real SVG table:
 * header row with the configured columns and their widths, in the configured
 * colours, plus the message area and a scrollbar hint.
 */
function renderAlarmTable(ctrl, x, y, w, h, ctx) {
    const data = findDescendant(ctrl, 'MessageCtrlData');
    const itemsNode = data ? findDescendant(data, 'MessageItems') : null;
    const cols = [];
    if (itemsNode) {
        for (const it of itemsNode.children) {
            if (it.attrs.Visible !== 'true') { continue; }
            cols.push({ label: MSG_LABEL[it.attrs.MsgProperty] || it.attrs.MsgProperty || '', width: attrNum(it, 'DisplayColumnWidth', 120) });
        }
    }
    const customNode = data ? findDescendant(data, 'MessageCustomItems') : null;
    if (customNode) {
        let n = 0;
        for (const it of customNode.children) {
            if (it.attrs.Visible !== 'true') { continue; }
            n++;
            cols.push({ label: it.attrs.Alias || `自定义${n}`, width: attrNum(it, 'DisplayColumnWidth', 120) });
        }
    }
    if (!cols.length) { cols.push({ label: '时间', width: 240 }, { label: '用户', width: 160 }); }

    // colours: NonUrgency / Selected from MessageColor
    let fg = '#C2D9E7', bg = '#02264D', selBg = '#033C7A', selFg = '#C2D9E7';
    const colorNode = data ? findDescendant(data, 'MessageColor') : null;
    if (colorNode) {
        const nu = child(colorNode, 'NonUrgencyColorScheme');
        const fst = nu && nu.children.find(c => c.name === 'Item');
        if (fst) { fg = icColor(fst.attrs.ForegroundColor) || fg; bg = icColor(fst.attrs.BackgroundColor) || bg; }
        const sm = child(colorNode, 'SelectedMessageConfig');
        if (sm) { selBg = icColor(sm.attrs.BackgroundColor) || selBg; selFg = icColor(sm.attrs.ForegroundColor) || selFg; }
    }

    const hdrH = 28;
    const parts = [];
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>`);
    // header background is the selected colour (a lighter band)
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${hdrH}" fill="${selBg}"/>`);
    let cx = x;
    for (const c of cols) {
        parts.push(`  <text x="${cx + 8}" y="${y + hdrH / 2}" fill="${selFg}" font-family="微软雅黑" font-size="14" dominant-baseline="central">${esc(c.label)}</text>`);
        cx += c.width;
        parts.push(`  <line x1="${cx}" y1="${y}" x2="${cx}" y2="${y + h}" stroke="#1b4a7a" stroke-width="1"/>`);
    }
    parts.push(`  <line x1="${x}" y1="${y + hdrH}" x2="${x + w}" y2="${y + hdrH}" stroke="#1b4a7a" stroke-width="1"/>`);
    // scrollbar hint on the right
    parts.push(`  <rect x="${x + w - 12}" y="${y + hdrH}" width="12" height="${h - hdrH}" fill="#0a1a2e"/>`);
    parts.push(`  <rect x="${x + w - 11}" y="${y + hdrH + 4}" width="10" height="60" rx="4" fill="#2a5a8a"/>`);
    ctx.controls.push({ name: ctrl.attrs.Name, type: 'alarm-table', x, y, w, h, columns: cols.map(c => c.label) });
    return parts.join('\n');
}

/** The video wall (VideoCameraList / 视频监控器): a grid of camera cells. */
function renderVideoWall(node, cols, rows, x, y, w, h, ctx) {
    const parts = [];
    const cw = w / cols, ch = h / rows;
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#02162b" stroke="#1b4a7a" stroke-width="1"/>`);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const gx = x + c * cw, gy = y + r * ch;
            parts.push(`  <rect x="${gx + 2}" y="${gy + 2}" width="${cw - 4}" height="${ch - 4}" fill="#00101f" stroke="#123a5f" stroke-width="1"/>`);
            parts.push(`  <text x="${gx + cw / 2}" y="${gy + ch / 2}" fill="#4d80b3" font-family="微软雅黑" font-size="12" text-anchor="middle" dominant-baseline="central">CAM ${r * cols + c + 1}</text>`);
        }
    }
    ctx.controls.push({ name: node.attrs.Name, type: 'video-wall', x, y, w, h, cols, rows });
    return parts.join('\n');
}

/** A chart panel (columnchart / Pie / Statisticalbar): axes + a marker so the
 *  footprint and title survive; real data binding comes later. */
function renderChart(node, x, y, w, h, ctx) {
    const kind = node.name;
    const parts = [];
    parts.push(`  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#02162b" stroke="#123a5f" stroke-width="1"/>`);
    if (/pie/i.test(kind)) {
        const cx0 = x + w / 2, cy0 = y + h / 2, rr = Math.min(w, h) / 2 - 6;
        parts.push(`  <circle cx="${cx0}" cy="${cy0}" r="${rr}" fill="#0a3a66" stroke="#2f8fe0" stroke-width="1"/>`);
        parts.push(`  <path d="M ${cx0} ${cy0} L ${cx0} ${cy0 - rr} A ${rr} ${rr} 0 0 1 ${cx0 + rr} ${cy0} Z" fill="#1467b0"/>`);
    } else {
        // axes + a few bars
        const ax = x + 30, ay = y + h - 24;
        parts.push(`  <line x1="${ax}" y1="${y + 8}" x2="${ax}" y2="${ay}" stroke="#2f6fa0" stroke-width="1"/>`);
        parts.push(`  <line x1="${ax}" y1="${ay}" x2="${x + w - 8}" y2="${ay}" stroke="#2f6fa0" stroke-width="1"/>`);
        const n = 8, bw = (w - 40) / n;
        for (let i = 0; i < n; i++) {
            const bh = (0.3 + 0.5 * Math.abs(Math.sin(i * 1.7))) * (h - 40);
            parts.push(`  <rect x="${ax + 4 + i * bw}" y="${ay - bh}" width="${bw * 0.6}" height="${bh}" fill="#14afe6" opacity="0.85"/>`);
        }
    }
    ctx.controls.push({ name: node.attrs.Name, type: 'chart:' + kind, x, y, w, h });
    return parts.join('\n');
}

/* ------------------------------------------------------ shape -> svg (1:1) */

function shapeToSvg(node, ctx) {
    const a = node.attrs;
    const x = attrNum(node, 'X', 0), y = attrNum(node, 'Y', 0);
    const w = attrNum(node, 'Width', 0), h = attrNum(node, 'Height', 0);
    const visible = a.Visible !== 'false';
    // z-order: keep document order; mark hidden shapes but do not drop geometry
    const common = {};
    if (!visible) { common.opacity = '0'; }

    switch (node.name) {
        case 'Rectangle':
        case 'RoundRectangle': {
            const fill = icFill(node) || 'none';
            const stroke = icStroke(node);
            const rx = node.name === 'RoundRectangle' ? attrNum(node, 'Radius', 0) : 0;
            return `  <rect ${attrsStr(Object.assign({ x, y, width: w, height: h, rx, ry: rx, fill, stroke: stroke ? stroke.color : 'none', 'stroke-width': stroke ? stroke.width : 0 }, common))}/>`;
        }
        case 'Ellipse': {
            const fill = icFill(node) || 'none';
            const stroke = icStroke(node);
            return `  <ellipse ${attrsStr(Object.assign({ cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, fill, stroke: stroke ? stroke.color : 'none', 'stroke-width': stroke ? stroke.width : 0 }, common))}/>`;
        }
        case 'Line': {
            const stroke = icStroke(node);
            return `  <line ${attrsStr(Object.assign({ x1: x, y1: y, x2: attrNum(node, 'X2', x + w), y2: attrNum(node, 'Y2', y + h), stroke: stroke ? stroke.color : '#000000', 'stroke-width': stroke ? stroke.width : 1 }, common))}/>`;
        }
        case 'Text':
        case 'RTDBDataText': {
            const content = a.Content !== undefined ? a.Content : node.text;
            const font = icFont(node);
            const fill = icTextFill(node) || '#000000';
            const bgFill = icFill(node, true);
            const align = anchorFor(a.Alignment);
            // Middle-center anchoring stays centred inside the original bounds
            let tx = x, ty = y;
            if (align.anchor === 'middle') { tx = x + w / 2; } else if (align.anchor === 'end') { tx = x + w; }
            ty = y + h / 2;
            const style = Object.assign({}, font, { fill, 'text-anchor': align.anchor, 'dominant-baseline': align.baseline }, common);
            const id = ctx.nextId('txt');
            const textEl = `  <text id="${id}" ${attrsStr(style)} x="${tx}" y="${ty}">${esc(content)}</text>`;
            if (bgFill) {
                return `  <rect ${attrsStr(Object.assign({ x, y, width: w, height: h, fill: bgFill }, common))}/>\n${textEl}`;
            }
            return textEl;
        }
        case 'Image': {
            // Resolved by the caller when a ResId->file map exists; otherwise a
            // placeholder mantains the exact geometry so the layout stays 1:1.
            const href = ctx.imageFor(a.ResId, w, h);
            if (href) {
                return `  <image ${attrsStr(Object.assign({ x, y, width: w, height: h, 'xlink:href': href }, common))}/>`;
            }
            return `  <rect ${attrsStr(Object.assign({ x, y, width: w, height: h, fill: '#00000000', stroke: '#80808080', 'stroke-width': 0.5 }, common))}/>`;
        }
        case 'Group': {
            const inner = (node.children || []).map(c => shapeToSvg(c, ctx)).filter(Boolean).join('\n');
            return `  <g id="${ctx.nextId('grp')}" ${attrsStr(common)}>\n${inner}\n  </g>`;
        }
        // A Combo is a dropdown *composed of shapes*: render its inner Shapes
        // exactly like a group so the real widget (box + arrow + text) survives.
        case 'Combo': {
            const shapes = child(node, 'Shapes');
            const inner = ((shapes ? shapes.children : node.children) || [])
                .map(c => shapeToSvg(c, ctx)).filter(Boolean).join('\n');
            return `  <g id="${ctx.nextId('combo')}" ${attrsStr(common)}>\n${inner}\n  </g>`;
        }
        case 'PieChart':
        case 'piechart':
        case 'columnchart':
        case 'Statisticalbar':
        case 'CurveList':
            return renderChart(node, x, y, w, h, ctx);
        case 'VideoCameraList':
        case 'VideoCamera':
            return renderVideoWall(node, 4, 4, x, y, w, h, ctx);
        case 'MessageCtrlData':
            // standalone message table (rare: usually inside a CtrlSurrogate)
            return renderAlarmTable(node, x, y, w, h, ctx);
        case 'TreeViewControlData':
        case 'Item':
        case 'CtrlSurrogate':
        default: {
            // Custom controls (video monitor, alarm table, timer, charts…): keep
            // the exact footprint and give it a name; specialised renderers take
            // over when the surrogate wraps something we know how to draw.
            if (findDescendant(node, 'MessageCtrlData')) {
                return renderAlarmTable(node, x, y, w, h, ctx);
            }
            if (w === 0 || h === 0) { return null; }
            const id = ctx.nextId('ctrl');
            ctx.controls.push({ id, name: a.Name, type: node.name, x, y, w, h });
            return `  <rect id="${id}" ${attrsStr(Object.assign({ x, y, width: w, height: h, fill: '#00000000', stroke: '#4a90d980', 'stroke-width': 1, 'stroke-dasharray': '4 3' }, common))}/>`;
        }
    }
}

/* ------------------------------------------------------------------ convert */

function convert(xmlText, opts) {
    const o = opts || {};
    const doc = parseXml(xmlText);
    const root = (doc.children || []).find(c => c.name === 'Root') || doc.children[0];
    const [rw, rh] = String(root.attrs.Size || '1024,768').split(',').map(n => parseFloat(n));

    const ctx = {
        counter: 0,
        controls: [],
        images: o.images || {},
        nextId(prefix) { return `${prefix}_ic${(++this.counter).toString(36)}`; },
        imageFor(resId, w, h) {
            const file = this.images && (this.images[resId] || (this.images.__bySize && this.images.__bySize[`${Math.round(w)}x${Math.round(h)}`]));
            if (!file) { return null; }
            if (this.images.__dir && this.embed) {
                try {
                    const buf = fs.readFileSync(path.join(this.images.__dir, file));
                    const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
                    return `data:${mime};base64,${buf.toString('base64')}`;
                } catch (e) { /* fall through */ }
            }
            return (this.urlPrefix || '') + file;
        }
    };
    ctx.embed = !!o.embed;
    ctx.urlPrefix = o.urlPrefix || '';

    const shapesNode = child(root, 'Shapes');
    const shapes = (shapesNode ? shapesNode.children : []).map(s => shapeToSvg(s, ctx)).filter(Boolean);

    // The screen backdrop is a <Background> with a <BitmapImage ResId>. It sits
    // under every shape, so it becomes the first element of the SVG.
    const bg = child(root, 'Background');
    const bgLayers = [];
    if (bg) {
        const bmp = child(bg, 'BitmapImage');
        const bx = attrNum(bg, 'X', 0), by = attrNum(bg, 'Y', 0);
        const bw = attrNum(bg, 'Width', rw) || rw, bh = attrNum(bg, 'Height', rh) || rh;
        const href = bmp ? ctx.imageFor(bmp.attrs.ResId, bw, bh) : null;
        if (href) {
            bgLayers.push(`  <image x="${bx}" y="${by}" width="${bw}" height="${bh}" xlink:href="${esc(href)}"/>`);
        }
    }

    const bgFill = icFill(root) || '#00000000';
    const svg = [
        `<svg width="${rw}" height="${rh}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
        `  <g>`,
        `    <title>${esc(root.attrs.Name || 'view')}</title>`,
        ...bgLayers.map(s => '    ' + s),
        ...shapes.map(s => s.split('\n').map(l => '    ' + l).join('\n')),
        `  </g>`,
        `</svg>`
    ].join('\n');

    const view = {
        id: o.id || ('v_' + Math.abs(hash(root.attrs.Name || '') >>> 0).toString(36)),
        name: o.name || root.attrs.Name || 'view',
        type: 'svg',
        profile: { width: rw, height: rh, bkcolor: bgFill === '#00000000' ? '#000000ff' : bgFill },
        items: {},
        variables: {},
        svgcontent: svg
    };
    view.__controls = ctx.controls;   // side-channel for review; stripped on import
    return view;
}

function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
    return h;
}

/* ---------------------------------------------------------- image ResId map */

/**
 * Best-effort ResId -> file map. The authoritative source is the decrypted
 * resource index; here we match a referenced element size to an image file
 * whose pixel size matches (used for backgrounds and full-screen art).
 */
function buildImageMap(imagesDir) {
    const map = { __bySize: {}, __dir: imagesDir };
    try {
        const files = fs.readdirSync(imagesDir).filter(f => /\.(png|jpe?g)$/i.test(f));
        for (const f of files) {
            const { width, height } = pngSize(path.join(imagesDir, f));
            if (!width) { continue; }
            map.__bySize[`${width}x${height}`] = f;
        }
    } catch (e) { /* images optional */ }
    return map;
}

function pngSize(file) {
    try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(24);
        fs.readSync(fd, buf, 0, 24, 0);
        fs.closeSync(fd);
        if (buf.toString('ascii', 1, 4) === 'PNG') {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf[0] === 0xFF && buf[1] === 0xD8) { return jpegSize(file); }
    } catch (e) {}
    return {};
}
function jpegSize(file) {
    const buf = fs.readFileSync(file);
    let i = 2;
    while (i < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return {};
}

/* --------------------------------------------------------------------- cli */

function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('usage: node ic-to-scadia.js <in.xml> <out.json> [--name Foo] [--images <dir>] [--id X]');
        process.exit(2);
    }
    const inXml = args[0], outJson = args[1];
    const nameIdx = args.indexOf('--name');
    const imgIdx = args.indexOf('--images');
    const idIdx = args.indexOf('--id');
    const xml = fs.readFileSync(inXml, 'utf8').replace(/^\uFEFF/, '');
    const images = imgIdx >= 0 ? buildImageMap(args[imgIdx + 1]) : {};
    const view = convert(xml, {
        name: nameIdx >= 0 ? args[nameIdx + 1] : undefined,
        id: idIdx >= 0 ? args[idIdx + 1] : undefined,
        images: images,
        embed: args.indexOf('--embed') >= 0,
        urlPrefix: (() => {
            const i = args.indexOf('--url');
            if (i < 0) { return ''; }
            const v = String(args[i + 1] || '');
            if (!v) { return ''; }
            // accept "images/zc", "/images/zc" or "images/zc/" alike
            const trimmed = v.replace(/^\/+/, '').replace(/\/+$/, '');
            return trimmed ? '/' + trimmed + '/' : '';
        })()
    });
    fs.writeFileSync(outJson, JSON.stringify(view, null, 2), 'utf8');
    console.log(`converted ${path.basename(inXml)} -> ${path.basename(outJson)}`);
    console.log(`  name=${view.name} size=${view.profile.width}x${view.profile.height} svg=${view.svgcontent.length} chars controls=${view.__controls.length}`);
}

if (require.main === module) { main(); }

module.exports = { convert, parseXml, icColor, buildImageMap };
