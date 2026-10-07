import { GaugeProgressComponent } from './controls/gauge-progress/gauge-progress.component';
import { GaugeSemaphoreComponent } from './controls/gauge-semaphore/gauge-semaphore.component';
import { HtmlBagComponent } from './controls/html-bag/html-bag.component';
import { HtmlButtonComponent } from './controls/html-button/html-button.component';
import { HtmlChartComponent } from './controls/html-chart/html-chart.component';
import { HtmlGraphComponent } from './controls/html-graph/html-graph.component';
import { HtmlIframeComponent } from './controls/html-iframe/html-iframe.component';
import { HtmlImageComponent } from './controls/html-image/html-image.component';
import { HtmlInputComponent } from './controls/html-input/html-input.component';
import { HtmlRecipeComponent, HtmlRecipeViewComponent } from './controls/html-recipe/html-recipe.component';
import { GAUGE_CONTROLS, GaugeCapability } from './gauge-capability';
import { HtmlSchedulerComponent } from './controls/html-scheduler/html-scheduler.component';
import { HtmlSelectComponent } from './controls/html-select/html-select.component';
import { HtmlSwitchComponent } from './controls/html-switch/html-switch.component';
import { HtmlTableComponent } from './controls/html-table/html-table.component';
import { HtmlVideoComponent } from './controls/html-video/html-video.component';
import { PanelComponent } from './controls/panel/panel.component';
import { PipeComponent } from './controls/pipe/pipe.component';
import { SliderComponent } from './controls/slider/slider.component';
import { ValueComponent } from './controls/value/value.component';

/**
 * The capability surface of every gauge control, MEASURED and pinned (batch 68 - N-39 step 1).
 *
 * WHY THIS FILE EXISTS BEFORE ANY REFACTOR. N-39's finding is not duplicated code: it is that the
 * same handful of static members (TypeTag, LabelTag, getSignals, processValue, getDialogType,
 * getActions) is implemented by every control WITHOUT AN INTERFACE. The card adds the precondition -
 * an interface may not be introduced before automation pins what the controls do now. Batch 67 built
 * the runner; this is the pin.
 *
 * WHAT THE MEASUREMENT FOUND (every cell below was printed by a probe run before it was asserted):
 *
 *   - getSignals does not agree on its INPUT. Fifteen controls read `pro.variableId`; the chart and
 *     the graph read `pro.variableIds` (plural) - and answer `undefined`, not `[]`, when handed the
 *     singular shape. The table answers `null` when the settings are not table-shaped.
 *   - Two controls (recipe, scheduler) answer `[]` for every shape tried: their signals come from
 *     somewhere else, which an interface has to be able to express rather than hide.
 *   - HtmlImageComponent has no getDialogType(); HtmlRecipeComponent is exported next to a VIEW class
 *     with no statics at all (HtmlRecipeViewComponent), which is a trap for anybody importing "the
 *     recipe component".
 *
 * The table is deliberately a CHARACTERIZATION, not an aspiration: it says what the code does today.
 * When N-39 gives these members an interface, this file will fail on every control whose behaviour
 * changed, and the author has to say which control and why.
 */

/** [name, class, TypeTag, getSignals({variableId}), getSignals({variableIds})] - measured. */
const CAPABILITIES: Array<[string, any, string, any, any]> = [
    ['GaugeProgressComponent', GaugeProgressComponent, 'svg-ext-gauge_progress', ['t1'], []],
    ['GaugeSemaphoreComponent', GaugeSemaphoreComponent, 'svg-ext-gauge_semaphore', ['t1'], []],
    ['HtmlBagComponent', HtmlBagComponent, 'svg-ext-html_bag', ['t1'], []],
    ['HtmlButtonComponent', HtmlButtonComponent, 'svg-ext-html_button', ['t1'], []],
    ['HtmlChartComponent', HtmlChartComponent, 'svg-ext-html_chart', undefined, ['t1']],
    ['HtmlGraphComponent', HtmlGraphComponent, 'svg-ext-html_graph', undefined, ['t1']],
    ['HtmlIframeComponent', HtmlIframeComponent, 'svg-ext-own_ctrl-iframe', ['t1'], []],
    ['HtmlImageComponent', HtmlImageComponent, 'svg-ext-own_ctrl-image', ['t1'], []],
    ['HtmlInputComponent', HtmlInputComponent, 'svg-ext-html_input', ['t1'], []],
    ['HtmlRecipeComponent', HtmlRecipeComponent, 'svg-ext-own_ctrl-recipe', [], []],
    ['HtmlSchedulerComponent', HtmlSchedulerComponent, 'svg-ext-own_ctrl-scheduler', [], []],
    ['HtmlSelectComponent', HtmlSelectComponent, 'svg-ext-html_select', ['t1'], []],
    ['HtmlSwitchComponent', HtmlSwitchComponent, 'svg-ext-html_switch', ['t1'], []],
    ['HtmlTableComponent', HtmlTableComponent, 'svg-ext-own_ctrl-table', null, null],
    ['HtmlVideoComponent', HtmlVideoComponent, 'svg-ext-own_ctrl-video', ['t1'], []],
    ['PanelComponent', PanelComponent, 'svg-ext-own_ctrl-panel', ['t1'], []],
    ['PipeComponent', PipeComponent, 'svg-ext-pipe', ['t1'], []],
    ['SliderComponent', SliderComponent, 'svg-ext-html_slider', ['t1'], []],
    ['ValueComponent', ValueComponent, 'svg-ext-value', ['t1'], []],
];

