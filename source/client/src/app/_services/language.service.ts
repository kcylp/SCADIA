import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subscription } from 'rxjs';

import { ProjectService } from './project.service';
import { SettingsService } from './settings.service';
import { AuthService } from './auth.service';
import { Language, LANGUAGE_TEXT_KEY_PREFIX, Languages, LanguageText } from '../_models/language';
import { SHIPPED_APP_LANGUAGES, SHIPPED_APP_LANGUAGE_NAMES, SHIPPED_LOCALE_FORMATS, LocaleFormat, normalizeAppLanguage } from '../_models/settings';
import { CONTENT_MASTER_LANGUAGE, CONTENT_SEED, ContentSeedEntry } from '../_helpers/content-seed';
import { UserInfo } from '../users/user-edit/user-edit.component';

/**
 * The single language switch for the whole product.
 *
 * Two things have to agree at all times:
 *  - the interface chrome (buttons, menus, dialogs), translated by ngx-translate from
 *    assets/i18n/<language>.json;
 *  - the project content (words inside drawings, alarm texts, reports, notifications),
 *    resolved here by LanguageService against the project's language-text library and the
 *    built-in content dictionary.
 *
 * If they were allowed to diverge an operator would get English menus over a Chinese
 * drawing, which is exactly the failure this class exists to prevent. Everything therefore
 * funnels through applyLanguage(): the app setting is the default, a per-user choice
 * overrides it, and both are clamped onto the languages this build actually ships.
 */
@Injectable({
    providedIn: 'root'
})
export class LanguageService {
    localStorageItem = 'currentLanguage';
    languages: Languages;
    languageConfig: LanguageConfiguration;
    languageConfig$ = new BehaviorSubject<LanguageConfiguration>(null);
    texts: { [id: string]: LanguageText } = {};

    /**
     * Source text -> language-text entry, for drawings that carry the master language
     * literally instead of an @key. Rebuilt whenever the project loads.
     */
    private valueIndex = new Map<string, LanguageText>();

    /** Built-in dictionary, available synchronously before any project is loaded. */
    private static seedIndex = new Map<string, ContentSeedEntry>(CONTENT_SEED.map(entry => [entry.source, entry]));

    private settingsSubscription: Subscription;

    constructor(
        public projectService: ProjectService,
        private settingsService: SettingsService,
        private authService: AuthService,
        private translateService: TranslateService
    ) {
        // The app setting is the deployment default. It arrives asynchronously, so the
        // language is (re)applied whenever it changes and ignored once a user chose one.
        this.settingsSubscription = this.settingsService.settings$.subscribe(settings => {
            if (this.hasUserChoice()) {
                return;
            }
            this.applyLanguage(normalizeAppLanguage(settings?.language, CONTENT_MASTER_LANGUAGE));
        });

        this.projectService.onLoadHmi.subscribe(() => {
            this.languages = this.buildLanguages();
            this.texts = this.projectService.getTexts().reduce((acc, text) => {
                acc[text.name] = text;
                return acc;
            }, {} as { [id: string]: LanguageText });
            // Same entries indexed by their master-language text, so a literal in a drawing
            // can be resolved without the author having to introduce an @key for it.
            this.valueIndex = new Map<string, LanguageText>();
            for (const text of Object.values(this.texts)) {
                if (text?.value) {
                    this.valueIndex.set(text.value, text);
                }
            }
            // A language already chosen must survive the project load, so re-apply it.
            this.applyLanguage(this.currentLanguageId());
        });
    }

    /** Languages offered at runtime: exactly the ones whose translation files are shipped. */
    private buildLanguages(): Languages {
        const all: Language[] = SHIPPED_APP_LANGUAGES.map(id => ({ id, name: SHIPPED_APP_LANGUAGE_NAMES[id] || id }));
        const master = all.find(l => l.id === CONTENT_MASTER_LANGUAGE) || all[0];
        return { default: master, options: all.filter(l => l.id !== master.id) };
    }

    private hasUserChoice(): boolean {
        return !!this.getStorageLanguage();
    }

