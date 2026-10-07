/**
 * Architecture guard - shared scanning helpers.
 *
 * Everything here is deliberately mechanical: source text in, facts out. No AST
 * dependency, so the guard keeps working on the frozen Node baseline.
 *
 * IMPORTANT: a require() that only appears inside a comment is NOT a dependency.
 * The previous handoff was nearly misled by exactly that ('notifystorage' looked
 * live because a commented-out require() was counted). stripComments() keeps every
 * byte and every line break in place so reported line numbers stay true.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLIENT_ROOT = path.resolve(SERVER_ROOT, '..', 'client');

const SKIP_DIRS = new Set(['node_modules', 'dist', '_ui_verify', '_widgets', '_pkg', '.git']);

/** Replace comments with spaces, preserving string literals and every line break. */
function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    let state = 'code';

    while (i < n) {
        const c = src[i];
        const d = src[i + 1];

        if (state === 'code') {
            if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
            if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
            if (c === "'" || c === '"' || c === '`') { state = c === "'" ? 'single' : (c === '"' ? 'double' : 'template'); out += c; i += 1; continue; }
            out += c; i += 1; continue;
        }
        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += c; } else { out += ' '; }
            i += 1; continue;
        }
        if (state === 'block') {
            if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
            out += (c === '\n' ? '\n' : ' ');
            i += 1; continue;
        }
        // inside a string literal
        if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue; }
        if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) {
            state = 'code';
        }
        out += c; i += 1;
    }
    return out;
}

/** Recursive list of .js files below dir, skipping build output and dependencies. */
function listJsFiles(dir) {
    const found = [];
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.js')) { found.push(full); }
        }
    };
    walk(dir);
    return found.sort();
}

/** Path relative to the server root, always with forward slashes. */
function rel(abs) {
    return path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
}

function readSource(abs) {
    return stripComments(fs.readFileSync(abs, 'utf8'));
}

/** Relative require() specifiers found in a file, comments excluded. */
function requireSpecifiers(abs) {
    const src = readSource(abs);
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    const specs = [];
    let m;
    while ((m = re.exec(src))) { specs.push({ spec: m[1], index: m.index }); }
    return specs;
}

/** Resolve one relative specifier to a real file, or null. */
function resolveRequire(fromAbs, spec) {
    if (!spec.startsWith('.')) { return null; }
    const base = path.resolve(path.dirname(fromAbs), spec);
    const candidates = [base + '.js', path.join(base, 'index.js'), base];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) { return c; }
    }
    return null;
}

/** Map of absolute file -> array of absolute files it requires (internal edges only). */
function buildGraph(files) {
    const graph = new Map();
    for (const f of files) {
        const targets = [];
        for (const { spec } of requireSpecifiers(f)) {
            const t = resolveRequire(f, spec);
            if (t) { targets.push(t); }
        }
        graph.set(f, [...new Set(targets)]);
    }
    return graph;
}

/** Every external (non-relative) package required by a file. */
function externalPackages(abs) {
    return requireSpecifiers(abs)
        .map(({ spec }) => spec)
        .filter((s) => !s.startsWith('.'))
        .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
}

/**
 * Every .js file of the shipped server, test/ excluded.
 * This is the graph that answers "can the product actually load this?" - a module
 * reachable only from a test file is not part of the product.
 */
function serverTreeFiles() {
    return listJsFiles(SERVER_ROOT)
        .filter((f) => !rel(f).startsWith('test/'));
}

/** Both halves of the plane under guard, as absolute paths. */
function serverLayers() {
    const runtime = listJsFiles(path.join(SERVER_ROOT, 'runtime'));
    const api = listJsFiles(path.join(SERVER_ROOT, 'api'));
    return { runtime, api, all: [...runtime, ...api] };
}

/** Directed cycles in a graph. Returns arrays of absolute paths. */
function findCycles(graph) {
    const color = new Map();
    const stack = [];
    const cycles = [];
    const visit = (node) => {
        color.set(node, 1);
        stack.push(node);
        for (const next of (graph.get(node) || [])) {
            if (!graph.has(next)) { continue; }
            const c = color.get(next) || 0;
            if (c === 1) {
                cycles.push(stack.slice(stack.indexOf(next)).concat(next));
            } else if (c === 0) {
                visit(next);
            }
        }
        stack.pop();
        color.set(node, 2);
    };
    for (const node of graph.keys()) {
        if ((color.get(node) || 0) === 0) { visit(node); }
    }
    return cycles;
}

/** The shape of a module's public surface: name -> "kind" or "kind/arity". */
function exportShape(abs) {
    let loaded;
    try { loaded = require(abs); } catch (err) { return { error: err.message }; }
    const shape = {};
    for (const key of Object.keys(loaded).sort()) {
        const value = loaded[key];
        if (typeof value === 'function') { shape[key] = 'function/' + value.length; }
        else if (value === undefined) { shape[key] = 'undefined'; }
        else { shape[key] = typeof value; }
    }
    return shape;
}

/**
 * The instance-level contract of a backend adapter, read statically.
 *
 * \`module.exports.create\` is only the door. What the facade actually calls is the object
 * create() hands back, and that surface was never frozen until this was written - which is
 * exactly the shape three more backends (D8-D10) have to re-implement.
 *
 * Read from source rather than by constructing one: constructing a backend can open a
 * socket, a file or a database, and a guard must not need any of those to exist.
 */
function instanceMethods(abs) {
    const src = readSource(abs);
    const names = new Set();
    const re = /this\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
    let m;
    while ((m = re.exec(src))) { names.add(m[1]); }
    return [...names].sort();
}

