import { Injectable } from '@angular/core';
import { TranslateDefaultParser } from '@ngx-translate/core';

/**
 * Translation lookup that understands BOTH shapes used by assets/i18n/*.json.
 *
 * The language files are a mix of flat dotted keys ("dlg.cancel": "取消") and nested
 * objects ("dlg": { ... }). The stock ngx-translate parser only walks the path, so the
 * moment a namespace exists as an object every flat key underneath it becomes
 * unreachable: 'dlg.cancel' resolved to { dlg: { ... } }.cancel, found nothing, and the
 * raw key was rendered to the user. That is why the setup dialog, the login dialog and
 * parts of the alarm table showed strings like "dlg.setup-title" instead of "设置".
 *
 * This parser tries the literal key first (the flat form) and only then falls back to the
 * stock path walk (the nested form). It is strictly additive: the two shapes do not
 * overlap anywhere in the current files, so no key that resolves today resolves
 * differently - only the broken ones start working.
 */
@Injectable()
export class FlatTranslateParser extends TranslateDefaultParser {

    getValue(target: any, key: string): any {
        if (target && typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key)) {
            const direct = target[key];
            if (direct !== undefined && direct !== null) {
                return direct;
            }
        }
        return super.getValue(target, key);
    }
}
