'use strict';
/*
* Thermal radiometry adapter (Hikvision ISAPI).
*
* 只从设备官方测温接口读取辐射测温数据；绝不从伪彩/灰度像素推算温度。
* 设备凭据来自现场 cameras.db（不入 Git、不入日志）；认证失败进入退避阶梯，
* 避免把设备 Web 接口打爆。所有对外输出只含规范化温度结构与状态，不含凭据。
*
* 对外契约（snapshot()）：
*   { source:'thermal', cameraId, status: ok|stale|unavailable|unauthorized|not_supported|error,
*     reason?, unit:'°C', measurementMode:'radiometric',
*     capturedAt, receivedAt, sceneTemperature:{min,max,mean}|null,
*     hotspots:[{id,point|region,peakC,meanC?}], trend:[{capturedAt,min,max,mean}],
*     quality:{ageMs,valid}, samples }
*/
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    intervalMs: 5000,
    timeoutMs: 4000,
    maxHotspots: 6,
    // 失败退避阶梯；末级 30 分钟：认证失败可能触发海康“非法登录锁定”（默认锁 30 分钟），
    // 高频重试会永久续锁，因此连续失败后把重试间隔拉长到锁定窗口之外。
    backoffSteps: [5000, 15000, 60000, 300000, 1800000],
    staleAfterMs: 15000,
    // R04：设备时间戳重复/停滞的容忍窗口。超过该墙钟时间仍未推进即判为冻结；
    // 容忍窗口内的重复只表示“测量未推进”，不重复计为新样本。
    deviceUpdateToleranceMs: 20000,
    // R04：设备重启/合法重新校时的重同步边界。倒退幅度达到该阈值才进入候选，
    // 且需连续 clockResetConfirmSamples 次“从新基点单调推进”才重定高水位；
    // 小幅倒退（含旧时间往返重放）一律视为异常，不推进高水位。
    clockResetMinMs: 60000,
    clockResetConfirmSamples: 3,
    // R02：设备元数据单位的有界有效期；只有响应确实携带单位时才续期，
    // 超过该窗口未被再次确认的单位不得继续沿用。
    metaUnitTtlMs: 600000,
    // 实测（DS-2TD2637T-10/Q, V5.5.308）：/ISAPI/Thermometry/* 与 PICT/jpeg 不可用（403/400），
    // 机器可读的真实温度来自 /ISAPI/Thermal/TempHumi（设备测温模块，带时间戳）；
    // basicParam 提供单位与量程元数据。逐像素/ROI 温度仅厂商插件通道提供（本固件不开放 HTTP）。
    isapiPaths: ['/ISAPI/Thermal/TempHumi'],
    basicParamPath: '/ISAPI/Thermal/channels/2/thermometry/basicParam'
};

/* HTTP Digest（海康 ISAPI 常见 qop="auth"；手写避免新增依赖） */
function digestHeaders(challenge, method, uri, username, password) {
    const realm = (/"?realm"?\s*=\s*"([^"]*)"/.exec(challenge) || [])[1];
    const nonce = (/"?nonce"?\s*=\s*"([^"]*)"/.exec(challenge) || [])[1];
    const qop = (/"?qop"?\s*=\s*"([^"]*)"/.exec(challenge) || [])[1];
    if (!realm || !nonce) { return null; }
    const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
    const cnonce = crypto.randomBytes(8).toString('hex');
    if (qop && qop.includes('auth')) {
        const nc = '00000001';
        const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex');
        return { scheme: 'Digest', realm, nonce, qop: 'auth', nc, cnonce, response, uri };
    }
    const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
    return { scheme: 'Digest', realm, nonce, qop: null, nc: null, cnonce: null, response, uri };
}

function authorizationValue(h, username) {
    if (!h) { return null; }
    let v = `${h.scheme} username="${username}", realm="${h.realm}", nonce="${h.nonce}"`;
    if (h.qop) { v += `, uri="${h.uri}", qop=auth, nc=${h.nc}, cnonce="${h.cnonce}", response="${h.response}"`; }
    else { v += `, response="${h.response}"`; }
    return v;
}

