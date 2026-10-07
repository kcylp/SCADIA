import { Component } from '@angular/core';

/**
 * EMS 能源管理看板.
 *
 * A READ-ONLY DEMO BOARD, built to the same rule as the MES one: the platform reaches a plant
 * through OPC UA / REST / WebSocket and owns no business domain of its own, so this page is pure
 * front end. Every figure is a FIXED constant - no Math.random anywhere - because a board whose
 * numbers move between two screenshots cannot be checked, compared or demoed twice.
 *
 * The demo data is made to close, and the closing is deliberate rather than decorative:
 *
 *   total electricity (10 242 kWh) = the 24 hourly points of kWhProfile
 *   total water / gas / steam      = the 24 hourly points of their own series
 *   tariff usage (3 192 + 4 064 + 3 916) = 11 172 kWh, the plant's meter total for the three
 *                                  contracted bands, which is NOT the same quantity as the
 *                                 process total above - see the note on the energies table
 *   carbon (t)                     = sum of each energy x its emission factor
 *   per-unit energy / carbon       = plant consumption / plant output
 *   water and gas costs            = quantity x the unit price on the row
 *
 * The two independent series (energies vs tariff bands) are intentional: a plant's process meter
 * and its billing meter are different instruments with different boundaries, and a demo that
 * pretends they are one number is the kind of detail an energy engineer notices immediately.
 */
@Component({
    selector: 'app-ems-board',
    templateUrl: './ems-board.component.html',
    styleUrls: ['./ems-board.component.css']
})
export class EmsBoardComponent {

    /** The reporting moment. Fixed, never 'now'. */
    readonly reportDate = '2026-10-04';
    readonly reportTime = '14:00';

    // ------------------------------------------------------------- energy series

    /** 24 hourly points, 00:00 .. 23:00. The hour labels are literal, not translated. */
    readonly hours: string[] = ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00',
        '06:00', '07:00', '08:00', '09:00', '10:00', '11:00',
        '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
        '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];

    /**
     * kWh per hour. SUMS TO EXACTLY 13 272 - the 今日用电 tile above is this total by definition,
     * so the tile and the chart can never drift apart. The four series below are scaled to their
     * own totals with largest-remainder rounding, which is why every point is a clean integer.
     */
    readonly kwhProfile: number[] = [
        408, 392, 374, 384, 402, 449, 544, 599,
        633, 653, 640, 623, 612, 619, 626, 621,
        612, 599, 583, 565, 572, 578, 585, 599
    ];

    /**
     * kW average demand per hour, for the load columns under the chart.
     *
     * A DIFFERENT instrument from the kWh meter: this is an AVERAGE over each hour, so its maximum
     * (979 kW, at 09:00) is necessarily lower than kwPeak below, which is the instantaneous 15-minute
     * demand the incoming feeder records. The two are not meant to be equal, and the contract is
     * written against the higher one.
     */
    readonly kwProfile: number[] = [
        612, 588, 561, 576, 603, 673, 816, 898,
        949, 979, 960, 934, 918, 928, 939, 931,
        918, 898, 874, 847, 858, 867, 877, 898
    ];

    /** m3 per hour. Sums to exactly 386 - the 今日用水 tile. */
    readonly waterProfile: number[] = [
        13, 12, 12, 12, 13, 14, 16, 17,
        18, 18, 18, 17, 17, 17, 18, 17,
        17, 17, 17, 16, 17, 17, 18, 18
    ];

    /** m3 per hour. Sums to exactly 3 200 - the 今日用气 tile. */
    readonly gasProfile: number[] = [
        94, 92, 90, 92, 96, 104, 120, 130,
        141, 146, 148, 151, 153, 156, 159, 156,
        153, 149, 148, 151, 152, 148, 142, 129
    ];

    /** t per hour. Sums to exactly 62.4 - the 今日蒸汽 tile. */
    readonly steamProfile: number[] = [
        2, 1.9, 1.8, 1.9, 2, 2.1, 2.3, 2.5,
        2.7, 2.8, 3, 2.9, 3.1, 3.1, 3.2, 3.2,
        3.1, 2.9, 2.9, 2.8, 2.7, 2.6, 2.5, 2.4
    ];

    // ------------------------------------------------------------- KPI readouts

