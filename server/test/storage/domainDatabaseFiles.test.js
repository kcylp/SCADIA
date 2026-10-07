/**
 * Domain database files - one rule, one home, and no silent empty database.
 *
 * The eight domain stores used to spell their own database file: four as <domain>.scadiap.db
 * and four as <domain>.db, because the branding rename only reached the first half. A later
 * store was written the other way and nothing noticed.
 *
 * The names now live in one table (runtime/storage/databases.js). This file pins the part
 * that makes that table safe rather than merely tidy:
 *
 *   - a site whose database is still under an old name keeps using THAT file - nothing is
 *     moved or copied, so no history is at risk - and the resolver says so out loud;
 *   - when two files both hold data it refuses, because picking one would be choosing which
 *     site's history to ignore (contract 05 G-MIG-2: new name first, old name as fallback,
 *     and an error when both exist);
 *   - a stray -wal/-shm companion is not mistaken for a second database, or a leftover
 *     journal would stop the server from starting.
 *
 * Why this needs a test rather than a convention: the failure mode is silent. A rename that
 * misses a file does not throw - it opens an empty database, and the site quietly starts over.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../../runtime/storage/databases');

const SERVER_ROOT = path.join(__dirname, '..', '..');

/** The domains that own a private store, and the module that opens it. */
const DOMAIN_STORES = {
    alarms: 'runtime/alarms/alarmstorage.js',
    apikeys: 'runtime/apikeys/apiKeysStorage.js',
    users: 'runtime/users/usrstorage.js',
    project: 'runtime/project/prjstorage.js',
    cameras: 'runtime/cameras/camera-storage.js',
    recipes: 'runtime/recipes/recipe-storage.js',
    scheduler: 'runtime/scheduler/scheduler-storage.js',
    calibration: 'runtime/calibration/calibration-storage.js',
    notifications: 'runtime/notificator/notifications-storage.js'
};

/**
 * Every module on disk that claims to own a domain store.
 * runtime/storage/** IS the storage plane - the DAQ adapter and its last-value store - so it
 * is not a domain's private database and is judged separately.
 */
function storeModulesOnDisk() {
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!/storage\.js$/i.test(e.name)) { continue; }
            const rel = path.relative(SERVER_ROOT, full).split(path.sep).join('/');
            if (rel.startsWith('runtime/storage/')) { continue; }
            found.push(rel);
        }
    };
    walk(path.join(SERVER_ROOT, 'runtime'));
    return found.sort();
}

/** Every .js under runtime/ outside the storage plane, as repo-relative posix paths. */
function domainSideFiles() {
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.name.endsWith('.js')) { continue; }
            const rel = path.relative(SERVER_ROOT, full).split(path.sep).join('/');
            if (rel.startsWith('runtime/storage/')) { continue; }
            found.push(rel);
        }
    };
    walk(path.join(SERVER_ROOT, 'runtime'));
    return found.sort();
}

