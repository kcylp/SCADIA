/**
 * A lost realtime update must reach the OPERATOR, not just the log (N-42, closing the last mile of N-27).
 *
 * N-27 gave the server a way to say "no client accepted this device's update" (batch 48). A frame
 * nobody listens to is still a silent failure, which is the defect class this project keeps paying
 * for: the value on screen simply stops moving, and a frozen number is indistinguishable from a
 * steady one. This guard pins the things that have to agree before the operator is actually told:
 *
 *   1. the CLIENT listens to the server event, spelled from the enumeration on both sides;
 *   2. the message is composed with instant(), not with a subscription that outlives the callback
 *      (batch 36: subscribing inside a callback left the operator-facing text empty);
 *   3. the translation key exists in EVERY shipped language WITH its placeholder (i18nCoverage
 *      covers completeness - this checks the key the code actually asks for);
 *   4. the toast is throttled: the server emits one frame per device per lost update, and a lost
 *      update repeats every poll cycle - unthrottled it would bury the alarm list.
 *
 * It is written as source inspection, like the other UI guards (R1/R5): the handler lives in an
 * Angular service that this test tree cannot instantiate, and the "does the wire name match" half
 * can only be answered by reading both enumerations anyway.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const HMI_SERVICE = path.join(CLIENT_SRC, 'app', '_services', 'hmi.service.ts');
const I18N_DIR = path.join(CLIENT_SRC, 'assets', 'i18n');
const SERVER_EVENTS = path.join(SERVER_ROOT, 'runtime', 'events.js');

/**
 * The handler body of one socket listener, by brace depth.
 *
 * A plain indexOf('});') stops at the FIRST nested close - this handler has an if, an inner call
 * and an object literal inside it - and a body cut in half silently makes the assertions below
 * meaningless (measured: the "does it toast" check failed against a truncated body rather than
 * against the code). Counting depth is the difference between a guard and a coin flip.
 */
function handlerBody(source, marker) {
    const at = source.indexOf(marker);
    if (at === -1) { return ''; }
    // The BODY opens after the parameter list, past any braces INSIDE it (a typed parameter or an
    // object argument has its own), so the search is bounded to the marker's own line.
    const lineEnd = source.indexOf('\n', at);
    const window = source.slice(at, lineEnd === -1 ? at + 400 : lineEnd);
    let parenDepth = 0;
    let open = -1;
    for (let i = 0; i < window.length; i++) {
        if (window[i] === '(') { parenDepth++; }
        else if (window[i] === ')') { parenDepth--; }
        else if (window[i] === '{' && parenDepth === 0) { open = at + i; break; }
    }
    if (open === -1) { return ''; }
    let braceDepth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') { braceDepth++; }
        else if (source[i] === '}') {
            braceDepth--;
            if (braceDepth === 0) { return source.slice(open, i + 1); }
        }
    }
    return '';
}

const KEY = 'msg.device-values-lost';
const DAQ_KEY = 'msg.daq-query-error';
const MEMBER = 'DEVICE_VALUES_ERROR';
const WIRE = 'device-values-error';

