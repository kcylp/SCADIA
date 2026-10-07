#!/usr/bin/env node
/**
 * extract-project-texts: list every piece of translatable text a project contains.
 *
 * A project is authored in Simplified Chinese. English and Russian customers need the same
 * project, so every user-visible string has to be identified, translated once and then
 * substituted at render time. Today those strings are scattered across SVG drawings, alarm
 * definitions, reports, notifications and names, so there is no way to know what is left to
 * translate - or to notice a new one that was added without a translation.
 *
 * This tool reads a project database (offline, no server needed) and emits the complete
 * inventory. It changes nothing; it is the input to the content dictionary.
 *
 * Usage:
 *   node tools/extract-project-texts.js <path-to-project.scadiap.db> [outDir]
 *
 * Output:
 *   project-texts.json   grouped inventory, ready to become dictionary entries
 *   project-texts.csv    same content for a translator (Excel friendly)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CHINESE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function loadSqlite() {
    // The server ships sqlite3; reusing it avoids a second native dependency.
    const candidates = [
        path.join(__dirname, '..', 'node_modules', 'sqlite3'),
        'sqlite3'
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch (err) { /* try next */ }
    }
    throw new Error('sqlite3 module not found; run npm install in source/server first');
}

function tableNames(db) {
    return new Promise((resolve, reject) => {
        db.all("select name from sqlite_master where type='table'", (err, rows) =>
            err ? reject(err) : resolve(rows.map(r => r.name)));
    });
}

function rows(db, sql) {
    return new Promise((resolve, reject) => {
        db.all(sql, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

/** Every <text> payload of an SVG view, plus <title> used as the view's own label. */
function textsFromSvg(svg) {
    const found = [];
    if (typeof svg !== 'string') { return found; }
    const re = /<(text|title|tspan)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(svg))) {
        const value = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (value) { found.push(value); }
    }
    return found;
}

function walkJsonStrings(node, visit, prefix) {
    if (node === null || node === undefined) { return; }
    if (typeof node === 'string') { visit(node, prefix); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walkJsonStrings(v, visit, prefix + '[' + i + ']')); return; }
    if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) { walkJsonStrings(v, visit, prefix ? prefix + '.' + k : k); }
    }
}

