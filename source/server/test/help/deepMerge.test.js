'use strict';

/**
 * Utils.deepMerge (2026-09-29).
 *
 * This function is on the server's STARTUP path: main.js merges settings.default.js into an
 * older settings.js whenever the two version numbers differ. The recursive call used to be a
 * bare `deepMerge(...)`, which resolves against the enclosing scope where no such binding
 * exists, so it threw ReferenceError the moment recursion was entered. main.js catches that
 * and exits, so the server refused to start with only 'Error loading settings file' logged.
 *
 * The tests below therefore check both directions: user values must survive, and newly
 * introduced default fields must be filled in.
 */

const { expect } = require('chai');
const Utils = require('../../runtime/utils');

describe('Utils.deepMerge', () => {
    it('fills in keys the target is missing', () => {
        const target = { a: 1 };
        const out = Utils.deepMerge({ a: 0, b: 2, c: 3 }, target);
        expect(out).to.deep.equal({ a: 1, b: 2, c: 3 });
    });

    it('never overwrites a value the user already set', () => {
        // The whole point on the settings path: an upgrade must not reset the operator's
        // own port, paths or credentials.
        const target = { uiPort: 1881, user: 'admin' };
        const out = Utils.deepMerge({ uiPort: 3000, user: 'default', newField: true }, target);
        expect(out.uiPort).to.equal(1881);
        expect(out.user).to.equal('admin');
        expect(out.newField).to.equal(true);
    });

    it('recurses into nested objects WITHOUT throwing (the original defect)', () => {
        // A bare recursive call threw ReferenceError here; this is the regression guard.
        const target = { server: { port: 1, extra: 'keep' } };
        const out = Utils.deepMerge({ server: { port: 9, host: 'h', tls: { on: true } } }, target);
        expect(out.server.port).to.equal(1);
        expect(out.server.extra).to.equal('keep');
        expect(out.server.host).to.equal('h');
        expect(out.server.tls).to.deep.equal({ on: true });
    });

    it('descends three levels deep', () => {
        const out = Utils.deepMerge({ a: { b: { c: { d: 4 } } } }, { a: { b: { c: {} } } });
        expect(out.a.b.c.d).to.equal(4);
    });

    it('replaces arrays rather than merging them element-wise', () => {
        const out = Utils.deepMerge({ list: [1, 2, 3] }, { list: [9] });
        expect(out.list).to.deep.equal([9]);
    });

    it('fills a missing array/object wholesale', () => {
        const out = Utils.deepMerge({ list: [1, 2], obj: { x: 1 } }, {});
        expect(out.list).to.deep.equal([1, 2]);
        expect(out.obj).to.deep.equal({ x: 1 });
    });

    it('survives a reference cycle instead of recursing forever', () => {
        const source = { a: 1 };
        source.self = source;
        const target = { a: 2 };
        target.self = target;
        let out;
        expect(() => { out = Utils.deepMerge(source, target); }).to.not.throw();
        expect(out.a).to.equal(2);
    });

    it('returns the SAME target object (callers rely on the mutation)', () => {
        const target = {};
        expect(Utils.deepMerge({ a: 1 }, target)).to.equal(target);
    });

    it('merges the real settings.default.js into an older settings file', () => {
        // End-to-end shape of the startup path, with the shipped defaults.
        const defSettings = require('../../settings.default.js');
        const older = { version: 1.4, uiPort: 1881 };
        let out;
        expect(() => { out = Utils.deepMerge(defSettings, older); }).to.not.throw();
        expect(out.uiPort).to.equal(1881, 'operator value must survive');
        expect(out.version).to.equal(1.4, 'the file version is not rewritten by the merge');
        expect(Object.keys(out).length).to.be.greaterThan(5, 'default fields were merged in');
    });
});