const SINGULAR = { variableId: 't1' };
const PLURAL = { variableIds: ['t1'] };

describe('the gauge control capability surface (N-39 step 1: pin today, then change)', () => {
    it('the table covers every control this spec imports', function () {
        expect(CAPABILITIES.length).toBe(19);
    });

    it('the typed registry holds exactly the controls this table measures', function () {
        // GAUGE_CONTROLS is typed by the GaugeCapability interface, so the COMPILER checks every entry;
        // this assertion is the runtime half - it keeps the registry and the measured table in step.
        expect(GAUGE_CONTROLS.length).toBe(19);
        const registered: string[] = GAUGE_CONTROLS.map((c: GaugeCapability) => c.TypeTag);
        const measured: string[] = CAPABILITIES.map(([, , tag]) => tag);
        expect(registered.slice().sort()).toEqual(measured.slice().sort());
        GAUGE_CONTROLS.forEach((control: GaugeCapability) => {
            expect(typeof control.getSignals).toBe('function');
            expect(typeof control.LabelTag).toBe('string');
        });
    });

    it('every control declares its own TypeTag, and no two controls share one', function () {
        const tags: string[] = [];
        CAPABILITIES.forEach(([name, cls, tag]) => {
            expect(cls.TypeTag).toBe(tag);
            tags.push(tag);
        });
        // A duplicate TypeTag would make the editor dispatch a drawn element to the wrong control.
        expect(tags.filter((t, i) => tags.indexOf(t) !== i)).toEqual([]);
    });

    it('every control declares a LabelTag, getSignals and processValue or getDialogType', function () {
        const problems: string[] = [];
        CAPABILITIES.forEach(([name, cls]) => {
            if (typeof cls.LabelTag !== 'string') { problems.push(name + ' has no LabelTag'); }
            if (typeof cls.getSignals !== 'function') { problems.push(name + ' has no static getSignals()'); }
        });
        expect(problems).toEqual([]);
    });

    it('getSignals answers exactly what it answered when this table was measured', function () {
        const problems: string[] = [];
        CAPABILITIES.forEach(([name, cls, tag, singular, plural]) => {
            let gotSingular: any;
            let gotPlural: any;
            try { gotSingular = cls.getSignals(SINGULAR); } catch (err) { gotSingular = 'THREW'; }
            try { gotPlural = cls.getSignals(PLURAL); } catch (err) { gotPlural = 'THREW'; }
            if (JSON.stringify(gotSingular) !== JSON.stringify(singular)) {
                problems.push(name + '.getSignals({variableId}) = ' + JSON.stringify(gotSingular) +
                    ', recorded ' + JSON.stringify(singular));
            }
            if (JSON.stringify(gotPlural) !== JSON.stringify(plural)) {
                problems.push(name + '.getSignals({variableIds}) = ' + JSON.stringify(gotPlural) +
                    ', recorded ' + JSON.stringify(plural));
            }
        });
        expect(problems).toEqual([]);
    });

    it('the four measured inconsistencies stay recorded until the interface work changes them', function () {
        // Stated one by one so that "fixing" one of them without the others is a visible decision.
        expect(HtmlChartComponent.getSignals(SINGULAR)).toBeUndefined();
        expect(HtmlGraphComponent.getSignals(SINGULAR)).toBeUndefined();
        // getSignals is typed ITableProperty on this control, so the probe goes through any: the point
        // is what it answers when a caller hands it something table-shaped it does not recognise.
        expect((HtmlTableComponent as any).getSignals(SINGULAR)).toBeNull();
        expect(HtmlRecipeComponent.getSignals(SINGULAR)).toEqual([]);
    });

    it('the two controls that are deliberately incomplete stay recorded', function () {
        // Cast through any on purpose: the members are genuinely absent, and TypeScript is right to
        // refuse them - the runtime is what this test is about.
        expect(typeof (HtmlImageComponent as any).getDialogType).toBe('undefined');
        expect(typeof (HtmlRecipeViewComponent as any).TypeTag).toBe('undefined');
    });

    it('getDialogType answers something for every control that declares it', function () {
        const problems: string[] = [];
        CAPABILITIES.forEach(([name, cls, tag, , ]) => {
            if (typeof cls.getDialogType !== 'function') { return; }
            try {
                if (typeof cls.getDialogType() === 'undefined') { problems.push(name + '.getDialogType() answered undefined'); }
            } catch (err) {
                problems.push(name + '.getDialogType threw: ' + err);
            }
        });
        expect(problems).toEqual([]);
    });
});
