#!/usr/bin/env node
'use strict';

/**
 * Recover a client source file from the Angular build's sourcemap.
 *
 * WHY THIS EXISTS. In batch 38 a scripted deletion went wrong and removed roughly 490 lines from
 * client/src/app/gauges/gauges.component.ts - nine whole methods - with no backup in the repository.
 * The file was recovered completely, and the thing that made recovery possible was this:
 *
 *   client/dist/main.js.map contains a sourcesContent entry for EVERY client source file.
 *
 * That is a property of the Angular build, not luck, and it is worth having a tool for rather than
 * rediscovering the technique under pressure. This script is that tool.
 *
 * USAGE  (run from the repository root: 源代码/)
 *
 *   node server/scripts/recover-from-sourcemap.js --list
 *   node server/scripts/recover-from-sourcemap.js --diff    app/gauges/gauges.component.ts
 *   node server/scripts/recover-from-sourcemap.js --restore app/gauges/gauges.component.ts
 *
 * Run --diff FIRST. It answers "did I just lose code?" without writing anything.
 *
 * LIMIT: a restore brings back the file AS OF THE LAST BUILD, so edits made after that build are
 * lost. The tool refuses in the two cases where that would do harm - see the guards below.
 */

const fs = require('fs');
const path = require('path');

/** server/scripts -> the repository root (the directory holding client/ and server/). */
const ROOT = path.join(__dirname, '..', '..');
const MAP_PATH = path.join(ROOT, 'client', 'dist', 'main.js.map');

function loadMap() {
    if (!fs.existsSync(MAP_PATH)) {
        console.error('No build sourcemap at ' + MAP_PATH);
        console.error('Run "npx ng build" in client/ first; without a build there is nothing to recover from.');
        process.exit(2);
    }
    const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
        console.error('The sourcemap has no usable sourcesContent.');
        process.exit(2);
    }
    return map;
}

function buildCopy(map, fragment) {
    const wanted = String(fragment).replace(/\\/g, '/');
    const idx = map.sources.findIndex((s) => s.replace(/\\/g, '/').endsWith(wanted));
    return idx === -1 ? null : { source: map.sources[idx], content: map.sourcesContent[idx] };
}

function realPath(source) {
    return path.join(ROOT, 'client', source.replace(/^\.\//, ''));
}

function lines(text) {
    return text === null ? 0 : text.split(/\r?\n/).length;
}

function main() {
    const args = process.argv.slice(2);
    const mode = args[0];
    const map = loadMap();

    if (mode === '--list' || !mode) {
        const sources = map.sources.filter((s) => s.endsWith('.ts') && !s.endsWith('.spec.ts'));
        console.log(sources.length + ' source files in the current build:');
        sources.sort().forEach((s) => console.log('  ' + s));
        return;
    }

    const fragment = args[1];
    if (!fragment) {
        console.error('Give a path fragment, e.g. app/gauges/gauges.component.ts');
        process.exit(2);
    }

    const found = buildCopy(map, fragment);
    if (!found) {
        console.error('No source matching ' + fragment + ' in the build. Use --list to see what is there.');
        process.exit(2);
    }

    const target = realPath(found.source);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

    console.log('build copy  : ' + found.source + '  (' + found.content.length + ' bytes, ' + lines(found.content) + ' lines)');
    console.log('working file: ' + path.relative(ROOT, target) + '  (' +
        (current === null ? 'MISSING' : current.length + ' bytes, ' + lines(current) + ' lines') + ')');

    if (mode === '--diff') {
        if (current !== null && current === found.content) {
            console.log('IDENTICAL - the working file matches the build.');
            return;
        }
        const build = found.content.split(/\r?\n/);
        const working = new Set((current || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 10));
        const lost = build.filter((l) => l.trim().length > 10 && !working.has(l.trim()));
        console.log('DIFFERENT.');
        console.log('  lines in the build copy NOT in the working file: ' + lost.length);
        lost.slice(0, 40).forEach((l) => console.log('    - ' + l.trim().slice(0, 100)));
        if (lost.length > 40) {
            console.log('    ... and ' + (lost.length - 40) + ' more');
        }
        console.log('If that list is large, code has been LOST. Use --restore to put the build copy back.');
        return;
    }

    if (mode === '--restore') {
        // GUARD 1: a build is a snapshot, so restoring DISCARDS anything written since. If the
        // working file is LARGER than the build copy, real work happened after the last build.
        if (current !== null && lines(current) > lines(found.content)) {
            console.error('REFUSING: working file has ' + lines(current) + ' lines, build copy has ' +
                lines(found.content) + '. The file is probably NEWER than the build, so restoring would discard work.');
            console.error('Run --diff first; rebuild if you really want the newer source.');
            process.exit(1);
        }
        // GUARD 2: restoring is for damage. A file within 10% of the build copy is not obviously damaged,
        // and a restore there would silently roll back whatever intentional edit it holds.
        if (current !== null && lines(current) >= lines(found.content) * 0.9) {
            console.error('REFUSING: the working file is within 10% of the build copy in size, so a restore would ' +
                'not obviously fix anything. Run --diff first.');
            process.exit(1);
        }
        fs.writeFileSync(target, found.content, 'utf8');
        const written = fs.readFileSync(target, 'utf8');
        console.log('restored ' + path.relative(ROOT, target));
        console.log('  bytes: ' + written.length + ', lines: ' + lines(written));
        console.log('  verbatim: ' + (written === found.content));
        return;
    }

    console.error('Unknown mode "' + mode + '". Use --list, --diff <fragment> or --restore <fragment>.');
    process.exit(2);
}

main();