/**
 * Exports that cannot possibly hold a value, found by reading the file rather than by
 * loading it: loading 118 modules costs ~22s and must not be the price of a guard.
 *
 * Two shapes are caught, both of which are always wrong at module scope:
 *   - a value that is a member expression on 'this' ("getSum: this.getSum" resolves to
 *     undefined, because module.exports is still the empty object being built);
 *   - a bare identifier that appears nowhere else in the file, so nothing declares it.
 *
 * Late-bound module state (assigned during init) still shows up elsewhere in the file
 * and is therefore not flagged.
 */
function impossibleExportBindings(abs) {
    const src = readSource(abs);
    const block = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
    if (!block) { return []; }

    const problems = [];
    for (const line of block[1].split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('//')) { continue; }

        const pair = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*(.+?),?\s*$/);
        const shorthand = trimmed.match(/^([A-Za-z_$][\w$]*)\s*,?\s*$/);
        const key = pair ? pair[1] : (shorthand ? shorthand[1] : null);
        const value = pair ? pair[2].trim() : (shorthand ? shorthand[1] : null);
        if (key === null) { continue; }

        if (/^this\s*\./.test(value)) {
            problems.push(key + ': ' + value + '  (at module scope, this is not the finished export object)');
            continue;
        }
        if (!/^[A-Za-z_$][\w$]*$/.test(value)) { continue; }

        const occurrences = src.split(new RegExp('\\b' + value + '\\b')).length - 1;
        if (occurrences <= 1) {
            problems.push(key + ': ' + value + '  (nothing in the file ever declares ' + value + ')');
        }
    }
    return problems;
}

/** True when the file assigns the binding somewhere (late-bound module state). */
function isAssignedInSource(abs, name) {
    const src = readSource(abs);
    const re = new RegExp('(^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*=[^=]');
    return re.test(src);
}

/**
 * Replace the CONTENT of every string literal with spaces, keeping quotes and length.
 * With comments already stripped by readSource(), this makes brace matching reliable:
 * a brace inside a string can no longer be mistaken for a block opener.
 *
 * Template literals are handled specially: their literal text is masked, but an
 * interpolated expression stays code. Masking the whole template makes a message such as
 *   logger.warn("failed: " + err.message)
 * look like a swallowed error when the binding is only ever mentioned inside the
 * interpolation - a false positive measured on two real catch blocks before this existed.
 */
function maskStringContents(src) {
    const BACKTICK = String.fromCharCode(96);
    let out = '';
    let i = 0;
    const stack = [];
    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const push = (frame, ch) => { stack.push(frame); out += ch; i += 1; };

    while (i < src.length) {
        const c = src[i];
        const frame = top();

        if (frame === null) {
            if (c === BACKTICK) { push({ kind: 'tpl' }, c); continue; }
            if (c === "'" || c === '"') { push({ kind: 'lit', quote: c }, c); continue; }
            out += c; i += 1; continue;
        }

        if (frame.kind === 'lit') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (c === frame.quote) { stack.pop(); out += c; i += 1; continue; }
            out += (c === '\n' ? '\n' : ' ');
            i += 1; continue;
        }

        if (frame.kind === 'tpl') {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (c === BACKTICK) { stack.pop(); out += c; i += 1; continue; }
            if (c === '$' && src[i + 1] === '{') {
                stack.push({ kind: 'expr', depth: 1 });
                out += '$' + '{';
                i += 2; continue;
            }
            out += (c === '\n' ? '\n' : ' ');
            i += 1; continue;
        }

        // inside the braces of an interpolation: real code again
        if (c === '{') { frame.depth += 1; out += c; i += 1; continue; }
        if (c === '}') { frame.depth -= 1; out += c; i += 1; if (frame.depth === 0) { stack.pop(); } continue; }
        if (c === BACKTICK) { push({ kind: 'tpl' }, c); continue; }
        if (c === "'" || c === '"') { push({ kind: 'lit', quote: c }, c); continue; }
        out += c; i += 1;
    }
    return out;
}

/**
 * Every catch clause in a file, with the body range and whether the caught binding is
 * actually used. A caught error that is never read is a failure nobody will ever see.
 */
function caughtBindings(abs) {
    const raw = fs.readFileSync(abs, 'utf8');
    const src = maskStringContents(readSource(abs));
    const found = [];
    const re = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
        const name = m[1];
        let depth = 0;
        let end = -1;
        for (let i = re.lastIndex - 1; i < src.length; i += 1) {
            if (src[i] === '{') { depth += 1; }
            else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        if (end === -1) { continue; }
        const body = src.slice(re.lastIndex, end);
        const line = src.slice(0, m.index).split('\n').length;
        const rawLine = raw.split('\n')[line - 1] || '';
        const rawAbove = (raw.split('\n')[line - 2] || '').trim();
        const hasInline = /\/\*[\s\S]*\*\//.test(rawLine) || /\/\//.test(rawLine.split('catch')[0]);
        const hasAbove = rawAbove.endsWith('*/') || rawAbove.startsWith('//') ||
            rawAbove.startsWith('*') || rawAbove.startsWith('/*');
        found.push({
            line: line,
            name: name,
            usesBinding: new RegExp('\\b' + name + '\\b').test(body),
            explained: hasInline || hasAbove,
            body: raw.slice(re.lastIndex, end).replace(/\s+/g, ' ').trim().slice(0, 90)
        });
    }
    return found;
}

module.exports = {
    SERVER_ROOT,
    CLIENT_ROOT,
    SKIP_DIRS,
    stripComments,
    listJsFiles,
    rel,
    readSource,
    requireSpecifiers,
    resolveRequire,
    buildGraph,
    externalPackages,
    serverLayers,
    serverTreeFiles,
    findCycles,
    exportShape,
    isAssignedInSource,
    impossibleExportBindings,
    maskStringContents,
    caughtBindings,
    instanceMethods
};