describe('domain database files (contract 05 G-MIG-2)', () => {
    let expect;
    const tmpDirs = [];

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    after(() => {
        tmpDirs.forEach((dir) => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* disposable */ }
        });
    });

    const tmp = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-dbfile-'));
        tmpDirs.push(dir);
        return dir;
    };

    const silent = { info: () => {}, warn: () => {}, error: () => {} };

    /** A logger that remembers what it was told, so a warning can be asserted on. */
    const collecting = (sink) => ({
        info: (m) => sink.push('info:' + m),
        warn: (m) => sink.push('warn:' + m),
        error: (m) => sink.push('error:' + m)
    });

    it('declares a database for exactly the domains that own a store on disk', () => {
        expect(Object.keys(storage.DOMAIN_DB_FILES).sort(),
            'the declared table and the modules on disk must describe the same world')
            .to.deep.equal(Object.keys(DOMAIN_STORES).sort());
        expect(storeModulesOnDisk()).to.deep.equal(Object.values(DOMAIN_STORES).sort());
    });

    it('names every domain database by one rule', () => {
        for (const id of Object.keys(storage.DOMAIN_DB_FILES)) {
            expect(storage.DOMAIN_DB_FILES[id], id + ' must follow the single naming rule')
                .to.equal(id + '.scadiap.db');
        }
    });

    it('opens a fresh site under the canonical name', () => {
        const dir = tmp();
        expect(storage.resolveDbFile(dir, 'cameras', silent))
            .to.equal(path.join(dir, 'cameras.scadiap.db'));
    });

    it('adopts the file a site already has instead of starting an empty database', () => {
        const dir = tmp();
        const legacy = path.join(dir, 'cameras.db');
        fs.writeFileSync(legacy, 'this site history');

        const logs = [];
        const resolved = storage.resolveDbFile(dir, 'cameras', collecting(logs));

        expect(resolved, 'the existing file must win over a fresh empty one').to.equal(legacy);
        expect(fs.readFileSync(resolved, 'utf8'), 'nothing may be moved or copied').to.equal('this site history');
        expect(logs.join('\n'), 'and it must be said out loud, not done quietly')
            .to.contain('cameras.db');
        expect(logs.join('\n')).to.contain('cameras.scadiap.db');
    });

    it('recognises a pre-rename file as an old name instead of paving over it', () => {
        const dir = tmp();
        const ancient = path.join(dir, 'recipes.fuxap.db');
        fs.writeFileSync(ancient, 'pre-rename history');

        const logs = [];
        expect(storage.resolveDbFile(dir, 'recipes', collecting(logs))).to.equal(ancient);
        expect(logs.join('\n')).to.contain('recipes.fuxap.db');
    });

    it('refuses to choose when two files both hold data', () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'recipes.scadiap.db'), 'one site');
        fs.writeFileSync(path.join(dir, 'recipes.db'), 'another site');

        expect(() => storage.resolveDbFile(dir, 'recipes', silent))
            .to.throw(/two names/);
    });

    it('refuses when more than one old name is present', () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'users.db'), 'one');
        fs.writeFileSync(path.join(dir, 'users.fuxap.db'), 'another');

        expect(() => storage.resolveDbFile(dir, 'users', silent))
            .to.throw(/more than one old name/);
    });

    it('refuses a domain that was never declared', () => {
        const dir = tmp();
        expect(() => storage.resolveDbFile(dir, 'nosuchdomain', silent),
            'an undeclared name is how this tree ended up half renamed')
            .to.throw(/no database file is declared/);
    });

    it('does not mistake a -wal or -shm companion for a second database', () => {
        const canonical = tmp();
        fs.writeFileSync(path.join(canonical, 'scheduler.scadiap.db'), 'db');
        fs.writeFileSync(path.join(canonical, 'scheduler.scadiap.db-wal'), 'journal');
        fs.writeFileSync(path.join(canonical, 'scheduler.scadiap.db-shm'), 'journal');
        expect(storage.resolveDbFile(canonical, 'scheduler', silent),
            'a leftover journal must not stop the server from starting')
            .to.equal(path.join(canonical, 'scheduler.scadiap.db'));

        const legacy = tmp();
        fs.writeFileSync(path.join(legacy, 'scheduler.db'), 'db');
        fs.writeFileSync(path.join(legacy, 'scheduler.db-wal'), 'journal');
        expect(storage.resolveDbFile(legacy, 'scheduler', silent))
            .to.equal(path.join(legacy, 'scheduler.db'));
    });

    it('routes every domain store through the resolver', () => {
        for (const id of Object.keys(DOMAIN_STORES)) {
            const rel = DOMAIN_STORES[id];
            const text = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
            expect(text, rel + ' must ask the storage plane for its database file')
                .to.contain("storage.resolveDbFile(settings.workDir, '" + id + "'");
        }
    });

    it('leaves no second place that decides a database file name', () => {
        const offenders = [];
        for (const rel of domainSideFiles()) {
            const text = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
            text.split(/\r?\n/).forEach((line, index) => {
                if (/\.db['"]/.test(line)) {
                    offenders.push(rel + ':' + (index + 1) + '  ' + line.trim());
                }
            });
        }
        expect(offenders, 'a domain must not spell a database file of its own:\n' + offenders.join('\n'))
            .to.deep.equal([]);
    });
});