    /** Make this language current everywhere: chrome and content. */
    applyLanguage(languageId: string): void {
        const id = normalizeAppLanguage(languageId, CONTENT_MASTER_LANGUAGE);
        if (this.languageConfig?.currentLanguage?.id === id) {
            return;
        }
        if (!this.languages) {
            this.languages = this.buildLanguages();
        }
        const known = [this.languages.default, ...(this.languages.options || [])].find(l => l?.id === id);
        const language: Language = known || { id, name: SHIPPED_APP_LANGUAGE_NAMES[id] || id };
        this.languageConfig = { ...this.languages, currentLanguage: language };
        // The chrome must speak the same language as the content.
        this.translateService.use(id);
        this.languageConfig$.next(this.languageConfig);
    }

    setCurrentLanguage(lang: Language): void {
        if (!lang) {
            return;
        }
        const username = this.authService.getUser()?.username || '';
        localStorage.setItem(`${this.localStorageItem}-${username}`, JSON.stringify(lang));
        this.applyLanguage(lang.id);
    }

    private getStorageLanguage(): Language {
        const username = this.authService.getUser()?.username || '';
        try {
            const stored = JSON.parse(localStorage.getItem(`${this.localStorageItem}-${username}`));
            if (stored?.id && SHIPPED_APP_LANGUAGES.indexOf(stored.id) !== -1) {
                return stored;
            }
        } catch (err) {
            // A corrupt entry must not break the boot; fall through to the app setting.
        }
        return null;
    }

    currentLanguageId(): string {
        if (this.languageConfig?.currentLanguage?.id) {
            return this.languageConfig.currentLanguage.id;
        }
        const userChoice = this.getStorageLanguage();
        if (userChoice) {
            return userChoice.id;
        }
        return normalizeAppLanguage(this.settingsService.getSettings()?.language, CONTENT_MASTER_LANGUAGE);
    }

    /**
     * Resolve user-visible text into the current language. Returns null when the caller
     * should keep what it already has.
     *
     * Two shapes are supported, in this order:
     *  1. an explicit @key - the author opted into a named entry in the project's
     *     language-text library, and can override a built-in translation per project;
     *  2. a literal in the master language - the drawing simply contains "报警时间：". This
     *     is the normal case: a project is authored in Chinese and the dictionary supplies
     *     the other languages, so 55 labels do not have to become 55 @keys.
     *
     * The master language resolves to null on purpose: the drawing is already correct and
     * substituting it would only risk changing what the author wrote.
     */
    getTranslation(textKey: string): string {
        if (!textKey) {
            return null;
        }
        if (textKey.startsWith(LANGUAGE_TEXT_KEY_PREFIX)) {
            return this.resolveText(this.texts[textKey.substring(1)]);
        }
        const projectText = this.valueIndex.get(textKey);
        if (projectText) {
            return this.resolveText(projectText);
        }
        return this.resolveSeed(textKey);
    }

    /**
     * Date, time and number conventions of the current language, so a template never has to
     * hard-code a format. Falls back to the master's conventions for an unknown language.
     */
    localeFormat(): LocaleFormat {
        return SHIPPED_LOCALE_FORMATS[this.currentLanguageId()] || SHIPPED_LOCALE_FORMATS[CONTENT_MASTER_LANGUAGE];
    }

    /** True when the given literal has a translation for a language other than the master. */
    hasContentTranslation(source: string): boolean {
        if (!source) {
            return false;
        }
        if (this.valueIndex.has(source)) {
            return true;
        }
        const entry = LanguageService.seedIndex.get(source);
        return !!entry && !!entry.translations[this.currentLanguageId()];
    }

    private resolveText(text: LanguageText): string {
        if (!text) {
            return null;
        }
        const languageId = this.currentLanguageId();
        if (languageId && text.translations?.[languageId]) {
            return text.translations[languageId];
        }
        return text.value || null;
    }

    private resolveSeed(source: string): string {
        const entry = LanguageService.seedIndex.get(source);
        if (!entry) {
            return null;
        }
        const languageId = this.currentLanguageId();
        if (!languageId || languageId === CONTENT_MASTER_LANGUAGE) {
            return null;
        }
        return entry.translations[languageId] || null;
    }

    getLanguage(id: string) {
        if (this.languages?.default?.id === id) {
            return this.languages.default;
        }
        return this.languages?.options?.find(lang => lang.id === id);
    }
}

export interface LanguageConfiguration extends Languages {
    currentLanguage: Language;
}
