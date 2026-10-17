'use strict';
/* 测温适配器契约测试：全部用注入的 fetcher/配置，不触碰现场设备与真实凭据。
* 数据源契约按实测设备（DS-2TD2637T-10/Q, V5.5.308）：
*   - /ISAPI/Thermal/TempHumi → 设备测温模块实时温度（XML，含设备时间戳）
*   - basicParam → 单位/量程元数据
*   - /ISAPI/Thermometry/* 与 PICT/jpeg 在该固件不可用（403/400），适配器绝不虚构 ROI 温度。 */
const assert = require('assert');
const { Thermometry, toCelsius, parseTempHumiXml, parseBasicParamXml, parseThermometryXml, digestHeaders, create } = require('../../runtime/cameras/thermometry');

const tempHumiXml = `<?xml version="1.0" encoding="UTF-8"?>
<TempHumiList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<TempHumi version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>2</id>
<currentTime>2026-10-17T10:10:57+08:00</currentTime>
<temperature>33.00</temperature>
</TempHumi>
</TempHumiList>`;

const basicParamXml = `<?xml version="1.0" encoding="UTF-8"?>
<ThermometryBasicParam version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>2</id><enabled>false</enabled><streamOverlay>true</streamOverlay>
<temperatureRange>-20~150</temperatureRange><temperatureUnit>degreeCentigrade</temperatureUnit>
<emissivity>0.96</emissivity><distanceUnit>centimeter</distanceUnit><distance>600</distance>
</ThermometryBasicParam>`;