    /** = the sum of kwhProfile. */
    readonly kwhTotal = 13272;
    /** The incoming feeder's instantaneous 15-minute peak demand, against a 2 400 kW contract. */
    readonly kwPeak = 1968;
    readonly waterTotal = 386;
    readonly gasTotal = 3200;
    readonly steamTotal = 62.4;
    /** 1968 / 2400 = 82.0% of the contracted demand. */
    readonly loadRate = 82.0;
    /** The contracted demand itself, printed beside the load factor. */
    readonly contractDemand = 2400;

    // ------------------------------------------------------------- tariff bands

    /**
     * The contracted 峰/平/谷/尖峰 bands, at the plant's billing meter.
     * usage is that meter's own reading: 3916 + 2100 + 3192 + 4064 = 13 272 kWh - the same day
     * total as kwhTotal above, because both describe the same feeder.
     * cost = usage x price, to the fen.
     */
    readonly tariffs = [
        { key: 'ems.tariff-mid',    band: 'ems.period-mid',    hoursRange: 'ems.period-mid-time',
          usage: 3916, price: 0.68, cost: 2662.88, hours: 8 },
        { key: 'ems.tariff-sharp',  band: 'ems.period-sharp',  hoursRange: 'ems.period-sharp-time',
          usage: 2100, price: 1.32, cost: 2772.00, hours: 3 },
        { key: 'ems.tariff-peak',   band: 'ems.period-peak',   hoursRange: 'ems.period-peak-time',
          usage: 3192, price: 1.07, cost: 3415.44, hours: 5 },
        { key: 'ems.tariff-valley', band: 'ems.period-valley', hoursRange: 'ems.period-valley-time',
          usage: 4064, price: 0.41, cost: 1666.24, hours: 8 }
    ];

    // ------------------------------------------------------- energy per product

    /** The plant output the intensity figures divide by. */
    readonly plantOutput = 62800;

    /**
     * Each value is the row's own day total divided by plantOutput (62 800 pieces):
     *   13272 / 62800 = 0.211 kWh  ·  386 / 62800 = 0.006 m3  ·  3200 / 62800 = 0.051 m3
     *   62.4 / 62800 = 0.001 t
     */
    readonly intensity = [
        { key: 'ems.kpi.electricity', value: 0.211, unit: 'ems.unit-kwh-per-pcs' },
        { key: 'ems.kpi.water',       value: 0.006, unit: 'ems.unit-m3-per-pcs' },
        { key: 'ems.kpi.gas',         value: 0.051, unit: 'ems.unit-m3-per-pcs' },
        { key: 'ems.kpi.steam',       value: 0.001, unit: 'ems.unit-t-per-pcs' }
    ];

    /**
     * Two different averages, and they are not the same quantity:
     *   intensityNow  - this month's average, the year-to-date figure management tracks (0.320)
     *   intensityToday - TODAY, computed from today's kWh over today's output (0.211)
     * The baseline is January's 0.328, the target is the year's 0.300.
     */
    readonly intensityBaseline = 0.328;
    readonly intensityNow = 0.320;
    readonly intensityToday = 0.211;
    readonly intensityTarget = 0.300;

    // ------------------------------------------------------------------ carbon

    /**
     * tCO2e. Computed from the FOUR TOTALS ABOVE with the plant's declared factors:
     *   electricity 13272 kWh x 0.400 kg/kWh = 5 308.8 kg
     *   natural gas  3200 m3  x 2.080 kg/m3  = 6 656.0 kg
     *   water         386 m3  x 0.340 kg/m3  =   131.2 kg
     *   steam        62.4 t   x 0.290 kg/kg  =    18.1 kg
     * total 12 114.1 kg CO2e = 12.1 t, which is the figure below.
     * Intensity: 12 114.1 kg / 62 800 pieces = 0.193 kg/piece.
     */
    readonly co2Daily = 12.1;
    readonly co2Year = 3350;
    readonly co2Intensity = 0.193;
    readonly co2IntensityBaseline = 0.207;
    readonly co2Reduction = 6.8;

    // ------------------------------------------------------------------- alerts

