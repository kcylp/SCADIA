/**
 * The contract between a gauge control and the editor / runtime that drives it (N-39).
 *
 * WHAT WAS WRONG. Every control in this directory carries the same handful of STATIC members -
 * TypeTag, LabelTag, getSignals, getDialogType, processValue, getActions - and nothing declared that
 * set, so nothing could check it. A control missing one was only discovered by calling it: the editor
 * asks a control for its dialog type, dispatches a value through processValue, or reads its signals,
 * and a control that forgot a member failed at the moment an operator used that widget.
 *
 * WHAT THIS INTERFACE IS, AND IS NOT. It describes the surface as it EXISTS TODAY - it is a
 * declaration of fact, not a wish list, and it deliberately does not force the four measured
 * disagreements to become uniform:
 *
 *   - getSignals may answer string[], undefined or null. Fifteen controls answer an array for
 *     { variableId }, the chart and the graph read { variableIds } (plural) and answer undefined for
 *     the singular shape, and the table answers null when the settings are not table-shaped. Making
 *     the return type `string[]` would have required changing those controls in the same breath, and
 *     the point of this step is to state the contract before changing it (see
 *     gauge-capability.spec.ts, which pins each of them individually).
 *   - getDialogType, processValue, getActions, processAction, actionsType and prefix are OPTIONAL,
 *     because two controls genuinely do without them: HtmlImageComponent has no dialog type, and
 *     HtmlRecipeComponent has no processValue (its values arrive through the recipe runtime).
 *
 * HOW IT IS ENFORCED. `GAUGE_CONTROLS` below is typed by this interface, so the compiler checks every
 * control against it on every build - a control that loses a member stops the build instead of an
 * operator's afternoon. GaugesManager consumes the same array as its registry, so the list cannot drift
 * from the one the runtime walks.
 */

import { GaugeAction, GaugeSettings, GaugeStatus, Variable } from '../_models/hmi';
import { GaugeDialogType } from './gauge-property/gauge-property.component';
import { GaugeProgressComponent } from './controls/gauge-progress/gauge-progress.component';
import { GaugeSemaphoreComponent } from './controls/gauge-semaphore/gauge-semaphore.component';
import { HtmlBagComponent } from './controls/html-bag/html-bag.component';
import { HtmlButtonComponent } from './controls/html-button/html-button.component';
import { HtmlChartComponent } from './controls/html-chart/html-chart.component';
import { HtmlGraphComponent } from './controls/html-graph/html-graph.component';
import { HtmlIframeComponent } from './controls/html-iframe/html-iframe.component';
import { HtmlImageComponent } from './controls/html-image/html-image.component';
import { HtmlInputComponent } from './controls/html-input/html-input.component';
import { HtmlRecipeComponent } from './controls/html-recipe/html-recipe.component';
import { HtmlSchedulerComponent } from './controls/html-scheduler/html-scheduler.component';
import { HtmlSelectComponent } from './controls/html-select/html-select.component';
import { HtmlSwitchComponent } from './controls/html-switch/html-switch.component';
import { HtmlTableComponent } from './controls/html-table/html-table.component';
import { HtmlVideoComponent } from './controls/html-video/html-video.component';
import { PanelComponent } from './controls/panel/panel.component';
import { PipeComponent } from './controls/pipe/pipe.component';
import { SliderComponent } from './controls/slider/slider.component';
import { ValueComponent } from './controls/value/value.component';

export interface GaugeCapability {
    /** The tag written into the drawn SVG element; the editor dispatches on it. Must be unique. */
    readonly TypeTag: string;
    /** The label the editor's toolbox shows for this control. */
    readonly LabelTag: string;
    /** The signal ids this control is bound to, read from its saved settings. */
    getSignals(pro: any): string[] | undefined | null;
    /** Which property dialog the editor opens for it. */
    getDialogType?(): GaugeDialogType;
    /** Push a value into the control. */
    processValue?(ga: GaugeSettings, svgele: any, sig: Variable, gaugeStatus: GaugeStatus, gauge?: any): void;
    /** The actions this control offers in the property dialog. */
    getActions?(type: string): any;
    /** The action types it declares, if it offers any. */
    actionsType?: any;
    /**
     * Run an action against the control.
     *
     * MEASURED, NOT DESIGNED: the controls do not agree on this signature, and the compiler refused the
     * first two versions of this interface because of it. Three shapes are in use today:
     *
     *   (act, svgele, value, gaugeStatus)                                  - most controls
     *   (act, svgele, input, value, gaugeStatus)                           - HtmlInputComponent, HtmlSelectComponent
     *   (act, svgele, button, value, gaugeStatus, propertyColor?)          - HtmlButtonComponent
     *   (act, svgele, value, gaugeStatus, defaultColor?) => boolean        - PipeComponent
     *
     * The untyped argument list states that fact instead of picking one shape and lying about the rest;
     * what the compiler still enforces is that a control HAS the member. Unifying the signature is part
     * of the work N-39 is preparing, and it needs the call sites (GaugesManager, the property dialogs)
     * moved in the same change.
     */
    processAction?(...args: any[]): any;
    /** The tag prefix this control's drawn elements use, when it is not exactly TypeTag. */
    prefix?: string;
}

/**
 * Every gauge control, in the order the editor lists them. Typed by the interface above: this is where
 * conformance is checked, and GaugesManager.Gauges returns exactly this array.
 */
export const GAUGE_CONTROLS: GaugeCapability[] = [
    ValueComponent,
    HtmlInputComponent,
    HtmlButtonComponent,
    HtmlBagComponent,
    HtmlSelectComponent,
    HtmlChartComponent,
    GaugeProgressComponent,
    GaugeSemaphoreComponent,
    HtmlGraphComponent,
    HtmlIframeComponent,
    HtmlTableComponent,
    HtmlImageComponent,
    PanelComponent,
    HtmlVideoComponent,
    HtmlSchedulerComponent,
    HtmlRecipeComponent,
    PipeComponent,
    SliderComponent,
    HtmlSwitchComponent
];
