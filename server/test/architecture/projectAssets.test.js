/**
 * The project's own artwork must still be there.
 *
 * A screen references its artwork by URL - xlink:href="/_images/zc/<hash>.png" - and the server
 * turns that into a file under <rootDir>/_images (main.js:107, mounted at main.js:473). Nothing
 * in that chain fails loudly: a missing file is simply a blank rectangle in the SVG, which is
 * exactly how a showroom screen ships one image short without anybody noticing.
 *
 * So this is a guard, not a lint: every asset a screen references must exist on disk, under the
 * very path the browser asks for. The artwork does not live under source/, which is why the
 * branding guard and every architecture guard are blind to it.
 *
 * The project is located the way the server locates it - as a directory beside this repository -
 * and can be pointed at another site with SCADIA_PROJECT_DIR.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const PROJECT_DIR = process.env.SCADIA_PROJECT_DIR
    ? path.resolve(process.env.SCADIA_PROJECT_DIR)
    : path.join(SERVER_ROOT, '..', '..', 'project');

const DB_FILE = path.join(PROJECT_DIR, '_appdata', 'project.scadiap.db');
const IMAGES_DIR = path.join(PROJECT_DIR, '_images');

/** Every asset reference inside a screen's svgcontent, as the browser would request it. */
function assetRefs(svgcontent) {
    const refs = new Set();
    const re = /(?:xlink:href|href)\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(String(svgcontent || '')))) {
        const value = m[1].trim();
        if (value.indexOf('/_images/') === 0) { refs.add(value); }
    }
    return [...refs];
}

/** The on-disk file a /_images/... URL resolves to. */
function fileForRef(ref, base) {
    const rel = ref.replace(/^\/_images\//, '').split('/').join(path.sep);
    return path.join(base, rel);
}

describe('project assets (a screen must not ship one image short)', () => {
    let expect;
    let openDb;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
        openDb = (file) => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
    });

    it('finds the project it is supposed to be guarding', () => {
        expect(fs.existsSync(DB_FILE),
            'no project database at ' + DB_FILE + '. Point SCADIA_PROJECT_DIR at the site, or this ' +
            'guard is quietly checking nothing.').to.equal(true);
        expect(fs.existsSync(IMAGES_DIR), 'no _images directory at ' + IMAGES_DIR).to.equal(true);
    });

    it('resolves every asset a screen references to a file that exists', () => {
        const db = openDb(DB_FILE);
        const views = db.prepare('SELECT name, value FROM views').all();
        expect(views.length, 'a project with no screens is not a project').to.be.greaterThan(0);

        const missing = [];
        let checked = 0;
        for (const row of views) {
            let view;
            try { view = JSON.parse(row.value); } catch (err) { continue; }
            for (const ref of assetRefs(view.svgcontent)) {
                checked += 1;
                if (!fs.existsSync(fileForRef(ref, IMAGES_DIR))) {
                    missing.push(row.name + '  ->  ' + ref);
                }
            }
        }
        db.close();

        expect(checked, 'no screen referenced any artwork - the scanner is broken, not the project')
            .to.be.greaterThan(0);
        expect(missing, 'these references resolve to nothing, so they render as a blank rectangle:\n' +
            missing.join('\n')).to.deep.equal([]);
    });

    it('reports art directories that no screen references', () => {
        // zc/ and the Chinese-named twin hold the same artwork. Removing one is legitimate once
        // no screen asks for it - so this reports rather than forbids, and the point is that the
        // decision is made deliberately instead of by a cleanup script.
        const db = openDb(DB_FILE);
        const refs = [];
        for (const row of db.prepare('SELECT value FROM views').all()) {
            let view;
            try { view = JSON.parse(row.value); } catch (err) { continue; }
            refs.push(...assetRefs(view.svgcontent));
        }
        db.close();

        const dirs = fs.readdirSync(IMAGES_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => e.name);
        expect(dirs.length, 'no art directories found under ' + IMAGES_DIR).to.be.greaterThan(0);

        const unused = dirs.filter((dir) => !refs.some((ref) => ref.indexOf('/_images/' + dir + '/') === 0));
        if (unused.length) {
            console.log('        note: art directories referenced by no screen: ' + unused.join(', '));
        }
    });
});