/* 严格十进制解析：拒绝空白、缺失、非十进制（如 0x、NaN、Infinity）与非有限值；保留合法 0 与负值。 */
function parseDecimal(raw) {
    if (raw == null) { return null; }
    const text = String(raw).trim();
    if (text === '') { return null; }
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) { return null; }
    const v = Number(text);
    return Number.isFinite(v) ? v : null;
}

/* 数值：元素式 <Tag>12.3</Tag> 或属性式 <Tag value="12.3" unit="C"/>；空白/NaN/Inf 一律 null */
function readNumber(xml, tag) {
    let m = new RegExp(`<${tag}\\s+value="([^"]*)"`, 'i').exec(xml);
    if (!m) { m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml); }
    if (!m) { return null; }
    return parseDecimal(m[1]);
}
function readUnit(xml) {
    let m = /<temperatureUnit\s+value="([^"]+)"/i.exec(xml) || /unit="([CFKcfk])"/i.exec(xml);
    if (m) { return m[1]; }
    m = /<temperatureUnit>([^<]+)<\/temperatureUnit>/i.exec(xml);
    return m ? m[1] : null;
}

/*
* 解析 ISAPI Thermometry XML。海康实际响应同时存在两种形态：
*   A) <ThermometryUnit><Temperature value="18.5" unit="C"/><MaxTemperature value="31.2"/>...
*   B) <minTemperature>6.4</minTemperature>（部分固件）
* 热点：type=point（Point x/y + Temperature）与 type=region/polygon（Region + MaxTemperature）。
* 全部坐标已由设备归一化为 0..1；无效/缺失字段返回 null，由上层决定是否显示。
*/
function parseThermometryXml(xml) {
    const result = { temperatureUnit: readUnit(xml),
        min: readNumber(xml, 'minTemperature'), max: readNumber(xml, 'maxTemperature'),
        mean: readNumber(xml, 'averageTemperature'), hotspots: [] };
    if (result.max == null) { result.max = readNumber(xml, 'MaxTemperature'); }
    if (result.min == null) { result.min = readNumber(xml, 'MinTemperature'); }
    if (result.mean == null) { result.mean = readNumber(xml, 'Temperature'); }
    const unitRe = /<ThermometryUnit>([\s\S]*?)<\/ThermometryUnit>/gi;
    let m, id = 0;
    while ((m = unitRe.exec(xml))) {
        const block = m[1];
        const type = (/<type>([^<]+)<\/type>/i.exec(block) || [])[1] || 'unknown';
        const unit = readUnit(block) || result.temperatureUnit;
        const conv = v => toCelsius(v, unit);
        const spot = { id: 'roi-' + (++id), type };
        const px = readNumber(block, 'x'), py = readNumber(block, 'y');
        if (px != null && py != null) { spot.point = { x: px, y: py }; }
        const rx = readNumber(block, 'x'), rw = readNumber(block, 'width');
        if (type === 'region' || type === 'global') {
            const x = readNumber(block, 'X'), y = readNumber(block, 'Y');
            const w = readNumber(block, 'width'), h = readNumber(block, 'height');
            if (w != null && h != null) { spot.region = { x: x == null ? 0 : x, y: y == null ? 0 : y, w, h }; }
        }
        const peak = conv(readNumber(block, 'MaxTemperature') != null ? readNumber(block, 'MaxTemperature') : readNumber(block, 'Temperature'));
        const mean = conv(readNumber(block, 'averageTemperature') != null ? readNumber(block, 'averageTemperature') : readNumber(block, 'Temperature'));
        if (peak == null && mean == null) { continue; }
        spot.peakC = peak == null ? null : Math.round(peak * 10) / 10;
        spot.meanC = mean == null ? null : Math.round(mean * 10) / 10;
        result.hotspots.push(spot);
    }
    return result;
}