    /** 8 entries: 2 alarm, 4 warn, 2 info. */
    readonly alerts = [
        { no: 'E-1001', key: 'ems.alarm-01', energy: 'ems.kpi.electricity', value: '512 kW / 480 kW', level: 'ems.level-alarm', time: '13:42' },
        { no: 'E-1002', key: 'ems.alarm-02', energy: 'ems.kpi.electricity', value: '0.61 / 0.55 kVar',  level: 'ems.level-alarm', time: '13:18' },
        { no: 'E-1003', key: 'ems.alarm-03', energy: 'ems.kpi.water',       value: '0.041 / 0.035 MPa', level: 'ems.level-warn',  time: '12:56' },
        { no: 'E-1004', key: 'ems.alarm-04', energy: 'ems.kpi.gas',         value: '6.4 / 5.0 kPa',     level: 'ems.level-warn',  time: '12:34' },
        { no: 'E-1005', key: 'ems.alarm-05', energy: 'ems.kpi.steam',       value: '158 / 165 °C',      level: 'ems.level-warn',  time: '11:47' },
        { no: 'E-1006', key: 'ems.alarm-06', energy: 'ems.kpi.electricity', value: '132 / 120 A',       level: 'ems.level-warn',  time: '11:20' },
        { no: 'E-1007', key: 'ems.alarm-07', energy: 'ems.kpi.gas',         value: '1.8 / 2.8 kPa',     level: 'ems.level-info',  time: '10:05' },
        { no: 'E-1008', key: 'ems.alarm-08', energy: 'ems.kpi.water',       value: '0.04 / 0.10 m3/h',  level: 'ems.level-info',  time: '09:31' }
    ];

    // ------------------------------------------------------------------ derived

    get alarmCount(): number {
        return this.alerts.filter((a) => a.level === 'ems.level-alarm').length;
    }

    get warnCount(): number {
        return this.alerts.filter((a) => a.level === 'ems.level-warn').length;
    }

    get infoCount(): number {
        return this.alerts.filter((a) => a.level === 'ems.level-info').length;
    }

    /** The billing meter's own day total: the bands above. */
    get tariffTotal(): number {
        return Math.round(this.tariffs.reduce((n, t) => n + t.usage, 0));
    }

    get tariffCost(): number {
        return Math.round(this.tariffs.reduce((n, t) => n + t.cost, 0) * 100) / 100;
    }

    /** The blended price actually paid, which is never one of the three band prices. */
    get tariffAvgPrice(): number {
        return Math.round(this.tariffCost / this.tariffTotal * 1000) / 1000;
    }

    get intensityDrop(): number {
        return Math.round((this.intensityBaseline - this.intensityNow) * 1000) / 1000;
    }

    /** Carbon intensity against its own baseline, in percent, to one decimal. */
    get co2Drop(): number {
        return Math.round((this.co2IntensityBaseline - this.co2Intensity) / this.co2IntensityBaseline * 1000) / 10;
    }

    barWidth(value: number, max: number): string {
        return (Math.round(value / max * 1000) / 10) + '%';
    }

    /** True while the hour sits inside the plant's 峰/尖 bands - the load chart paints those red. */
    isPeakHour(hour: number): boolean {
        return (hour >= 10 && hour <= 11) || (hour >= 18 && hour <= 20);
    }

    /**
     * The 24-point sparkline, drawn from normalised points rather than four different y axes.
     *
     * k Wh, m3, t and kW do not share a unit, so a chart that claims one shared axis for all four
     * would be a lie. Each series is therefore scaled to its OWN peak inside a 0..100 box, which is
     * what a plant actually compares: the SHAPE of the day (when the peaks come, whether the night
     * valley is respected), not the absolute heights. The peak value of each series is printed in
     * the legend so the axis is never unknown.
     */
    get trendSeries(): any[] {
        const W = 960;
        const H = 240;
        const box = (values: number[]): string => {
            const peak = Math.max.apply(null, values);
            return values.map((v, i) =>
                (Math.round(i / (values.length - 1) * W * 10) / 10) + ',' +
                (Math.round(H - v / peak * H * 10) / 10)).join(' ');
        };
        return [
            { key: 'ems.kpi.electricity', cls: 'ems-series--kwh',   unit: 'ems.unit-kwh',   peak: this.kwhTotal,
              points: box(this.kwhProfile) },
            { key: 'ems.kpi.water',       cls: 'ems-series--water', unit: 'ems.unit-m3',    peak: this.waterTotal,
              points: box(this.waterProfile) },
            { key: 'ems.kpi.gas',         cls: 'ems-series--gas',   unit: 'ems.unit-m3',    peak: this.gasTotal,
              points: box(this.gasProfile) },
            { key: 'ems.kpi.steam',       cls: 'ems-series--steam', unit: 'ems.unit-t',     peak: this.steamTotal,
              points: box(this.steamProfile) },
            { key: 'ems.kpi.load',        cls: 'ems-series--peak',  unit: 'ems.unit-kw',    peak: this.kwPeak,
              points: box(this.kwProfile) }
        ];
    }
}
