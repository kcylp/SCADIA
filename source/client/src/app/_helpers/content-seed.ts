import { LanguageText } from '../_models/language';

/**
 * Seed content dictionary: the master (Simplified Chinese) text an operator reads in a
 * drawing, mapped to the languages this build ships.
 *
 * Projects are authored in Chinese. Rather than rewriting every <text> node into an @key -
 * which would mean editing 55 labels in this project alone and every new one forever -
 * the renderer looks a literal up by its source text. This file is the built-in seed so a
 * project works in English and Russian out of the box; a project's own language-text
 * library overrides it entry by entry, and new strings can be added there without a build.
 *
 * Kept as a module rather than a fetched asset on purpose: it must be available
 * synchronously on the first render, before any view is painted.
 *
 * Guarded by test/i18n/i18nCoverage.test.js: every entry must carry all shipped languages.
 */
/** Language the drawings are authored in. Never substituted - it is already on screen. */
export const CONTENT_MASTER_LANGUAGE = 'zh-cn';

export interface ContentSeedEntry {
    /** Text exactly as it appears in the drawing (master language). */
    source: string;
    /** Translation per shipped language code, keyed the same way as SHIPPED_APP_LANGUAGES. */
    translations: { [languageId: string]: string };
    /** Free-text note for whoever maintains the dictionary. */
    note?: string;
}

