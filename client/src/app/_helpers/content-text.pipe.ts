import { Pipe, PipeTransform } from '@angular/core';

import { LanguageService } from '../_services/language.service';

/**
 * Render project content in the current language.
 *
 * A project is authored in Simplified Chinese, so a name in a list, an alarm text or a chart
 * title is master-language content rather than a translation key. Wrapping it in this pipe
 * is all a template has to do:
 *
 *   {{ element.text | contentText }}
 *
 * It exists so that covering a new module is mechanical instead of a hunt: grepping a
 * template for "| contentText" tells you exactly what is still showing Chinese to an English
 * or Russian operator. test/i18n/templateContentGuard.test.js enforces that on the runtime
 * templates.
 *
 * Impure on purpose - the value has to be re-resolved when the operator switches language -
 * with a small memo so an alarm table refreshing every two seconds does not re-resolve every
 * cell on every change detection pass.
 */
@Pipe({
    name: 'contentText',
    pure: false
})
export class ContentTextPipe implements PipeTransform {

    private static readonly MAX_CACHE = 2000;
    private cache = new Map<string, { languageId: string; result: string }>();

    constructor(private languageService: LanguageService) {
    }

    transform(value: string): string {
        if (!value || typeof value !== 'string') {
            return value;
        }
        const languageId = this.languageService.currentLanguageId();
        const cached = this.cache.get(value);
        if (cached && cached.languageId === languageId) {
            return cached.result;
        }
        const result = this.languageService.getTranslation(value) ?? value;
        if (this.cache.size >= ContentTextPipe.MAX_CACHE) {
            this.cache.clear();
        }
        this.cache.set(value, { languageId, result });
        return result;
    }
}
