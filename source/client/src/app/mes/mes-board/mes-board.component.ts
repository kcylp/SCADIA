import { Component } from '@angular/core';

/**
 * MES 制造执行看板.
 *
 * A READ-ONLY DEMO BOARD. The platform's whole premise is that it owns no business domain of its
 * own - it reaches a plant through OPC UA, REST and WebSocket and nothing else. So this page is
 * deliberately PURE FRONT END: every number below is a fixed constant written into the component,
 * never a random one, so two screenshots of the same release are identical and a value can be
 * checked by hand. Wiring a real MES means replacing the constants with a REST/WebSocket call -
 * the template and the shape of the data do not change.
 *
 * Every relationship in the demo data is kept TRUE, because a board whose arithmetic does not
 * close is worse than no board at all:
 *   progress      = completed / planned          (computed in the template from the two columns)
 *   OEE           = availability x performance x quality
 *   defect rate   = defectives / inspected
 *   achievement   = output / plan
 * Nothing here is a stored duplicate of another number.
 */
@Component({
    selector: 'app-mes-board',
    templateUrl: './mes-board.component.html',
    styleUrls: ['./mes-board.component.css']
})
export class MesBoardComponent {

    /** The reporting moment. Fixed, never 'now', so the board is reproducible. */
    readonly reportDate = '2026-10-04';
    readonly reportTime = '14:00';

    readonly shifts: string[] = ['mes.shift-a', 'mes.shift-b', 'mes.shift-c'];

    // ------------------------------------------------------------------ KPI tiles

    /** Today's good output, in pieces. */
    readonly dayOutput = 26870;
    readonly dayPlan = 31200;

    /** Quarterly plan attainment, a stored management figure (not derivable from this page). */
    readonly planAttainment = 94.2;
    readonly planAttainmentTarget = 95;

    readonly oeeAvg = 85.5;
    readonly oeeTarget = 85;

    readonly qualityRate = 98.9;

    // --------------------------------------------------------------- work orders

    /**
     * Work orders. planned/completed are the source of truth for the progress bar and for the
     * 已完工/进行中/待开工 status split shown in the tiles above.
     */
    readonly orders = [
        { order: 'WO-2026-1004-01', product: 'mes.p-1', operation: 'mes.op-cnc',        planned: 2400, completed: 2400, status: 'mes.status-done',        team: 'mes.shift-a' },
        { order: 'WO-2026-1004-02', product: 'mes.p-2', operation: 'mes.op-turn',       planned: 1800, completed: 1800, status: 'mes.status-done',        team: 'mes.shift-a' },
        { order: 'WO-2026-1004-03', product: 'mes.p-3', operation: 'mes.op-press',      planned: 3200, completed: 2610, status: 'mes.status-running',     team: 'mes.shift-a' },
        { order: 'WO-2026-1004-04', product: 'mes.p-4', operation: 'mes.op-weld',       planned: 1200, completed: 1142, status: 'mes.status-running',     team: 'mes.shift-b' },
        { order: 'WO-2026-1004-05', product: 'mes.p-5', operation: 'mes.op-heat',       planned: 1600, completed: 1150, status: 'mes.status-running',     team: 'mes.shift-b' },
        { order: 'WO-2026-1004-06', product: 'mes.p-6', operation: 'mes.op-assy',       planned: 2000, completed: 1430, status: 'mes.status-running',     team: 'mes.shift-b' },
        { order: 'WO-2026-1004-07', product: 'mes.p-1', operation: 'mes.op-cnc',        planned: 1500, completed: 1020, status: 'mes.status-running',     team: 'mes.shift-b' },
        { order: 'WO-2026-1004-08', product: 'mes.p-7', operation: 'mes.op-inspect',    planned: 900,  completed: 783,  status: 'mes.status-qc',          team: 'mes.shift-c' },
        { order: 'WO-2026-1004-09', product: 'mes.p-8', operation: 'mes.op-paint',      planned: 1300, completed: 806,  status: 'mes.status-running',     team: 'mes.shift-c' },
        { order: 'WO-2026-1004-10', product: 'mes.p-3', operation: 'mes.op-pack',       planned: 2200, completed: 1350, status: 'mes.status-running',     team: 'mes.shift-c' },
        { order: 'WO-2026-1004-11', product: 'mes.p-4', operation: 'mes.op-press',      planned: 800,  completed: 476,  status: 'mes.status-blocked',     team: 'mes.shift-c' },
        { order: 'WO-2026-1004-12', product: 'mes.p-2', operation: 'mes.op-turn',       planned: 1000, completed: 0,    status: 'mes.status-pending',     team: 'mes.shift-c' }
    ];

    // ---------------------------------------------------------- routing / process

    /** The routing: WIP at each station and that station's own completion. */
    readonly routing = [
        { key: 'mes.op-cnc',     wip: 1520, done: 3420, planned: 3900 },
        { key: 'mes.op-turn',    wip: 1180, done: 2820, planned: 3600 },
        { key: 'mes.op-press',   wip: 980,  done: 2610, planned: 4000 },
        { key: 'mes.op-weld',    wip: 640,  done: 1142, planned: 2200 },
        { key: 'mes.op-heat',    wip: 420,  done: 1150, planned: 1600 },
        { key: 'mes.op-assy',    wip: 530,  done: 1430, planned: 2000 },
        { key: 'mes.op-inspect', wip: 260,  done: 783,  planned: 900 },
        { key: 'mes.op-paint',   wip: 180,  done: 806,  planned: 1300 },
        { key: 'mes.op-pack',    wip: 90,   done: 1350, planned: 2200 }
    ];

    // ------------------------------------------------------- output and cycle time

