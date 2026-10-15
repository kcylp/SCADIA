/**
 * D1 support - run a probe script in its own process and collect its FILE output.
 *
 * The output is read from a file rather than a pipe: capturing a child's piped stdout
 * hangs in this environment even when the child finishes in under a second.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function runProbe(probeName, payload) {
    const outFile = path.join(os.tmpdir(), 'arch-probe-' + process.pid + '-' + Date.now() + '.json');
    const probe = path.join(__dirname, probeName);
    try {
        execFileSync(process.execPath, [probe, outFile].concat(payload || []), {
            timeout: 60000,
            stdio: ['ignore', 'ignore', 'inherit']   // never pipe: pipes hang here
        });
        return JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } finally {
        try { fs.rmSync(outFile, { force: true }); } catch (err) { /* best effort */ }
    }
}

module.exports = { runProbe };