function toCelsius(value, unit) {
    if (value == null) { return null; }
    switch (String(unit || '').toLowerCase()) {
        case '': case 'c': case 'celsius': case 'centigrade': case 'degreecentigrade': return value;
        case 'f': case 'fahrenheit': return (value - 32) * 5 / 9;
        case 'k': case 'kelvin': return value - 273.15;
        default: return null;   // 未知单位一律拒绝显示，不得猜
    }
}

/* TempHumi（设备测温模块）响应解析：XML 内含 id/currentTime/temperature。 */
function parseTempHumiXml(xml) {
    const m = /<TempHumi[\s>]([\s\S]*?)<\/TempHumi>/.exec(xml);
    if (!m) { return null; }
    const block = m[1];
    const id = (/<id>([^<]+)<\/id>/.exec(block) || [])[1] || null;
    const currentTime = (/<currentTime>([^<]+)<\/currentTime>/.exec(block) || [])[1] || null;
    const raw = (/<temperature>([^<]*)<\/temperature>/.exec(block) || [])[1];
    // R03：空白/缺失/非法文本必须拒绝，不能经 Number() 变成有效的 0；合法 0 与负值保留。
    const value = parseDecimal(raw);
    if (value == null) { return null; }
    return { id, currentTime, temperature: value };
}

/* basicParam（���位/量程元数据）解析。 */
function parseBasicParamXml(xml) {
    const unit = (/<temperatureUnit>([^<]+)<\/temperatureUnit>/.exec(xml) || [])[1] || null;
    const range = (/<temperatureRange>([^<]+)<\/temperatureRange>/.exec(xml) || [])[1] || null;
    return { unit, range };
}

class Thermometry {
    constructor(options) {
        this.options = Object.assign({}, DEFAULTS, options);
        this.latest = null;
        this.lastError = null;
        this.consecutiveFailures = 0;
        this.timer = null;
        this.working = false;
        this.samples = [];
        this.stopped = false;
        this.knownUnit = null;        // 设备确认过的温度单位（只由携带单位的响应确认）
        this.unitConfirmedAt = 0;     // 该单位最近一次被设备响应确认的墙钟时间（用于有界失效）
        this.metaCamera = null;       // 该单位/量程所属设备；换设备一律丢弃，不继承
        this.knownRange = null;       // 量程原始值
        this.rangeUnit = null;        // 量程表达所用单位（可能与换算后温度单位不同）
        this.maxDeviceTimeMs = null;  // 已接受测量的设备时间高水位（只增不减）
        this.lastAdvanceAt = null;    // 高水位最近一次推进的墙钟时间（用于冻结判定）
        this.resetCandidate = null;   // 可能的设备时钟重置候选 { value, count }
    }

    setFetcher(fetcher) { this.fetcher = fetcher; }   // 测试注入：(path, authHeader) => {status, headers, body}

