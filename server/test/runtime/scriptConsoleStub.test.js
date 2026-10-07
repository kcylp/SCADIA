/**
 * The script sandbox must define every console level it advertises.
 *
 * WHY THIS EXISTS - a defect that failed in complete silence.
 *
 * The console stub handed to scripts defined log() and nothing else, so a script calling
 * console.warn() / console.error() / console.info() / console.debug() threw
 * 'TypeError: console.<level> is not a function'. That throw IS caught - by the per-script
 * try/catch that wraps every script body - and its only handler is console.log(), a stub that
 * does not print in the test path. The script therefore stopped at that line with no output, no
 * error and no tag writes: a script that logged a warning on an ordinary early-return path was,
 * in effect, silently disabled, and nothing anywhere said so.
 *
 * The stub is injected by runTestScript(); runScript() executes the plain generated module and
 * does not inject it. These tests drive runTestScript, which is where the stub is in force.
 *
 * Each script is compiled as `async`, so the result is awaited.
 */
'use strict';

const { expect } = require('chai');
const path = require('path');
const msm = require(path.resolve(__dirname, '..', '..', 'runtime', 'scripts', 'msm.js'));

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

let seq = 0;

async function run(code) {
    const script = {
        id: 's_console_stub_' + (++seq),
        name: 'console stub probe ' + seq,
        code: code,
        sync: false,
        parameters: [],
        outputId: 'out',
        scheduling: { mode: 'interval', interval: 60000, schedules: [] },
        mode: 'server'
    };
    const mod = msm.create({ emit() {} }, silentLogger);
    mod.loadScripts([script]);
    return await mod['runTestScript'](script);
}

describe('script sandbox console', () => {
    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
        it('defines console.' + level + ' instead of throwing', async () => {
            const result = await run('console.' + level + "('probe'); return 'OK';");
            expect(result, 'console.' + level + ' threw - the script would stop here silently').to.equal('OK');
        });
    }

    it('a script that warns still reaches the end and returns its value', async () => {
        const result = await run("console.warn('a warning'); return 'COMPLETED';");
        expect(result).to.equal('COMPLETED');
    });
});
