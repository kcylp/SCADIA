/**
 * The client test runner must keep existing (N-5).
 *
 * The client had no unit-test runner at all until batch 67: angular.json pointed at src/karma.conf.js
 * and src/test.ts, neither of which existed, there was not one .spec.ts under src/, and package.json had
 * no test script. Every client rule therefore had to be enforced by a guard on the SERVER side that
 * reads client SOURCE TEXT - which can ask "does this string appear", never "is this arithmetic right".
 *
 * This guard cannot run the suite (that needs a browser and about a minute; it is a separate command,
 * `cd client && npm test`, recorded in the hand-off card). What it CAN do is make the wiring impossible
 * to delete quietly: if somebody removes the script, the karma config, the spec tsconfig or the last spec
 * file, the gate says so instead of the capability evaporating again.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_ROOT = path.join(SERVER_ROOT, '..', 'client');

/** Every .spec.ts under the client source tree. */
function specFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.angular') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.spec.ts')) { out.push(full); }
        }
    };
    walk(path.join(CLIENT_ROOT, 'src'));
    return out.sort();
}

describe('the client has a unit-test runner, and it stays wired up', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'));

    it('the scan really scanned something', function () {
        expect(fs.existsSync(CLIENT_ROOT), 'the client tree is not where this guard thinks it is: ' + CLIENT_ROOT)
            .to.equal(true);
        expect(fs.existsSync(path.join(CLIENT_ROOT, 'angular.json'))).to.equal(true);
    });

    it('package.json declares a test script that runs karma once', function () {
        const script = pkg.scripts && pkg.scripts.test;
        expect(script, 'the client has no test script again - the suite cannot be run by anybody').to.be.a('string');
        expect(script, 'the test script must not watch: it has to be runnable from a script').to.include('--watch=false');
    });

    it('the files angular.json points at exist', function () {
        const angular = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'angular.json'), 'utf8'));
        const first = Object.values(angular.projects)[0];
        const targets = first.architect || first.targets;
        const test = targets.test;
        expect(test, 'angular.json no longer declares a test target').to.not.equal(undefined);
        expect(test.builder).to.equal('@angular-devkit/build-angular:karma');
        ['tsConfig', 'karmaConfig'].forEach((key) => {
            const rel = test.options[key];
            if (!rel) { return; }
            expect(fs.existsSync(path.join(CLIENT_ROOT, rel)),
                'angular.json points at ' + rel + ', which does not exist - that is exactly the state batch 67 found')
                .to.equal(true);
        });
    });

    it('the runner dependencies are declared, not merely installed', function () {
        const dev = pkg.devDependencies || {};
        ['karma', 'karma-chrome-launcher', 'karma-jasmine', 'jasmine-core', '@types/jasmine'].forEach((name) => {
            expect(dev[name], name + ' must stay declared: a fresh clone has to be able to run the suite')
                .to.be.a('string');
        });
    });

    it('there is a spec file, and it is not empty', function () {
        const specs = specFiles();
        expect(specs.length, 'every client spec is gone - the runner has nothing to run').to.be.greaterThan(0);
        const withCases = specs.filter((f) => /\bit\(/.test(fs.readFileSync(f, 'utf8')));
        expect(withCases.length, 'no spec file contains a test case').to.be.greaterThan(0);
    });
});
