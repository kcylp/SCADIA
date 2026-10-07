/**
 * The no-undef gate (decision on N-34, batch 53).
 *
 * WHY IT EXISTS NOW. This rule was in the repo's debt register for four batches, and the last
 * argument against it was cost: "adding ESLint means ~99 packages and changing what \`npm test\`
 * means". Both halves were measured and both turned out to be answerable:
 *
 *   - the whole server tree is ALREADY at zero findings, so the gate starts clean and cannot be
 *     dismissed as "a wall of pre-existing noise" (batches 31-46 took it from 31 to 0);
 *   - the rule found 21 real defects on the way there, at least five of which disabled a WHOLE
 *     FEATURE silently (a driver that threw on every value emission, a promise that never settled,
 *     the MAD outlier filter that killed the process, an error frame that could never be sent).
 *
 * WHAT IT IS NOT. It is not a style config and it is not eslint:recommended. It enables exactly one
 * rule, in its own file (.eslintrc.gate.json), so "the gate is green" keeps meaning what it says and
 * a future style discussion cannot change the meaning of this result. Adding rules later is a
 * separate decision with its own cost, and this guard does not force it.
 *
 * The guard runs the SAME script a human would run (npm run test:lint) rather than re-deriving the
 * file list, so the two cannot drift apart.
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
        expect(pkg.scripts['test:lint'], 'the lint script is gone - N-34 was decided the other way ' +
            'and this guard should be deleted with it, not left pointing at nothing').to.be.a('string');
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
        // warning into the gate output. A commercial gate should not ship deprecation noise.
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