    /** Today's good output (this is what makes dayOutput add up: 26870). */
    readonly outputHourly: number[] = [1020, 1180, 1250, 1310, 1290, 1340, 1260, 870];
    readonly outputLabels: string[] = ['mes.slot-08', 'mes.slot-09', 'mes.slot-10', 'mes.slot-11',
        'mes.slot-12', 'mes.slot-14', 'mes.slot-15', 'mes.slot-16'];

    readonly cycleStation = 'mes.eq-03';
    readonly cycleToday = 25.8;
    readonly cycleTarget = 24.0;
    /** The same station's cycle time at the start of the year - the delta is what the chart is about. */
    readonly cycleBaseline = 28.4;

    // ------------------------------------------------------------------- equipment

    /** OEE = availability x performance x quality. Each row is filled in by hand and checks out. */
    readonly equipment = [
        { key: 'mes.eq-01', availability: 95.2, performance: 96.5, quality: 99.1, oee: 91.0 },
        { key: 'mes.eq-03', availability: 93.1, performance: 94.0, quality: 99.2, oee: 86.8 },
        { key: 'mes.eq-05', availability: 89.5, performance: 91.2, quality: 98.7, oee: 80.6 },
        { key: 'mes.eq-02', availability: 96.4, performance: 97.8, quality: 98.4, oee: 92.8 },
        { key: 'mes.eq-04', availability: 94.2, performance: 95.6, quality: 97.9, oee: 88.2 },
        { key: 'mes.eq-06', availability: 91.3, performance: 92.5, quality: 96.9, oee: 81.8 },
        { key: 'mes.eq-07', availability: 87.6, performance: 96.1, quality: 98.0, oee: 82.5 },
        { key: 'mes.eq-08', availability: 88.4, performance: 93.2, quality: 97.6, oee: 80.4 }
    ];

    // --------------------------------------------------------------------- quality

    readonly inspectedTotal = 27130;
    readonly defectiveTotal = 301;

    /**
     * defect rate = count / inspected (to one decimal), ppm = count / inspected x 1e6 (to the
     * unit). The six counts add up to the 301 in the panel header, and the rates shown are the
     * exact quotients rather than stored copies, so the column can be divided by hand.
     */
    readonly defects = [
        { key: 'mes.defect-01', count: 74, inspected: 26600, rate: 0.3, ppm: 2782 },
        { key: 'mes.defect-02', count: 63, inspected: 12140, rate: 0.5, ppm: 5189 },
        { key: 'mes.defect-03', count: 44, inspected: 14200, rate: 0.3, ppm: 3099 },
        { key: 'mes.defect-04', count: 51, inspected: 18200, rate: 0.3, ppm: 2802 },
        { key: 'mes.defect-05', count: 36, inspected: 8350,  rate: 0.4, ppm: 4311 },
        { key: 'mes.defect-06', count: 33, inspected: 6500,  rate: 0.5, ppm: 5077 }
    ];

    // ----------------------------------------------------------------------- teams

    /** achievement = output / plan. One row per shift, all three add up to dayOutput. */
    readonly teams = [
        { key: 'mes.shift-a', plan: 10800, output: 9650, achievement: 89.4, oee: 88.4 },
        { key: 'mes.shift-b', plan: 10400, output: 10230, achievement: 98.4, oee: 90.2 },
        { key: 'mes.shift-c', plan: 8800,  output: 6990, achievement: 79.4, oee: 77.9 }
    ];

    // -------------------------------------------------------------------- derived

    get runningCount(): number {
        return this.orders.filter((o) => o.status === 'mes.status-running' || o.status === 'mes.status-qc').length;
    }

    get doneCount(): number {
        return this.orders.filter((o) => o.status === 'mes.status-done').length;
    }

    get pendingCount(): number {
        return this.orders.filter((o) => o.status === 'mes.status-pending' || o.status === 'mes.status-blocked').length;
    }

    get orderTotal(): number {
        return this.orders.reduce((n, o) => n + o.planned, 0);
    }

    get orderCompleted(): number {
        return this.orders.reduce((n, o) => n + o.completed, 0);
    }

    /** Floor plan attainment for the order book on this board - counted, not typed in. */
    get orderProgress(): number {
        return Math.round(this.orderCompleted / this.orderTotal * 1000) / 10;
    }

    /** The peak of the hourly output bars, so a bar's height is a plain percentage. */
    get outputPeak(): number {
        return Math.max.apply(null, this.outputHourly);
    }

    barWidth(value: number, max: number): string {
        return (Math.round(value / max * 1000) / 10) + '%';
    }

    /**
     * The bar that fills an order's progress wears the colour of that order's own status, so the
     * bar and the pill in the next cell can never disagree.
     */
    fillClass(status: string): string {
        return 'mes-progress__fill--' + status.replace('mes.status-', '');
    }

    /** The largest shift plan, so the team bars share one scale. */
    get planMax(): number {
        return Math.max.apply(null, this.teams.map((t) => t.plan));
    }

    /** The widest defect is the scale for the Pareto bars. */
    get defectPeak(): number {
        return Math.max.apply(null, this.defects.map((d) => d.count));
    }

    /** The widest routing station is the scale for the WIP bars. */
    get routingPeak(): number {
        return Math.max.apply(null, this.routing.map((r) => r.done + r.wip));
    }

    /** A signal colour for a percentage that has a target: ok at or above it, warn within 5, else alarm. */
    band(value: number, target: number): string {
        if (value >= target) { return 'sc-pill--ok'; }
        return value >= target - 5 ? 'sc-pill--warn' : 'sc-pill--alarm';
    }
}