    _request(path, authHeader) {
        if (this.fetcher) { return this.fetcher(path, authHeader); }
        return new Promise(resolve => {
            const req = http.get({ host: this.options.host, port: this.options.httpPort || 80, path,
                headers: authHeader ? { Authorization: authHeader } : {}, timeout: this.options.timeoutMs }, res => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            });
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, errorType: 'timeout' }); });
            req.on('error', err => resolve({ status: 0, errorType: err.code || 'network' }));
        });
    }

    async _fetchWithAuth(path, username, password) {
        const first = await this._request(path, null);
        if (first.status !== 401 || !first.headers || !first.headers['www-authenticate']) { return first; }
        // 该设备（实测）要求 Digest 的 uri 字段使用完整 URL 而非路径，否则一律 401。
        const fullUri = 'http://' + this.options.host + ':' + (this.options.httpPort || 80) + path;
        const h = digestHeaders(String(first.headers['www-authenticate']), 'GET', fullUri, username, password);
        if (!h) { return first; }
        return this._request(path, authorizationValue(h, username));
    }

    /* 设备读取 + 规范化。credentials: { username, password }
    * 主源：/ISAPI/Thermal/TempHumi（设备测温模块实时温度，带设备时间戳）；
    * 元数据：basicParam（单位/量程）。两者均为设备直读值，绝不做像素估算。 */
    async sample(credentials) {
        let ok = false;
        for (const p of this.options.isapiPaths) {
            const res = await this._fetchWithAuth(p, credentials && credentials.username, credentials && credentials.password);
            if (res.status === 200 && res.body) {
                const parsed = parseTempHumiXml(res.body);
                if (!parsed) { this.lastError = { type: 'no_valid_values' }; continue; }
                const receivedAt = Date.now();
                // R02：温度单位必须由设备元数据决定，主采样流程不得写死摄氏，否则与 unitSource 自相矛盾。
                const meta = await this._readMeta(credentials, receivedAt);
                const unitUsed = meta && meta.unit ? meta.unit : null;
                const celsius = toCelsius(parsed.temperature, unitUsed);
                if (unitUsed == null || celsius == null) { this.lastError = { type: 'unknown_unit' }; continue; }
                // R04：区分接收年龄、测量推进状态与设备时钟质量。
                const time = this._assessDeviceTime(parsed.currentTime, receivedAt);
                this.latest = {
                    source: 'thermal', cameraId: this.options.cameraId || (this.options.host + ':thermal'),
                    measurementMode: 'device-sensor', unit: '°C', unitSource: unitUsed,
                    unitAgeMs: this.unitConfirmedAt ? (receivedAt - this.unitConfirmedAt) : null,
                    capturedAt: time.capturedAt, receivedAt, clockSource: time.clockSource,
                    timeStatus: time.timeStatus, deviceTime: parsed.currentTime,
                    deviceTemperature: Math.round(celsius * 10) / 10,
                    tempHumiChannel: parsed.id,
                    range: (meta && meta.range) || null, rangeUnit: (meta && meta.rangeUnit) || null,
                    sceneTemperature: null, hotspots: [],
                    roiNote: 'ROI 级实时温度需厂商插件数据通道（本固件未开放 HTTP 接口）；已启用点测温规则由设备自身测量'
                };
                // 只有测量确实推进（或无法判定设备时间）才计入趋势；重复/倒退时间戳不重复追加为新测量。
                if (time.appendSample) {
                    this.samples.push(this.latest);
                    if (this.samples.length > 240) { this.samples.shift(); }
                }
                this.lastError = null; ok = true; break;
            }
            if (res.status === 401 || res.status === 403) { this.lastError = { type: 'unauthorized', code: res.status }; break; }
            if (res.status === 404 || res.status === 405) { this.lastError = { type: 'not_supported', code: res.status }; break; }
            this.lastError = { type: res.errorType || 'http_error', code: res.status || undefined };
        }
        this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1;
        return ok;
    }

    /* 元数据（单位/量程）：单位有界有效期，且只与当前设备绑定。
    * 只有设备响应确实携带单位时才确认/续期；只带量程的响应不确认也不续期单位。
    * 单位过期或换设备时返回 null，由 sample() 给出“未知单位”的明确状态。 */
    async _readMeta(credentials, now) {
        // 换设备（cameraId 变化）一律丢弃旧单位/量程，绝不继承。
        const camera = this.options.cameraId || this.options.host || null;
        if (this.metaCamera && camera && camera !== this.metaCamera) {
            this.knownUnit = null; this.unitConfirmedAt = 0; this.knownRange = null; this.rangeUnit = null;
        }
        const view = () => ({ unit: this._currentUnit(now), range: this.knownRange, rangeUnit: this.rangeUnit, at: this.unitConfirmedAt });
        // 单位仍在有效期内：复用（复用不等于“刚刚重新确认”，unitConfirmedAt 不刷新）。
        if (this.knownUnit && this.unitConfirmedAt && now - this.unitConfirmedAt <= this.options.metaUnitTtlMs) { return view(); }
        try {
            const bp = await this._fetchWithAuth(this.options.basicParamPath, credentials.username, credentials.password);
            if (bp.status === 200 && bp.body) {
                const m = parseBasicParamXml(bp.body);
                if (m && m.unit) {
                    // 只有真实携带单位才确认并续期。
                    this.knownUnit = m.unit;
                    this.unitConfirmedAt = now;
                    this.metaCamera = camera;
                    if (m.range) { this.knownRange = m.range; this.rangeUnit = m.unit; }
                }
                // 只带量程、无单位：不确认也不续期单位；无单位可归属时量程同样不采用。
            }
        } catch (_) { /* 元数据不可用：仅沿用“未过期”的已确认单位，绝不擅自猜摄氏 */ }
        return view();
    }

    /* 返回当前仍有效的单位；超过有效期的单位不再沿用（null）。 */
    _currentUnit(now) {
        if (!this.knownUnit) { return null; }
        if (!this.unitConfirmedAt || now - this.unitConfirmedAt > this.options.metaUnitTtlMs) { return null; }
        return this.knownUnit;
    }

    /* R04：设备时间评估。返回采集时刻、时钟来源、时间推进状态，以及是否应计入新样本。 */
    _assessDeviceTime(rawTime, receivedAt) {
        if (rawTime == null || String(rawTime).trim() === '') {
            return { capturedAt: receivedAt, clockSource: 'server-receive', timeStatus: 'unknown', appendSample: true };
        }
        const parsedAt = Date.parse(rawTime);
        if (!Number.isFinite(parsedAt)) {
            // 有设备时间字段但无法解析：采集时刻回退服务器时间，来源如实标为服务器接收；
            // 时间无效，不作为新的有效测量（不追加样本、不计为当前有效温度）。
            return { capturedAt: receivedAt, clockSource: 'server-receive', timeStatus: 'invalid', appendSample: false };
        }
        const max = this.maxDeviceTimeMs;
        if (max == null) {
            // 首次采样：建立高水位。
            this.maxDeviceTimeMs = parsedAt; this.lastAdvanceAt = receivedAt; this.resetCandidate = null;
            return { capturedAt: parsedAt, clockSource: 'device', timeStatus: 'ok', appendSample: true };
        }
        if (parsedAt > max) {
            // 真实推进：抬高高水位（只增不减），清空重置候选。
            this.maxDeviceTimeMs = parsedAt; this.lastAdvanceAt = receivedAt; this.resetCandidate = null;
            return { capturedAt: parsedAt, clockSource: 'device', timeStatus: 'ok', appendSample: true };
        }
        if (parsedAt === max) {
            // 与高水位相同：未推进。绝不追加样本、绝不抬高高水位；按容忍窗口判 repeating/frozen。
            const status = (receivedAt - (this.lastAdvanceAt || receivedAt) > this.options.deviceUpdateToleranceMs) ? 'frozen' : 'repeating';
            this.resetCandidate = null;
            return { capturedAt: parsedAt, clockSource: 'device', timeStatus: status, appendSample: false };
        }
        // 低于高水位。
        const backwardMs = max - parsedAt;
        if (backwardMs >= this.options.clockResetMinMs) {
            // 可能的设备重启/合法重新校时：需连续“从新基点单调推进”若干次才重定高水位。
            const cand = this.resetCandidate;
            if (cand && parsedAt > cand.value) {
                cand.value = parsedAt; cand.count += 1;
                if (cand.count >= this.options.clockResetConfirmSamples) {
                    this.maxDeviceTimeMs = parsedAt; this.lastAdvanceAt = receivedAt; this.resetCandidate = null;
                    return { capturedAt: parsedAt, clockSource: 'device', timeStatus: 'resynced', appendSample: true };
                }
            } else {
                this.resetCandidate = { value: parsedAt, count: 1 };
            }
            return { capturedAt: parsedAt, clockSource: 'device', timeStatus: 'resync-pending', appendSample: false };
        }
        // 小幅倒退（含旧时间往返重放）：异常，不推进高水位，不追加样本。
        this.resetCandidate = null;
        return { capturedAt: parsedAt, clockSource: 'device', timeStatus: 'backward', appendSample: false };
    }

    /* 对外状态：绝不含凭据/URL 明文。 */
    status() {
        const cameraId = this.options.cameraId || (this.options.host ? this.options.host + ':thermal' : null);
        if (!this.latest) {
            return { source: 'thermal', cameraId, unit: '°C', measurementMode: 'device-sensor',
                status: this.lastError ? this.lastError.type : 'unavailable',
                reason: this._reasonText(), sceneTemperature: null, hotspots: [], trend: [],
                quality: { ageMs: null, valid: false }, samples: 0 };
        }
        // 数据年龄用服务端接收时刻计算：设备时钟可能与服务器有偏差（实测偏差约 10 分钟），
        // 用设备时间算年龄会出现负值；设备时间仅用于展示采样时刻。
        const ageMs = Date.now() - this.latest.receivedAt;
        const trend = this.trend();
        const timeStatus = this.latest.timeStatus || 'ok';
        // R05：最近一次读取失败必须压过“最后一次成功”，但仍保留最后有效温度及其年龄供参考。
        if (this.lastError) {
            return Object.assign({}, this.latest, {
                status: this.lastError.type,
                reason: this._reasonText(),
                timeStatus,
                quality: { ageMs, valid: false, lastValid: true },
                samples: this.samples.length,
                trend
            });
        }
        const timeAnomaly = timeStatus === 'frozen' || timeStatus === 'backward'
            || timeStatus === 'invalid' || timeStatus === 'resync-pending';
        const stale = ageMs > this.options.staleAfterMs || timeAnomaly;
        return Object.assign({}, this.latest, {
            status: stale ? 'stale' : 'ok',
            reason: stale ? this._staleReason(ageMs, timeStatus) : null,
            timeStatus,
            quality: { ageMs, valid: !stale, lastValid: !stale },
            samples: this.samples.length,
            trend
        });
    }

    _staleReason(ageMs, timeStatus) {
        if (timeStatus === 'frozen') { return '设备时间戳长时间未推进（疑似采样冻结），不作为当前实测温度'; }
        if (timeStatus === 'backward') { return '设备时间戳倒退或旧时间重放，测量推进异常，不作为当前实测温度'; }
        if (timeStatus === 'resync-pending') { return '设备时间戳可疑下跳，正在确认是否为重启/校时，暂不作为当前实测温度'; }
        if (timeStatus === 'invalid') { return '设备时间无法解析，不作为当前实测温度'; }
        return `最近有效采样已过期（${Math.round(ageMs / 1000)} 秒前），不代表当前温度`;
    }
    _reasonText() {
        const map = {
            unauthorized: '设备测温接口认证被拒：需要具备 Web/ISAPI 权限的相机账号',
            not_supported: '设备未提供该测温接口（404/405）：型号可能不支持 ISAPI 测温',
            no_credentials: '未配置热像机 Web 凭据',
            no_valid_values: '设备响应中没有有效温度数值',
            unknown_unit: '设备未提供可识别的温度单位（元数据缺失/未知），不按摄氏显示',
            timeout: '设备测温接口超时',
            network: '设备测温接口网络不可达',
            http_error: '设备测温接口返回异常状态',
            adapter_error: '测温适配器内部错误',
            unavailable: '设备辐射测温接口尚未返回有效数据'
        };
        const t = this.lastError && this.lastError.type;
        return map[t] || (t ? `设备测温接口错误（${t}${this.lastError.code ? ' ' + this.lastError.code : ''}）` : map.unavailable);
    }

    trend(limit = 60) {
        return this.samples.slice(-limit).map(s => ({ capturedAt: s.capturedAt,
            temperature: s.deviceTemperature }));
    }

    _backoffMs() {
        if (!this.consecutiveFailures) { return this.options.intervalMs; }
        return this.options.backoffSteps[Math.min(this.consecutiveFailures - 1, this.options.backoffSteps.length - 1)];
    }

    start(credentialsProvider) {
        this.stopped = false;
        if (this.timer) { clearInterval(this.timer); }
        const tick = async () => {
            if (this.working || this.stopped) { return; }
            this.working = true;
            try {
                const credentials = credentialsProvider ? await credentialsProvider() : null;
                if (!credentials || !credentials.username) {
                    this.lastError = { type: 'no_credentials' };
                    this.consecutiveFailures++;
                } else {
                    await this.sample(credentials);
                }
            } catch (_) {
                this.lastError = { type: 'adapter_error' };
                this.consecutiveFailures++;
            } finally { this.working = false; }
            if (this.stopped) { return; }
            clearInterval(this.timer);
            this.timer = setInterval(tick, this._backoffMs());   // 失败退避；成功恢复正常周期
        };
        this.timer = setInterval(tick, this.options.intervalMs);
        tick();
        return Promise.resolve();
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        return Promise.resolve();
    }
}

