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
});
