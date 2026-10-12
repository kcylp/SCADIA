/**
 * The no-undef gate, in the DELIVERY tree (ported 2026-10-09).
 *
 * WHY IT IS HERE NOW. The gate was built in the source tree (batch 31-53) and never came across.
 * The 2026-10-09 restart then produced a live example of exactly what it catches: the SCADIA-server
 * driver referenced a \`runtime\` its factory had never received, so EVERY value emission from the
 * internal device threw - silently, because polling() catches and logs. The source tree had fixed
 * that in batch 34. The delivery tree had not, and nothing in the delivery tree could have said so:
 * \`node --check\` passes, \`require()\` passes, the server boots, and the alarm chain even worked
 * (it read values by a path that bypassed the throwing emitter).
 *
 * A first sweep of the delivery tree with this gate found 28 findings across 8 files, every one of
 * them a real "reference to a name that does not exist" defect. It is now at zero, and this file
 * exists so it stays there.
 *
 * WHAT IT IS NOT. Not a style config, not eslint:recommended. Exactly one rule, in its own file
 * (.eslintrc.gate.json), so "the gate is green" keeps meaning what it says.
 *
 * It runs the SAME script a human would run (npm run test:lint) rather than re-deriving the file
 * list, so the two cannot drift apart.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(SERVER_ROOT, '.eslintrc.gate.json');

describe('the no-undef gate', () => {
    it('is wired as a script, with a config that enables exactly one rule', function () {
        const pkg = require(path.join(SERVER_ROOT, 'package.json'));
        expect(pkg.scripts['test:lint'], 'the lint script is gone - this guard should be deleted with it, ' +
            'not left pointing at nothing').to.be.a('string');
        expect(pkg.devDependencies.eslint, 'eslint must be a declared devDependency, not a global ' +
            'that happens to be installed on one machine').to.be.a('string');

        const config = require(CONFIG);
        expect(Object.keys(config.rules), 'this config checks ONE thing on purpose; a second rule ' +
            'needs its own decision and its own baseline').to.deep.equal(['no-undef']);
        expect(config.rules['no-undef']).to.equal('error');
    });

    it('finds nothing, and says so out loud', function () {
        this.timeout(180000);
        // One shell command string, not an argv array: passing an ARRAY together with shell:true is
        // deprecated on Node (DEP0190, "arguments are concatenated, not escaped"), and it printed a
        // warning into the gate output.
        const run = spawnSync('npm run test:lint --silent', {
            cwd: SERVER_ROOT, encoding: 'utf8', timeout: 150000, shell: true
        });

        const output = ((run.stdout || '') + (run.stderr || '')).trim();
        expect(run.status, 'the lint gate reported findings (or failed to run):\n' + output).to.equal(0);
        // ESLint prints nothing at all when it finds nothing; an empty result is the pass, and
        // requiring the config to have been READ stops a silently-broken invocation from passing.
        expect(output, 'no output is expected from a clean run').to.equal('');
    });
});