describe('Thermal radiometry adapter (device ISAPI contract)', function () {
    this.timeout(10000);
    it('parses TempHumi: device temperature with device timestamp and channel id', () => {
        const r = parseTempHumiXml(tempHumiXml);
        assert.ok(r);
        assert.equal(r.id, '2');
        assert.equal(r.temperature, 33);
        assert.equal(r.currentTime, '2026-10-17T10:10:57+08:00');
    });
    it('rejects bad TempHumi payloads instead of inventing temperatures', () => {
        for (const bad of ['', '<html/>', '<TempHumiList/>', '<TempHumi><temperature>NaN</temperature></TempHumi>']) {
            const r = parseTempHumiXml(bad);
            assert.ok(!r || !Number.isFinite(r.temperature), 'must refuse: ' + bad);
        }
    });
    it('parses basicParam metadata: unit and range', () => {
        const m = parseBasicParamXml(basicParamXml);
        assert.equal(m.unit, 'degreeCentigrade');
        assert.equal(m.range, '-20~150');
    });
    it('converts F/K to °C and refuses unknown units', () => {
        assert.ok(Math.abs(toCelsius(88.16, 'F') - 31.2) < 1e-9);
        assert.ok(Math.abs(toCelsius(304.35, 'K') - 31.2) < 0.01);
        assert.equal(toCelsius(31.2, 'degreeCentigrade'), 31.2);
        assert.equal(toCelsius(31.2, 'Réaumur'), null, '未知单位必须拒绝显示');
        assert.equal(toCelsius(null, 'C'), null);
    });
    it('keeps the legacy Thermometry XML parser for forward compatibility', () => {
        const p = parseThermometryXml('<Thermometry><maxTemperature>31.2</maxTemperature><minTemperature>6.4</minTemperature></Thermometry>');
        assert.equal(p.max, 31.2); assert.equal(p.min, 6.4);
    });
    it('a valid TempHumi sample becomes ok: °C, device clock, trend history', async () => {
        const t = new Thermometry({ host: '192.0.2.9', isapiPaths: ['/ISAPI/Thermal/TempHumi'], basicParamPath: '/ISAPI/Thermal/channels/2/thermometry/basicParam' });
        t.setFetcher(async (path) => {
            if (path.indexOf('TempHumi') >= 0) { return { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) }; }
            return { status: 200, body: basicParamXml };
        });
        assert.equal(await t.sample({ username: 'u', password: 'p' }), true);
        const s = t.status();
        assert.equal(s.status, 'ok');
        assert.equal(s.unit, '°C');
        assert.equal(s.measurementMode, 'device-sensor');
        assert.equal(s.deviceTemperature, 33);
        assert.equal(s.tempHumiChannel, '2');
        assert.equal(s.clockSource, 'device');
        assert.equal(s.range, '-20~150');
        assert.equal(s.sceneTemperature, null, '固件不开放 ROI 温度，绝不虚构');
        assert.equal(s.hotspots.length, 0);
        assert.equal(s.quality.valid, true);
        assert.equal(t.trend().length, 1);
        assert.equal(t.trend()[0].temperature, 33);
    });
    it('auth failure keeps error status without fake values and engages back-off ladder', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        let authHeaderSeen = null;
        t.setFetcher(async (path, authHeader) => {
            if (authHeader) { authHeaderSeen = authHeader; }
            return { status: 401, headers: { 'www-authenticate': 'Digest realm="test", nonce="n1", qop="auth"' } };
        });
        assert.equal(await t.sample({ username: 'u', password: 'p' }), false);
        // 设备实测行为：Digest uri 必须是完整 URL（http://host:port/path），仅路径会被拒 401。
        assert.ok(authHeaderSeen, 'digest retry must carry Authorization');
        const uri = (/uri="([^"]+)"/.exec(authHeaderSeen) || [])[1];
        assert.equal(uri, 'http://192.0.2.9:80/ISAPI/Thermal/TempHumi');
        const s = t.status();
        assert.equal(s.status, 'unauthorized');
        assert.equal(s.deviceTemperature, undefined);
        assert.equal(t.consecutiveFailures, 1);
        assert.ok(t._backoffMs() > 0, 'auth failure must back off instead of hammering the device');
        // 连续认证失败必须退避到锁定窗口（30 分钟）之外，避免把设备账号永久锁死。
        t.consecutiveFailures = 6;
        assert.equal(t._backoffMs(), 1800000, '5+ consecutive auth failures back off to 30min');
    });
    it('network errors surface as error, never as success', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        t.setFetcher(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); });
        await t.sample({ username: 'u', password: 'p' }).catch(() => { });
        const s = t.status();
        assert.equal(s.status !== 'ok', true);
        assert.equal(s.deviceTemperature, undefined);
    });
    it('stale samples expire by freshness SLA', async () => {
        const t = new Thermometry({ host: '192.0.2.9', staleAfterMs: 50 });
        t.setFetcher(async (path) => path.indexOf('TempHumi') >= 0 ?
            { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) } :
            { status: 200, body: basicParamXml });
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'ok');
        await new Promise(r => setTimeout(r, 120));
        const s = t.status();
        assert.equal(s.status, 'stale');
        assert.equal(s.quality.valid, false);
        assert.ok(s.reason && s.reason.includes('过期'));
    });
    it('create() factory surfaces no-credentials honestly when no camera config exists', async () => {
        const runtime = { settings: {}, logger: { info() {}, warn() {}, error() {} } };
        const mgr = create(runtime);   // 无 workDir/相机配置：必须如实暴露 no_credentials
        await new Promise(r => setTimeout(r, 80));   // 等首个异步采样周期完成
        const snap = mgr.snapshot();
        assert.equal(snap.status, 'no_credentials');
        assert.equal(snap.deviceTemperature, undefined);
        assert.equal(snap.quality.valid, false);
        await mgr.stop();
    });
    it('R03: blank/whitespace temperature is refused, not turned into a valid 0°C', () => {
        for (const blank of ['<TempHumi><temperature>  </temperature></TempHumi>',
            '<TempHumi><temperature>\t\n</temperature></TempHumi>',
            '<TempHumi><temperature></temperature></TempHumi>',
            '<TempHumi></TempHumi>']) {
            assert.equal(parseTempHumiXml(blank), null, 'blank must be refused: ' + JSON.stringify(blank));
        }
        assert.equal(parseTempHumiXml('<TempHumi><temperature>0</temperature></TempHumi>').temperature, 0, 'legal 0 preserved');
        assert.equal(parseTempHumiXml('<TempHumi><temperature>-12.5</temperature></TempHumi>').temperature, -12.5, 'negative preserved');
        assert.equal(parseTempHumiXml('<TempHumi><temperature>NaN</temperature></TempHumi>'), null);
        assert.equal(parseTempHumiXml('<TempHumi><temperature>Infinity</temperature></TempHumi>'), null);
        assert.equal(parseTempHumiXml('<TempHumi><temperature>0x10</temperature></TempHumi>'), null, 'non-decimal refused');
    });
    it('R03: sample layer does not accept a blank reading as a valid 0°C sample', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: '<TempHumi><id>2</id><currentTime>' + new Date().toISOString() + '</currentTime><temperature>   </temperature></TempHumi>' }
            : { status: 200, body: basicParamXml });
        assert.equal(await t.sample({ username: 'u', password: 'p' }), false);
        const s = t.status();
        assert.notEqual(s.status, 'ok');
        assert.equal(s.deviceTemperature, undefined);
        assert.equal(t.trend().length, 0);
    });
    it('R02: converts by device metadata unit (F) instead of hard-coding Celsius', async () => {
        const fXml = basicParamXml.replace('degreeCentigrade', 'fahrenheit').replace('-20~150', '32~302');
        const t = new Thermometry({ host: '192.0.2.9' });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('33.00', '86').replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) }
            : { status: 200, body: fXml });
        assert.equal(await t.sample({ username: 'u', password: 'p' }), true);
        const s = t.status();
        assert.equal(s.unit, '°C');
        assert.equal(s.deviceTemperature, 30);        // 86°F -> 30°C
        assert.equal(s.unitSource, 'fahrenheit');     // 与数值一致，不再自相矛盾
        assert.equal(s.range, '32~302');
    });
    it('R02: missing unit yields an explicit state, never a silent Celsius reading', async () => {
        const noUnit = basicParamXml.replace('<temperatureUnit>degreeCentigrade</temperatureUnit>', '');
        const t = new Thermometry({ host: '192.0.2.9' });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) }
            : { status: 200, body: noUnit });
        assert.equal(await t.sample({ username: 'u', password: 'p' }), false);
        const s = t.status();
        assert.equal(s.status, 'unknown_unit');
        assert.equal(s.unitSource, undefined);
    });
    it('R04: repeated device timestamp is not a new sample and freezes after tolerance', async () => {
        const t = new Thermometry({ host: '192.0.2.9', deviceUpdateToleranceMs: 0 });
        const frozen = tempHumiXml.replace('2026-10-17T10:10:57+08:00', '2000-01-01T00:00:00Z');
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0 ? { status: 200, body: frozen } : { status: 200, body: basicParamXml });
        await t.sample({ username: 'u', password: 'p' });
        await new Promise(r => setTimeout(r, 10));
        await t.sample({ username: 'u', password: 'p' });
        const s = t.status();
        assert.equal(s.samples, 1, 'duplicate timestamp must not add a new sample');
        assert.equal(s.status, 'stale', 'frozen timestamp must not look current-ok');
        assert.equal(s.timeStatus, 'frozen');
        assert.equal(s.quality.valid, false);
    });
    it('R04: advancing device time with constant temperature keeps sampling normally', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        let n = 0;
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', new Date(Date.now() + (n++ * 1000)).toISOString()) }
            : { status: 200, body: basicParamXml });
        await t.sample({ username: 'u', password: 'p' });
        await t.sample({ username: 'u', password: 'p' });
        const s = t.status();
        assert.equal(s.status, 'ok');
        assert.equal(s.timeStatus, 'ok');
        assert.equal(s.samples, 2);
    });
    it('R04: invalid device time falls back to server receive, not labelled device', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', 'nonsense') }
            : { status: 200, body: basicParamXml });
        await t.sample({ username: 'u', password: 'p' });
        const s = t.status();
        assert.equal(s.clockSource, 'server-receive');
        assert.equal(s.timeStatus, 'invalid');
    });
    it('R05: an auth failure after success surfaces as error while keeping the last known value', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        let fail = false;
        t.setFetcher(async (p) => {
            if (p.indexOf('TempHumi') >= 0) {
                return fail ? { status: 401, headers: { 'www-authenticate': 'Digest realm="t", nonce="n", qop="auth"' } }
                            : { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) };
            }
            return { status: 200, body: basicParamXml };
        });
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'ok');
        fail = true;
        await t.sample({ username: 'u', password: 'p' });
        const s = t.status();
        assert.equal(s.status, 'unauthorized', 'recent failure must override the last success');
        assert.equal(s.deviceTemperature, 33, 'last known value kept for reference');
        assert.equal(s.quality.valid, false);
        fail = false;
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'ok', 'recovery clears the error');
    });
    it('R02: a metadata response that lost the unit must not silently reuse the stale unit', async () => {
        // 首次单位=F（有界有效期内），其后设备只回量程、不再回单位 → 单位过期后必须报 unknown_unit。
        const fXml = basicParamXml.replace('degreeCentigrade', 'fahrenheit');
        const noUnitXml = basicParamXml.replace('<temperatureUnit>degreeCentigrade</temperatureUnit>', '');
        let withUnit = true;
        const t = new Thermometry({ host: '192.0.2.9', metaUnitTtlMs: 50 });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('33.00', '86').replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) }
            : { status: 200, body: withUnit ? fXml : noUnitXml });
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'ok');
        assert.equal(t.status().deviceTemperature, 30);        // 86°F -> 30°C
        withUnit = false;
        await new Promise(r => setTimeout(r, 90));             // 单位有效期已过
        await t.sample({ username: 'u', password: 'p' });
        const s = t.status();
        assert.equal(s.status, 'unknown_unit', 'unit must not be silently reused after it disappeared');
        // 不再刷新单位确认时间（不把缺单位响应当刚刚重新确认）。
        assert.ok(t.unitConfirmedAt <= Date.now() - 60, 'unit confirmation time must not be refreshed');
    });
    it('R02: switching device must not inherit the previous camera unit/range', async () => {
        const fXml = basicParamXml.replace('degreeCentigrade', 'fahrenheit').replace('-20~150', '32~302');
        const noUnitXml = basicParamXml.replace('<temperatureUnit>degreeCentigrade</temperatureUnit>', '');
        const t = new Thermometry({ host: '192.0.2.9', cameraId: 'camA', metaUnitTtlMs: 600000 });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('33.00', '86').replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) }
            : { status: 200, body: t.options.cameraId === 'camA' ? fXml : noUnitXml });
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().unitSource, 'fahrenheit');
        t.options.cameraId = 'camB';    // 换设备：不得继承 camA 的 F 单位
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'unknown_unit');
    });
    it('R04: two alternating old timestamps cannot revive ok or grow the trend', () => {
        const t = new Thermometry({ host: '192.0.2.9', deviceUpdateToleranceMs: 20000 });
        const newer = '2000-01-01T00:00:01Z', older = '2000-01-01T00:00:00Z';
        let recv = 1000000;
        const seq = [newer, older, newer, older, newer, older, newer, older];
        const out = seq.map(v => { const r = t._assessDeviceTime(v, recv); recv += 5000; return r; });
        assert.equal(out[0].appendSample, true, 'first sighting may be accepted');
        for (let i = 1; i < out.length; i++) {
            assert.notEqual(out[i].timeStatus, 'ok', 'must not revive ok after 20s: ' + JSON.stringify(out[i]));
            assert.equal(out[i].appendSample, false, 'replayed old timestamp must not add a sample');
        }
    });
    it('R04: a real device clock reset needs consecutive advancing confirmations', () => {
        const t = new Thermometry({ host: '192.0.2.9', clockResetMinMs: 60000, clockResetConfirmSamples: 3 });
        const base = Date.parse('2026-01-01T00:00:00Z');
        let recv = 1000;
        const at = ms => new Date(base + ms).toISOString();
        assert.equal(t._assessDeviceTime(at(0), recv).timeStatus, 'ok');           // 建立高水位
        recv += 5000;
        assert.equal(t._assessDeviceTime(at(1_000_000), recv).timeStatus, 'ok');  // 正常推进
        recv += 5000;
        const down = t._assessDeviceTime(at(0), recv);
        assert.equal(down.timeStatus, 'resync-pending', 'big backward is not immediately resynced');
        recv += 5000; assert.equal(t._assessDeviceTime(at(5000), recv).timeStatus, 'resync-pending');
        recv += 5000;
        const done = t._assessDeviceTime(at(10000), recv);
        assert.equal(done.timeStatus, 'resynced', 'after consecutive advances the baseline re-anchors');
        assert.equal(done.appendSample, true);
    });
    it('R04: invalid device time does not become a current valid measurement', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        t.setFetcher(async (p) => p.indexOf('TempHumi') >= 0
            ? { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', 'nonsense') }
            : { status: 200, body: basicParamXml });
        await t.sample({ username: 'u', password: 'p' });
        const s = t.status();
        assert.equal(s.timeStatus, 'invalid');
        assert.equal(s.status, 'stale');
        assert.equal(t.trend().length, 0, 'invalid time must not append a trend sample');
    });
    it('R05: 403 and timeout after success are surfaced, not shown as normal', async () => {
        const t = new Thermometry({ host: '192.0.2.9' });
        let mode = 'ok';
        t.setFetcher(async (p) => {
            if (p.indexOf('TempHumi') >= 0) {
                if (mode === 'ok') { return { status: 200, body: tempHumiXml.replace('2026-10-17T10:10:57+08:00', new Date().toISOString()) }; }
                if (mode === 'forbidden') { return { status: 403, body: '' }; }
                if (mode === 'timeout') { return { status: 0, errorType: 'timeout' }; }
                return { status: 200, body: '<html/>' };
            }
            return { status: 200, body: basicParamXml };
        });
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'ok');
        mode = 'forbidden';
        await t.sample({ username: 'u', password: 'p' });
        assert.notEqual(t.status().status, 'ok', '403 must not read as normal');
        mode = 'timeout';
        await t.sample({ username: 'u', password: 'p' });
        assert.notEqual(t.status().status, 'ok', 'timeout must not read as normal');
        mode = 'bad';
        await t.sample({ username: 'u', password: 'p' });
        assert.notEqual(t.status().status, 'ok', 'bad payload must not read as normal');
        mode = 'ok';
        await t.sample({ username: 'u', password: 'p' });
        assert.equal(t.status().status, 'ok', 'recovery clears the error');
    });
});
