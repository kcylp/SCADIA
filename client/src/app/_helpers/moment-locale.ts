/**
 * Dates and month names must be Chinese too (batch 81).
 *
 * WHY THIS IS A SEPARATE MODULE, IMPORTED FIRST. daterangepicker.config.ts builds its
 * DefaultLocaleConfig at MODULE level - it calls moment.weekdaysMin() and moment.monthsShort()
 * while the module is being evaluated. A statement such as moment.locale('zh-cn') placed in main.ts
 * runs only after the whole import graph has been evaluated, which is too late: the calendar would
 * have captured the English names already. An import has no such problem, so main.ts imports this
 * file before AppModule and the locale is in place by the time the calendar reads it.
 *
 * MEASURED BEFORE THIS FIX: the client never called moment.locale() anywhere and never imported a
 * locale bundle, so weekday headers were Sun/Mon/... and month names Jan/Feb/... in every language.
 */
import * as moment from 'moment';
import 'moment/locale/zh-cn';

moment.locale('zh-cn');