/*
* create(runtime)：接入运行时。
* - 热像机选择：通过 runtime.cameraStorage.getCameras()（唯一合法的 cameras 域入口，A-04/D7）
*   取 vendor=hikvision 且（channel=2 或名称含“红外/thermal”）的行；只读 host/http_port/username/password，不写日志。
* - 可选 workDir/thermometry.json 覆盖 { host, httpPort, paths, intervalMs, cameraId }（不含凭据）。
* - deps 注入点仅供测试。
*/
function create(runtime, deps) {
    const settings = (runtime && runtime.settings) || {};
    const workDir = settings.workDir;
    const logger = (runtime && runtime.logger) || { info() {}, warn() {}, error() {} };
    const d = deps || {};
    const listCameras = d.listCameras || (() => Promise.resolve([]));
    const pickThermal = rows => (rows || []).find(r => r && r.vendor === 'hikvision' &&
        (r.channel === 2 || /红外|thermal/i.test(String(r.name || ''))));
    let override = {};
    try {
        const cfgFile = path.join(workDir, 'thermometry.json');
        if (fs.existsSync(cfgFile)) { override = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }
    } catch (err) { logger.warn('thermometry config unreadable: ' + err.code); }

    let cachedRow = null;
    const readCameraRow = async () => {
        // 每个采样周期重新读取：现场改相机配置后无需重启即可生效。
        try {
            const rows = await (runtime && runtime.cameraStorage ? Promise.resolve(runtime.cameraStorage.getCameras()) : listCameras());
            cachedRow = pickThermal(rows);
        } catch (_) { cachedRow = null; }
        return cachedRow;
    };
    const adapter = new Thermometry(Object.assign({}, { httpPort: 80 }, override));
    const credentialsProvider = async () => {
        const row = await readCameraRow();
        if (!row || !row.host || !row.username) { return null; }
        adapter.options.host = row.host;                       // 每周期跟随现场配置
        adapter.options.httpPort = row.http_port || 80;
        adapter.options.cameraId = row.name || (row.host + ':thermal');
        return { username: row.username, password: row.password };
    };
    adapter.start(credentialsProvider);
    logger.info('thermometry adapter started (camera config via cameraStorage)', true);
    return {
        snapshot: () => adapter.status(),
        stop: () => adapter.stop(),
        _adapter: adapter
    };
}

module.exports = { Thermometry, create, toCelsius, parseThermometryXml, parseTempHumiXml, parseBasicParamXml, digestHeaders, authorizationValue };
