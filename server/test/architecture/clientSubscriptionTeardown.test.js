/**
 * A component that listens to a service event must tear the subscription down (N-12).
 *
 * WHAT N-12 WAS. The last piece of it is the subscriptions that are legal but never auto-cancel, and
 * that the codebase writes in several idioms at once. Batch 71 measured the whole client:
 *
 *   - 75 subscriptions whose source is a service EVENT FIELD (.onXxx, as opposed to a method call or an
 *     HTTP request, which completes by itself);
 *   - 20 of them cancel through an inline takeUntil / untilDestroyed;
 *   - of the remaining 55, six files are @Injectable SERVICES, where a subscription that lives as long
 *     as the application is the correct thing;
 *   - and EVERY component one is torn down - 31 by unsubscribing a stored field in ngOnDestroy, 9
 *     through a helper (html-recipe's _unsubscribeProgress) or a bracket-accessed field
 *     (scadia-view's subscriptionOnGaugeEvent).
 *
 * So there is no leak to fix, and the "several idioms" part is a design change (moving to
 * takeUntilDestroyed changes semantics for every one of them) rather than a bug hunt.
 *
 * WHAT THIS GUARD IS FOR, THEN. Not the inventory - the DOOR. A new component that listens to a
 * service event and never tears it down is the regression this item worries about, and nothing else in
 * the gate would notice: the callback runs against a destroyed component, once per navigation.
 *
 * The rule is deliberately FILE-LEVEL and accepts any of the idioms in use, because a per-subscription
 * regex produced three false positives out of nine when it was tried (a helper method, a bracket-accessed
 * field, and a field torn down by a method the regex never looked into). Being approximately right about
 * a missing teardown is worth less than being exactly right about "this component never tears anything
 * down at all".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_APP = path.join(SERVER_ROOT, '..', 'client', 'src', 'app');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', '.git', 'coverage', 'i18n-parked']);

/** A subscription whose source is a service EVENT FIELD: .onXxx.subscribe(, optionally through pipe. */
const EMITTER_SUBSCRIPTION = /\.on[A-Z]\w*\s*(?:\.pipe\s*\((?:[^()]|\([^()]*\)){0,300}\))?\s*\.subscribe\s*\(/;

/** The idioms this codebase tears subscriptions down with. Any one of them satisfies the rule. */
const TEARDOWN = [/takeUntil\s*\(/, /untilDestroyed\s*\(/, /ngOnDestroy\s*\(/, /subscription\s*\.\s*add\s*\(/];

function clientTsFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
                out.push(full);
            }
        }
    };
    walk(CLIENT_APP);
    return out.sort();
}

const rel = (file) => path.relative(CLIENT_APP, file).split(path.sep).join('/');

describe('a component that listens to a service event tears the subscription down', () => {
    const files = clientTsFiles();

    /** Components only: a service lives as long as the application and cancels nothing by design. */
    const subscribingComponents = files.filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return /@Component\s*\(/.test(text) && EMITTER_SUBSCRIPTION.test(text);
    });

    it('the scan really scanned something', function () {
        expect(files.length, 'the client walk found no TypeScript files - check CLIENT_APP: ' + CLIENT_APP)
            .to.be.greaterThan(100);
        expect(subscribingComponents.length,
            'no component subscribes to a service event - that cannot be true, and a guard that scans ' +
            'nothing reports a clean tree').to.be.greaterThan(10);
    });

    it('every subscribing component declares how it unsubscribes', function () {
        const offenders = subscribingComponents
            .filter((file) => {
                const text = fs.readFileSync(file, 'utf8');
                return !TEARDOWN.some((idiom) => idiom.test(text));
            })
            .map(rel);
        expect(offenders, 'these components listen to a service event and never tear it down - the ' +
            'callback then runs against a destroyed component, once per navigation:\n' + offenders.join('\n'))
            .to.deep.equal([]);
    });

    it('services are exempt by construction, not by exemption list', function () {
        // The rule keys on @Component, so this is a statement about the rule rather than a list to
        // maintain: api services (hmi, language, script) subscribe for the life of the application.
        const services = files.filter((file) => {
            const text = fs.readFileSync(file, 'utf8');
            return /@Injectable\s*\(/.test(text) && !/@Component\s*\(/.test(text) && EMITTER_SUBSCRIPTION.test(text);
        });
        expect(services.length, 'the service half of the measurement vanished - re-measure before trusting ' +
            'the component half').to.be.greaterThan(2);
    });
});