async function main() {
    const dbPath = process.argv[2];
    if (!dbPath || !fs.existsSync(dbPath)) {
        console.error('usage: node tools/extract-project-texts.js <project.scadiap.db> [outDir]');
        process.exit(2);
    }
    const outDir = process.argv[3] || process.cwd();
    const sqlite3 = loadSqlite();
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

    /** group -> Map(text -> Set(where it came from)) */
    const inventory = new Map();
    const add = (group, text, where) => {
        if (typeof text !== 'string') { return; }
        const value = text.trim();
        if (!value) { return; }
        if (!inventory.has(group)) { inventory.set(group, new Map()); }
        const bucket = inventory.get(group);
        if (!bucket.has(value)) { bucket.set(value, new Set()); }
        if (where) { bucket.get(value).add(where); }
    };

    const names = await tableNames(db);

    // --- views: SVG text nodes and the gauge text properties -------------------
    if (names.includes('views')) {
        for (const row of await rows(db, 'select name, value from views')) {
            let view;
            try { view = JSON.parse(row.value); } catch (err) { continue; }
            textsFromSvg(view.svgcontent).forEach(t => add('view-text', t, 'view:' + row.name));
            walkJsonStrings(view.items, (v, p) => {
                if (/(^|\.)(text|label|title|tooltip)$/i.test(p)) { add('gauge-property', v, 'view:' + row.name); }
            }, '');
        }
    }

    // --- alarms ----------------------------------------------------------------
    if (names.includes('alarms')) {
        for (const row of await rows(db, 'select * from alarms')) {
            let value;
            try { value = JSON.parse(row.value); } catch (err) { value = row.value; }
            walkJsonStrings(value, (v, p) => {
                if (/(text|group|name|label)$/i.test(p)) { add('alarm', v, 'alarm'); }
            }, '');
        }
    }

    // --- notifications ---------------------------------------------------------
    if (names.includes('notifications')) {
        for (const row of await rows(db, 'select * from notifications')) {
            let value;
            try { value = JSON.parse(row.value); } catch (err) { value = row.value; }
            walkJsonStrings(value, (v, p) => {
                if (/(text|name|title|subject|body)$/i.test(p)) { add('notification', v, 'notification'); }
            }, '');
        }
    }

    // --- reports ---------------------------------------------------------------
    if (names.includes('reports')) {
        for (const row of await rows(db, 'select * from reports')) {
            let value;
            try { value = JSON.parse(row.value); } catch (err) { value = row.value; }
            walkJsonStrings(value, (v, p) => {
                if (/(text|name|title|header|footer)$/i.test(p)) { add('report', v, 'report'); }
            }, '');
        }
    }

    // --- recipes ---------------------------------------------------------------
    if (names.includes('recipes')) {
        for (const row of await rows(db, 'select * from recipes')) {
            let value;
            try { value = JSON.parse(row.value); } catch (err) { value = row.value; }
            walkJsonStrings(value, (v, p) => {
                if (/(name|text|description|label)$/i.test(p)) { add('recipe', v, 'recipe'); }
            }, '');
        }
    }

    // --- devices and tags: names an operator reads in tables and dialogs --------
    if (names.includes('devices')) {
        for (const row of await rows(db, 'select * from devices')) {
            let value;
            try { value = JSON.parse(row.value); } catch (err) { value = row.value; }
            walkJsonStrings(value, (v, p) => {
                if (/(^|\.)(name|label|description)$/i.test(p)) { add('device-tag-name', v, 'device'); }
            }, '');
        }
    }

    // --- already-managed language texts (the @key library, if the project uses it) ---
    if (names.includes('texts')) {
        for (const row of await rows(db, 'select * from texts')) {
            let value;
            try { value = JSON.parse(row.value); } catch (err) { value = row.value; }
            if (value && value.name) { add('language-text', value.value || value.name, 'texts:' + value.name); }
        }
    }

    db.close();

    // --- report -----------------------------------------------------------------
    const summary = {};
    const flat = [];
    for (const [group, bucket] of [...inventory.entries()].sort()) {
        const withChinese = [...bucket.keys()].filter(t => CHINESE.test(t));
        summary[group] = { total: bucket.size, chinese: withChinese.length };
        for (const [text, where] of bucket) {
            flat.push({ group, text, chinese: CHINESE.test(text), sources: [...where].slice(0, 5).join(' ') });
        }
    }
    const totals = Object.values(summary).reduce((acc, s) => ({ total: acc.total + s.total, chinese: acc.chinese + s.chinese }), { total: 0, chinese: 0 });

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'project-texts.json'), JSON.stringify({
        generatedAt: new Date().toISOString(),
        database: path.basename(dbPath),
        summary, totals, entries: flat
    }, null, 2), 'utf8');

    const csv = ['group,chinese,text,sources']
        .concat(flat.map(e => [e.group, e.chinese ? 'yes' : 'no', '"' + e.text.replace(/"/g, '""') + '"', '"' + e.sources.replace(/"/g, '""') + '"'].join(',')))
        .join('\r\n');
    fs.writeFileSync(path.join(outDir, 'project-texts.csv'), '\ufeff' + csv, 'utf8');

    console.log('project: ' + path.basename(dbPath));
    for (const [group, s] of Object.entries(summary)) {
        console.log('  ' + group.padEnd(16) + ' strings=' + String(s.total).padEnd(6) + ' containing Chinese=' + s.chinese);
    }
    console.log('  ' + 'TOTAL'.padEnd(16) + ' strings=' + String(totals.total).padEnd(6) + ' containing Chinese=' + totals.chinese);
    console.log('');
    console.log('written: ' + path.join(outDir, 'project-texts.json'));
    console.log('written: ' + path.join(outDir, 'project-texts.csv'));
}

main().catch(err => { console.error(err && err.stack || err); process.exit(1); });