describe('a lost realtime update reaches the operator (N-42)', () => {
    const source = fs.readFileSync(HMI_SERVICE, 'utf8');

    it('the client listens to the event the server emits', function () {
        expect(source, 'the client never listens to ' + WIRE + ', so the frame is still silent')
            .to.contain('IoEventTypes.' + MEMBER);
    });

    it('both enumerations spell the wire name the same way', function () {
        // Either quote style is fine - the point is the STRING VALUE, not the quoting.
        const quoted = (sep) => new RegExp(MEMBER + "\\s*" + sep + "\\s*['\"]" + WIRE + "['\"]");
        const server = fs.readFileSync(SERVER_EVENTS, 'utf8');
        expect(server, 'runtime/events.js lost ' + MEMBER + ' - the client would listen forever')
            .to.match(quoted(':'));
        expect(source, 'hmi.service.ts spells it differently')
            .to.match(quoted('='));
    });

    it('the operator-facing message is composed with instant(), not with a subscription', function () {
        // The batch 36 defect class: get()/subscribe() inside a socket callback resolves later, or
        // never before the language pack is loaded, and renders the raw key to the operator.
        const body = handlerBody(source, 'IoEventTypes.' + MEMBER);
        expect(body.length, 'the handler body could not be extracted').to.be.greaterThan(0);
        expect(body, 'the lost-update handler does not use instant()')
            .to.contain(".instant('" + KEY + "'");
        expect(body, 'subscribing inside the handler is the batch 36 defect')
            .to.not.match(/translateService\.get\(|\.subscribe\(/);
    });

    it('every operator-facing message key exists in every shipped language', function () {
        const languages = fs.readdirSync(I18N_DIR).filter((f) => f.endsWith('.json'));
        expect(languages.length, 'no language files found').to.be.greaterThan(1);
        // DAQ_KEY joined this list in batch 54: the daq-error frame got a consumer, and a consumer
        // with a missing key shows the operator a raw string like "msg.daq-query-error".
        const missing = [];
        languages.forEach((file) => {
            const table = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
            [KEY, DAQ_KEY].forEach((key) => {
                const value = table[key];
                if (typeof value !== 'string' || !value.trim()) { missing.push(file + ' (' + key + ' absent)'); return; }
                if (key === KEY && !value.includes('{{value}}')) { missing.push(file + ' (' + key + ' lost its placeholder)'); }
            });
        });
        expect(missing, 'the operator is shown a raw key in: ' + missing.join(', ')).to.deep.equal([]);
    });

    it('the toast is throttled per device, and the decision is made BEFORE the toast', function () {
        // Scoped to the handler on purpose: DEVICE_STATUS shows a toast too, and its own
        // 'this.toastr.error(msg' sits far earlier in the file, so a whole-file indexOf would
        // compare positions in two different handlers and pass or fail for the wrong reason.
        const body = handlerBody(source, 'IoEventTypes.' + MEMBER);
        const guard = body.indexOf('shouldNotifyLostUpdate(this.lastLostUpdateNotify');
        const notifyCall = body.indexOf('this.toastr.error(msg');
        expect(guard, 'the lost-update toast is not throttled at all').to.be.greaterThan(0);
        expect(notifyCall, 'the handler never shows a toast').to.be.greaterThan(0);
        expect(guard, 'the throttle decision must come BEFORE the toast is shown').to.be.lessThan(notifyCall);
    });
});
describe('the data plane has an indicator that stays lit (N-42)', () => {
    const source = fs.readFileSync(HMI_SERVICE, 'utf8');
    const homeTs = fs.readFileSync(path.join(CLIENT_SRC, 'app', 'home', 'home.component.ts'), 'utf8');
    const homeHtml = fs.readFileSync(path.join(CLIENT_SRC, 'app', 'home', 'home.component.html'), 'utf8');

    it('the daq-error frame finally has a consumer', function () {
        // The server has emitted 'daq-error' for a long time and NOTHING listened, so a failed
        // history query was indistinguishable from a slow one (measured: zero .on( call sites in
        // client/src before this batch).
        expect(source, 'nothing consumes DAQ_ERROR, so a failed query is still invisible')
            .to.contain('IoEventTypes.DAQ_ERROR');
        const body = handlerBody(source, 'IoEventTypes.DAQ_ERROR');
        expect(body.length, 'the handler body could not be extracted').to.be.greaterThan(0);
        expect(body, 'the daq failure must reach the view layer').to.contain('onDataPlaneError');
    });

    it('both frames feed ONE indicator, and it is rendered in the shell', function () {
        expect(source, 'DEVICE_VALUES_ERROR no longer feeds the indicator').to.contain('onDataPlaneError');
        expect(homeTs, 'the home component does not subscribe to the indicator').to.contain('onDataPlaneError');
        expect(homeHtml, 'the indicator is not rendered anywhere an operator can see it')
            .to.contain('data-plane-button');
        expect(homeHtml, 'the indicator must be dismissible, or it becomes permanent decoration')
            .to.contain('onDataPlaneDismiss');
    });

    it('the operator-facing text is composed in the VIEW, with instant()', function () {
        // The service emits a KIND; the view turns it into words. That split is deliberate: the
        // service has no business knowing the screen's language, and compose-inside-a-subscription
        // is the batch 36 defect class.
        // Scoped to the METHOD DECLARATION, by brace depth: a fixed offset picks up whatever comes
        // next in the file, and the first version of this check caught the subscribe() call two
        // methods below - a false positive of exactly the kind that makes a guard untrustworthy.
        const at = homeTs.indexOf('private setDataPlaneError');
        expect(at, 'setDataPlaneError is gone').to.be.greaterThan(0);
        const body = handlerBody(homeTs.slice(at), 'private setDataPlaneError');
        expect(body.length, 'the method body could not be extracted').to.be.greaterThan(0);
        expect(body, 'the message is not composed with instant()').to.contain('.instant(');
        expect(body, 'the view must not subscribe for this text (batch 36 defect class)')
            .to.not.match(/translateService\.get\(|\.subscribe\(/);
        // The rule is about THIS indicator, not about the service as a whole: the service composes
        // the lost-update TOAST itself (batch 49, same instant() reasoning), so a whole-file
        // assertion would have been a false accusation. Scoped to the frame under discussion.
        const daqBody = handlerBody(source, 'IoEventTypes.DAQ_ERROR');
        expect(daqBody, 'the service translates the daq indicator itself instead of emitting a kind')
            .to.not.contain("instant('msg.");
    });
});
