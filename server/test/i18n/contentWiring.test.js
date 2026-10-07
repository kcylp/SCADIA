'use strict';

/**
 * Regression fence around the content-translation mechanism.
 *
 * The behaviour is verified end to end in a browser (switch language, read the drawing), but
 * nothing in a unit test suite would notice if a later refactor quietly removed one of the
 * pieces below. Each assertion names the failure it prevents.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const app = (...parts) => path.join(CLIENT_SRC, 'app', ...parts);
const read = (...parts) => fs.readFileSync(app(...parts), 'utf8');

describe('content translation wiring', () => {

    it('the language service resolves literals, not just @keys', () => {
        const service = read('_services', 'language.service.ts');
        // A project is authored in Chinese, so drawings carry literal text. Without the
        // literal path the dictionary is never consulted and every label stays Chinese.
        expect(service).to.contain('valueIndex');
        expect(service).to.contain('resolveSeed');
        expect(service).to.contain('CONTENT_MASTER_LANGUAGE');
    });

    it('one switch drives both the chrome and the content', () => {
        const service = read('_services', 'language.service.ts');
        // Two independent switches is how you get English menus over a Chinese drawing.
        expect(service).to.contain('this.translateService.use(id)');
        expect(service).to.contain('applyLanguage');
        expect(service).to.contain('normalizeAppLanguage');
    });

    it('a drawing is re-translated when the language changes', () => {
        const view = read('scadia-view', 'scadia-view.component.ts');
        expect(view).to.contain('applyContentDictionary');
        // Subscribing is what makes an already-open drawing follow the switch.
        expect(view).to.contain('languageConfig$.subscribe');
        // The guards that keep live process values safe and switching lossless.
        expect(view).to.contain('__scadiaSourceText');
        expect(view).to.contain('variableId');
    });

    it('alarm history translates the group as well as the text', () => {
        const alarmView = read('alarms', 'alarm-view', 'alarm-view.component.ts');
        const historyBlock = alarmView.slice(alarmView.indexOf('onShowAlarmsHistory'));
        expect(historyBlock).to.contain('getTranslation(alr.group)');
    });

    it('alarm status and priority are resolved on demand, never cached into the enums', () => {
        const alarmView = read('alarms', 'alarm-view', 'alarm-view.component.ts');
        // Caching them in place left every other alarm view - and the same view after a
        // language switch - showing the previous language.
        expect(alarmView).to.not.match(/statusText\[key\]\s*=\s*txt/);
        expect(alarmView).to.contain('instant(key)');
    });

    it('timestamps follow the language', () => {
        const alarmView = read('alarms', 'alarm-view', 'alarm-view.component.ts');
        const template = read('alarms', 'alarm-view', 'alarm-view.component.html');
        expect(alarmView).to.contain('localeFormat().dateTime');
        // A hard-coded pattern in the template exports the master's convention to everyone.
        expect(template).to.not.contain("'yyyy.MM.dd HH:mm:ss'");
        expect(template).to.contain('dateTimePattern');
    });

    it('the reusable pipe exists, is declared, and has a bounded memo', () => {
        const pipe = read('_helpers', 'content-text.pipe.ts');
        expect(pipe).to.contain("name: 'contentText'");
        expect(pipe).to.contain('languageService.getTranslation');
        expect(pipe).to.contain('MAX_CACHE');
        expect(read('app.module.ts')).to.contain('ContentTextPipe');
    });
});
