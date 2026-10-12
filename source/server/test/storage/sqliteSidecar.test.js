'use strict';

/**
 * SQLite sidecar handling for DAQ archives (2026-09-29, contract 12 / ledger L-11).
 *
 * Rotating the DAQ database used to move only the .db file. With WAL journalling a
 * committed transaction can still live in the -wal companion, so moving the main file
 * alone could lose committed data and leave sidecars orphaned beside a path that no
 * longer exists. These tests pin the companion handling.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const sqliteStorage = require('../../runtime/storage/sqlite/index');

describe('SQLite database sidecars', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-sidecar-'));
    });

    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    });

    function makeDb(name, companions) {
        const db = path.join(dir, name);
        fs.writeFileSync(db, 'db');
        (companions || []).forEach(function (suffix) {
            fs.writeFileSync(db + suffix, suffix);
        });
        return db;
    }

    it('knows every sidecar SQLite can leave behind', () => {
        expect(sqliteStorage._private.DB_COMPANIONS)
            .to.have.members(['-journal', '-wal', '-shm']);
    });

    it('moves -wal and -shm alongside the archived database', () => {
        const db = makeDb('daq.db', ['-wal', '-shm']);
        const archived = path.join(dir, 'archive', 'daq_20260101.db');
        fs.mkdirSync(path.dirname(archived), { recursive: true });

        fs.renameSync(db, archived);
        const moved = sqliteStorage._private.touchCompanions(db, { moveTo: archived });

        expect(moved).to.have.length(2);
        expect(fs.existsSync(archived + '-wal')).to.equal(true, 'the WAL must travel with the database');
        expect(fs.existsSync(archived + '-shm')).to.equal(true);
        expect(fs.existsSync(db + '-wal')).to.equal(false, 'no orphan beside the old path');
        expect(fs.existsSync(db + '-shm')).to.equal(false);
    });

    it('moves a rollback journal as well', () => {
        const db = makeDb('daq.db', ['-journal']);
        const archived = path.join(dir, 'archive', 'daq_20260101.db');
        fs.mkdirSync(path.dirname(archived), { recursive: true });

        fs.renameSync(db, archived);
        const moved = sqliteStorage._private.touchCompanions(db, { moveTo: archived });

        expect(moved).to.have.length(1);
        expect(fs.existsSync(archived + '-journal')).to.equal(true);
    });

    it('is a no-op when no sidecar exists', () => {
        const db = makeDb('plain.db');
        const target = path.join(dir, 'x.db');
        const moved = sqliteStorage._private.touchCompanions(db, { moveTo: target });
        expect(moved).to.deep.equal([]);
    });

    it('removes a database together with its sidecars', () => {
        const db = makeDb('void.db', ['-wal', '-shm']);
        sqliteStorage._private.unlinkDatabase(db);

        expect(fs.existsSync(db)).to.equal(false);
        expect(fs.existsSync(db + '-wal')).to.equal(false);
        expect(fs.existsSync(db + '-shm')).to.equal(false);
    });

    it('does not clobber a file already present at the destination', () => {
        const db = makeDb('daq.db', ['-wal']);
        const archived = path.join(dir, 'archive', 'daq_20260101.db');
        fs.mkdirSync(path.dirname(archived), { recursive: true });
        fs.writeFileSync(archived + '-wal', 'stale');

        fs.renameSync(db, archived);
        sqliteStorage._private.touchCompanions(db, { moveTo: archived });

        expect(fs.readFileSync(archived + '-wal', 'utf8')).to.equal('-wal');
    });
});
