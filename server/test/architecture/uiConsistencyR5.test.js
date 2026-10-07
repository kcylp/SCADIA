/**
 * R5 from the UI standard: confirm with the project's dialog, notify with its toast, never with the
 * browser's own alert/confirm.
 *
 * WHY THIS IS A GATE AND NOT TASTE
 *
 * `alert()` and `window.confirm()` are blocking, unthemed, untranslatable through the app's own
 * pipeline, and - the part that actually bites - silently SUPPRESSED by browsers when the page runs
 * inside a sandboxed or cross-origin iframe. A SCADA screen is routinely embedded exactly that way,
 * so a confirmation written with `window.confirm` can return false forever and the action simply
 * never happens, with nothing in any log.
 *
 * The three sites this closed were all in the same FileReader error path, each with the app's i18n
 * line sitting COMMENTED OUT directly above the alert - the translation existed in all three
 * languages and the code had been left one refactor short.
 *
 * WHAT IS ALLOWED, and why the rule is not "no window.*":
 *
 *   - the project's own files. `client/src/assets/lib/**` is vendored (jQuery, svg-edit and its
 *     extensions) and calls alert() inside its own error reporting. Rewriting a vendor bundle is
 *     how a library update becomes impossible.
 *   - files marked "branding-guard:allow"-style escapes is NOT offered here on purpose: an escape
 *     hatch that switches the rule off for a whole file is how the next violation hides inside it.
 *
 * Every remaining occurrence must be one of the two cases above, or it fails.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const APP_DIR = path.join(CLIENT_SRC, 'app');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', 'i18n-parked']);

/** The client's own code: everything under client/src/app. */
function appFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) { out.push(full); }
        }
    };
    walk(APP_DIR);
    return out.sort();
}

/** Code lines only: a comment explaining the old alert() is documentation, not a violation. */
function codeLines(file) {
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((text, index) => ({ text: text, number: index + 1 }))
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text));
}

const rel = (file) => path.relative(CLIENT_SRC, file).split(path.sep).join('/');

describe('UI consistency R5 (a confirmation the browser suppresses is an action that never happens)', () => {
    const files = appFiles();

    it('the client app tree was found', function () {
        expect(files.length, 'no .ts files under ' + APP_DIR).to.be.greaterThan(100);
    });

    it('no alert() in the client app', function () {
        const offenders = [];
        files.forEach((file) => {
            codeLines(file).forEach((line) => {
                if (/(^|[^.\w])alert\s*\(/.test(line.text) && !/window\.alert\s*=/.test(line.text)) {
                    offenders.push(rel(file) + ':' + line.number + '  ' + line.text.trim());
                }
            });
        });
        expect(offenders, 'use ToastNotifierService.notifyError(key, detail) or a MatDialog instead - ' +
            'alert() is suppressed inside an iframe, which is where SCADA screens live:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('no window.confirm() / bare confirm() in the client app', function () {
        const offenders = [];
        files.forEach((file) => {
            codeLines(file).forEach((line) => {
                // a method DECLARATION named confirm( is not the browser dialog
                if (/^\s*(public |private |protected )?(async )?confirm\s*\(/.test(line.text)) { return; }
                if (/\bwindow\.confirm\s*\(/.test(line.text) || /(^|[^.\w])confirm\s*\(/.test(line.text)) {
                    offenders.push(rel(file) + ':' + line.number + '  ' + line.text.trim());
                }
            });
        });
        expect(offenders, 'use MatDialog with ConfirmDialogComponent (gui-helpers/confirm-dialog) - ' +
            'window.confirm() is blocking, unthemed, and refused in a sandboxed iframe:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('the project actually provides the two channels this rule points at', function () {
        // If either helper is ever deleted, this guard's advice becomes a dead end - so check the
        // helpers exist rather than trusting the message.
        expect(fs.existsSync(path.join(APP_DIR, 'gui-helpers', 'confirm-dialog', 'confirm-dialog.component.ts')),
            'ConfirmDialogComponent is gone - R5 has nowhere to point').to.equal(true);
        expect(fs.existsSync(path.join(APP_DIR, '_services', 'toast-notifier.service.ts')),
            'ToastNotifierService is gone - R5 has nowhere to point').to.equal(true);
    });
});