export const CONTENT_SEED: ContentSeedEntry[] = [
    { source: "AI检测", translations: { 'en': "AI Detection", 'ru': "ИИ-обнаружение" } },
    { source: "报警时间：", translations: { 'en': "Alarm time: ", 'ru': "Время тревоги: " } },
    { source: "报警通道：", translations: { 'en': "Alarm channel: ", 'ru': "Канал тревоги: " } },
    { source: "报警类型：", translations: { 'en': "Alarm type: ", 'ru': "Тип тревоги: " } },
    { source: "报警描述：", translations: { 'en': "Alarm description: ", 'ru': "Описание тревоги: " } },
    { source: "数据展示界面", translations: { 'en': "Data Dashboard", 'ru': "Панель данных" } },
    { source: "全矿异物报警统计", translations: { 'en': "Mine-wide Foreign Object Alarms", 'ru': "Тревоги по посторонним предметам (шахта)" } },
    { source: "全矿跑偏报警统计", translations: { 'en': "Mine-wide Belt Deviation Alarms", 'ru': "Тревоги по сходу конвейерной ленты (шахта)" } },
    { source: "全矿堆煤报警统计", translations: { 'en': "Mine-wide Coal Pile-up Alarms", 'ru': "Тревоги по завалу угля (шахта)" } },
    { source: "年", translations: { 'en': "Year", 'ru': "Год" } },
    { source: "月", translations: { 'en': "Month", 'ru': "Месяц" } },
    { source: "日", translations: { 'en': "Day", 'ru': "День" } },
    { source: "次", translations: { 'en': "times", 'ru': "раз" } },
    { source: "分类1", translations: { 'en': "Category 1", 'ru': "Категория 1" } },
    { source: "煤流检测1", translations: { 'en': "Coal Flow Detection 1", 'ru': "Контроль потока угля 1" } },
    { source: "煤流检测2", translations: { 'en': "Coal Flow Detection 2", 'ru': "Контроль потока угля 2" } },
    { source: "皮带一", translations: { 'en': "Belt 1", 'ru': "Конвейер 1" } },
    { source: "皮带二", translations: { 'en': "Belt 2", 'ru': "Конвейер 2" } },
    { source: "皮带三", translations: { 'en': "Belt 3", 'ru': "Конвейер 3" } },
    { source: "皮带四", translations: { 'en': "Belt 4", 'ru': "Конвейер 4" } },
    { source: "皮带1", translations: { 'en': "Belt 1", 'ru': "Конвейер 1" } },
    { source: "皮带2", translations: { 'en': "Belt 2", 'ru': "Конвейер 2" } },
    { source: "皮带3", translations: { 'en': "Belt 3", 'ru': "Конвейер 3" } },
    { source: "皮带4", translations: { 'en': "Belt 4", 'ru': "Конвейер 4" } },
    { source: "皮带5", translations: { 'en': "Belt 5", 'ru': "Конвейер 5" } },
    { source: "皮带6", translations: { 'en': "Belt 6", 'ru': "Конвейер 6" } },
    { source: "皮带7", translations: { 'en': "Belt 7", 'ru': "Конвейер 7" } },
    { source: "皮带8", translations: { 'en': "Belt 8", 'ru': "Конвейер 8" } },
    { source: "区域入侵监测统计", translations: { 'en': "Area Intrusion Monitoring", 'ru': "Контроль проникновения в зону" } },
    { source: "行人管理检测统计", translations: { 'en': "Personnel Detection Statistics", 'ru': "Статистика обнаружения людей" } },
    { source: "其他监测统计", translations: { 'en': "Other Monitoring Statistics", 'ru': "Прочая статистика контроля" } },
    { source: "入侵1", translations: { 'en': "Intrusion 1", 'ru': "Проникновение 1" } },
    { source: "入侵2", translations: { 'en': "Intrusion 2", 'ru': "Проникновение 2" } },
    { source: "入侵3", translations: { 'en': "Intrusion 3", 'ru': "Проникновение 3" } },
    { source: "入侵4", translations: { 'en': "Intrusion 4", 'ru': "Проникновение 4" } },
    { source: "区域切换", translations: { 'en': "Area Switch", 'ru': "Переключение зон" } },
    { source: "服务项目增长", translations: { 'en': "Service Item Growth", 'ru': "Рост сервисных показателей" } },
    { source: "趋势图（2022.01-2022.10）", translations: { 'en': "Trend (2022.01-2022.10)", 'ru': "Тренд (2022.01-2022.10)" } },
    { source: "顶部标题栏", translations: { 'en': "Top Title Bar", 'ru': "Верхняя строка заголовка" } },
    { source: "AI人工智能服务平台", translations: { 'en': "AI Intelligent Service Platform", 'ru': "Интеллектуальная платформа ИИ" } },
    { source: "视频监控画面", translations: { 'en': "Video Surveillance View", 'ru': "Экран видеонаблюдения" } },
    { source: "报警查询", translations: { 'en': "Alarm Query", 'ru': "Поиск тревог" } },
    { source: "时间", translations: { 'en': "Time", 'ru': "Время" } },
    { source: "用户", translations: { 'en': "User", 'ru': "Пользователь" } },
    { source: "自定义1", translations: { 'en': "Custom 1", 'ru': "Настраиваемый 1" } },
    { source: "自定义2", translations: { 'en': "Custom 2", 'ru': "Настраиваемый 2" } },
    { source: "自定义3", translations: { 'en': "Custom 3", 'ru': "Настраиваемый 3" } },
    { source: "自定义4", translations: { 'en': "Custom 4", 'ru': "Настраиваемый 4" } },
    { source: "报警图片预览", translations: { 'en': "Alarm Image Preview", 'ru': "Просмотр изображения тревоги" } },
    { source: "进入平台", translations: { 'en': "Enter Platform", 'ru': "Вход в платформу" } },
    { source: "左列表", translations: { 'en': "Left List", 'ru': "Левый список" } },
    { source: "登录账号", translations: { 'en': "Sign-in Account", 'ru': "Учётная запись" } },
];

/**
 * Strings that cannot be looked up as literals because a live value is baked into the
 * same text node. They need the drawing changed (static label + separate value element),
 * listed here so the gap is visible instead of silently untranslated.
 */
export const CONTENT_SEED_DYNAMIC_GAPS: Array<{ source: string; note: string }> = [
    { source: "共计     123294830    次", note: "contains a live counter -> split into a static label + a value in the view" },
    { source: "占比20%", note: "contains a live percentage -> split into a label + value" },
    { source: "75%", note: "pure value, nothing to translate" },
];
