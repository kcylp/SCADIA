'use strict';
const fs = require('fs');
const path = require('path');
const storage = require('../storage/databases');
const { randomUUID } = require('crypto');
const scenes = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'T1'];
const kinds = { V1: ['doorentry'], V2: ['fall'], V3: ['smoking'], V4: ['helmet', 'nohelmet'],
    V5: ['crowding'], V6: ['restricted', 'loitering', 'wrongway', 'linecross'],
    V7: ['fire', 'smoke', 'blocked', 'blur', 'blackout', 'frozen'], T1: ['thermal_anomaly'] };
const problem = message => Object.assign(new Error(message), { code: 'AI_BAD_PAYLOAD' });

class SceneStore {
    constructor(workDir, imagesDir, onChange = () => {}) {
        this.onChange = onChange;
        this.workDir = workDir;
        this.imagesDir = imagesDir;
        this.db = storage.open(storage.resolveDbFile(workDir, 'scene-events'));
        this.ready = this.run('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, scene TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, ackAt INTEGER, ackBy TEXT)')
            .then(() => this.run('CREATE INDEX IF NOT EXISTS events_at ON events(at DESC)'))
            .then(() => this.run('CREATE TABLE IF NOT EXISTS scene_reviews (eventId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT \'pending\', attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, result TEXT, history TEXT NOT NULL DEFAULT \'[]\')'))
            .then(() => this.run('INSERT OR IGNORE INTO scene_reviews(eventId) SELECT id FROM events'))
            .then(() => this.run('CREATE INDEX IF NOT EXISTS scene_reviews_pending ON scene_reviews(status,nextAt,leaseUntil)'))
            .then(() => this.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)'))
            .then(() => this.run('CREATE TABLE IF NOT EXISTS scene_analysis (id TEXT PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL)'))
            .then(() => this.run("CREATE TABLE IF NOT EXISTS scene_deliveries (subscription TEXT NOT NULL,eventId TEXT NOT NULL,phase TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL,error TEXT,PRIMARY KEY(subscription,eventId,phase))"));
        this.claiming = Promise.resolve();
        this.ingesting = null;
    }
    run(sql, args = []) {
        return new Promise((resolve, reject) => this.db.run(sql, args, function (err) { err ? reject(err) : resolve(this.changes); }));
    }
    all(sql, args = []) {
        return new Promise((resolve, reject) => this.db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows)));
    }
    validate(event) {
        if (!event || !/^[a-f0-9]{32}$/.test(event.eventId || '') || !scenes.includes(event.sceneId) ||
            !kinds[event.sceneId]?.includes(event.kind) ||
            !Number.isSafeInteger(event.at) || event.at < 0 || event.at > Date.now() + 60000 ||
            typeof event.camera !== 'string' || !event.camera || event.camera.length > 128 ||
            event.source !== undefined && event.source !== (event.sceneId === 'T1' ? 'thermal' : 'visible') ||
            typeof event.trackId !== 'string' || event.trackId.length > 128 ||
            event.shot !== 'scene-' + event.eventId + '.jpg' ||
            typeof event.label !== 'string' || event.label.length > 200 ||
            typeof event.calibrationVersion !== 'string' || event.calibrationVersion.length > 128) {
            throw problem('Invalid scene event');
        }
        return { eventId: event.eventId, sceneId: event.sceneId, kind: event.kind, at: event.at,
            camera: event.camera, source: event.source, trackId: event.trackId, shot: event.shot, label: event.label,
            calibrationVersion: event.calibrationVersion, reviewStatus: 'pending',
            evidenceFrames: this.evidenceFrames(event),
            context: this.eventContext(event.context) };
    }
    evidenceFrames(event) {
        const frames = event.evidenceFrames || [{ file: event.shot, at: event.at }];
        if (!Array.isArray(frames) || frames.length < 1 || frames.length > 3 || frames.some(f =>
            !new RegExp('^scene-' + event.eventId + '(?:-[0-2])?\\.jpg$').test(f.file || '') ||
            !Number.isSafeInteger(f.at) || Math.abs(f.at - event.at) > 30000)) { throw problem('Invalid evidence frames'); }
        return frames.map(f => ({ file: f.file, at: f.at }));
    }
    eventContext(value) {
        if (!value) { return {}; }
        if (typeof value !== 'object' || Array.isArray(value)) { throw problem('Invalid event context'); }
        const out = {};
        for (const key of ['rule', 'model', 'frameId', 'sessionId', 'observation', 'temporalEvidence']) {
            if (value[key] !== undefined) { out[key] = value[key]; }
        }
        if (JSON.stringify(out).length > 4096) { throw problem('Event context exceeds limit'); }
        return out;
    }
    async ingest() {
        if (this.ingesting) { return this.ingesting; }
        this.ingesting = this.drain();
        try { await this.ingesting; } finally { this.ingesting = null; }
    }
    async drain() {
        await this.ready;
        const dir = path.join(this.workDir, 'scene-events');
        if (!fs.existsSync(dir)) { return; }
        const names = fs.readdirSync(dir).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).sort().slice(0, 200);
        for (const name of names) {
            const file = path.join(dir, name);
            let event;
            try {
                if (fs.statSync(file).size > 8192) { throw problem('Scene event exceeds limit'); }
                event = this.validate(JSON.parse(fs.readFileSync(file, 'utf8')));
            } catch (err) {
                if (err.code === 'ENOENT') { continue; }
                // Keep malformed evidence for investigation without retrying forever.
                fs.renameSync(file, file + '.rejected'); continue;
            }
            const inserted = await this.run('INSERT OR IGNORE INTO events(id,scene,kind,at,data) VALUES(?,?,?,?,?)',
                [event.eventId, event.sceneId, event.kind, event.at, JSON.stringify(event)]);
            await this.run('INSERT OR IGNORE INTO scene_reviews(eventId) VALUES(?)', [event.eventId]);
            // Commit precedes removal. A crash leaves the file replayable and idempotent.
            fs.unlinkSync(file);
            if (inserted) { this.onChange(); }
        }
    }
    readJson(name) {
        try { return JSON.parse(fs.readFileSync(path.join(this.imagesDir, name), 'utf8')); }
        catch (err) { if (err.code === 'ENOENT') { return null; } throw err; }
    }
    status() {
        const visible = this.readJson('ai-scenes.json'), thermal = this.readJson('ai-scenes-thermal.json');
        let reviews = null;
        try { reviews = JSON.parse(fs.readFileSync(path.join(this.workDir, 'scene-reviews.json'), 'utf8')); }
        catch (err) { if (err.code !== 'ENOENT') { throw err; } }
        const sanitize = source => source && ({ camera: source.camera, updatedAt: source.updatedAt,
            frameId: source.frameId, sessionId: source.sessionId, imageWidth: source.imageWidth,
            imageHeight: source.imageHeight, inferenceMs: source.inferenceMs,
            model: source.model, streamKind: source.streamKind,
            delivery: source.delivery, appliedCalibrationVersion: source.appliedCalibrationVersion,
            appliedRulesVersion: source.appliedRulesVersion, calibrationError: source.calibrationError,
            entryGate: source.entryGate,
            temperature: source.temperature === undefined ? undefined : (source.temperature && typeof source.temperature === 'object' ? source.temperature : undefined),
            scenes: source.scenes, detections: source.detections });
        return { visible: sanitize(visible), thermal: sanitize(thermal), reviews, now: Date.now() };
    }
    filters(query = {}) {
        // 缺省（未传）才是 V1；显式空字符串是无效选择，必须报错而不是猜成 V1。
        const raw = query.scenes ?? query.scene;
        const selected = raw == null ? 'V1' : raw;
        const ids = selected === 'all' ? scenes : (Array.isArray(selected) ? selected : String(selected).split(','));
        if (!ids.length || ids.some(id => !scenes.includes(id))) { throw problem('Unknown scene'); }
        const from = query.from == null ? 0 : Number(query.from), to = query.to == null ? Date.now() : Number(query.to);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) { throw problem('Invalid scene time range'); }
        const terms = ['e.scene IN (' + ids.map(() => '?').join(',') + ')', 'e.at>=?', 'e.at<=?'];
        const args = [...ids, from, to];
        for (const [key, column, allowed] of [['source', "COALESCE(json_extract(e.data,'$.source'),CASE WHEN e.scene='T1' THEN 'thermal' ELSE 'visible' END)", ['visible', 'thermal']],
            ['reviewStatus', "COALESCE(r.status,'pending')", ['pending', 'running', 'completed', 'failed', 'timeout', 'unavailable']],
            ['verdict', "json_extract(r.result,'$.verdict')", ['支持', '不支持', '证据不足']]]) {
            if (query[key] != null && query[key] !== '') {
                if (!allowed.includes(query[key])) { throw problem('Invalid ' + key); }
                terms.push(column + '=?'); args.push(query[key]);
            }
        }
        if (query.kind) {
            if (!ids.some(id => kinds[id].includes(query.kind))) { throw problem('Invalid event kind'); }
            terms.push('e.kind=?'); args.push(query.kind);
        }
        if (query.camera) {
            if (typeof query.camera !== 'string' || query.camera.length > 128) { throw problem('Invalid camera'); }
            terms.push("json_extract(e.data,'$.camera')=?"); args.push(query.camera);
        }
        if (query.eventId) {
            if (!/^[a-f0-9]{32}$/.test(query.eventId)) { throw problem('Invalid event id'); }
            terms.push('e.id=?'); args.push(query.eventId);
        }
        if (query.acknowledged != null && query.acknowledged !== '') {
            if (!['true', 'false', true, false].includes(query.acknowledged)) { throw problem('Invalid acknowledgement filter'); }
            terms.push('e.ackAt IS ' + (String(query.acknowledged) === 'true' ? 'NOT NULL' : 'NULL'));
        }
        return { where: terms.join(' AND '), args, ids: [...new Set(ids)], from, to };
    }
    async aggregate(query = {}) {
        await this.ingest();
        const filter = this.filters(query), generatedAt = Date.now();
        const join = ' FROM events e LEFT JOIN scene_reviews r ON r.eventId=e.id WHERE ' + filter.where;
        const snapshot = await this.all("WITH matched AS (SELECT e.at,e.scene AS sceneId,e.kind,COALESCE(r.status,'pending') AS reviewStatus,json_extract(r.result,'$.verdict') AS verdict,CASE WHEN e.ackAt IS NULL THEN 0 ELSE 1 END AS acknowledged" + join + ") SELECT 'group' AS type,NULL AS at,sceneId,kind,reviewStatus,verdict,acknowledged,COUNT(*) AS count FROM matched GROUP BY 3,4,5,6,7 UNION ALL SELECT 'trend',CAST(at/3600000 AS INTEGER)*3600000,sceneId,NULL,NULL,NULL,NULL,COUNT(*) FROM matched GROUP BY 2,3", filter.args);
        const groups = snapshot.filter(r => r.type === 'group').map(({type, at, ...row}) => row);
        const trend = snapshot.filter(r => r.type === 'trend').map(r => ({ at: r.at, sceneId: r.sceneId, count: r.count })).sort((a,b) => a.at-b.at);
        return { count: groups.reduce((sum, g) => sum + g.count, 0), groups, trend,
            window: { from: filter.from, to: filter.to, endInclusive: true }, scenes: filter.ids,
            generatedAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, bucketMs: 3600000,
            meaning: '候选事件数，非独立事故数；知晓不等于恢复，复核完成不等于支持' };
    }
    async exportEvents(query = {}) {
        await this.ingest();
        const filter = this.filters(query), generatedAt = Date.now();
        // One SELECT provides a consistent evidence snapshot while ingestion and review continue.
        const snapshot = await this.all('SELECT e.data,e.ackAt,e.ackBy,r.status,r.result,r.history FROM events e LEFT JOIN scene_reviews r ON r.eventId=e.id WHERE ' + filter.where + ' ORDER BY e.at DESC,e.id DESC LIMIT 100001', filter.args);
        if (snapshot.length > 100000) { throw problem('Export exceeds 100000 events; narrow the time window'); }
        const rows = snapshot.map(row => ({ ...JSON.parse(row.data), ackAt: row.ackAt, ackBy: row.ackBy,
            reviewStatus: row.status || 'pending', review: row.result ? JSON.parse(row.result) : null,
            reviewHistory: row.history ? JSON.parse(row.history) : [] }));
        const groups = new Map(), trend = new Map();
        for (const row of rows) {
            const group = { sceneId: row.sceneId, kind: row.kind, reviewStatus: row.reviewStatus,
                verdict: row.review?.verdict || null, acknowledged: row.ackAt == null ? 0 : 1 };
            const key = JSON.stringify(group), bucket = Math.floor(row.at / 3600000) * 3600000, tk = row.sceneId + ':' + bucket;
            if (!groups.has(key)) { groups.set(key, { ...group, count: 0 }); }
            groups.get(key).count++;
            if (!trend.has(tk)) { trend.set(tk, { at: bucket, sceneId: row.sceneId, count: 0 }); }
            trend.get(tk).count++;
        }
        return { count: rows.length, groups: [...groups.values()], trend: [...trend.values()].sort((a,b) => a.at-b.at),
            window: { from: filter.from, to: filter.to, endInclusive: true }, scenes: filter.ids, generatedAt,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, bucketMs: 3600000,
            rows, exportedCount: rows.length, truncated: false };
    }
    async list(query = {}) {
        await this.ingest();
        const pageNumber = (value, fallback) => value == null || value === '' ? fallback : Number(value);
        const requestedLimit = pageNumber(query.limit, 30), requestedOffset = pageNumber(query.offset, 0);
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || !Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw problem('Invalid page');
        const limit = Math.min(100, requestedLimit), offset = Math.min(1000000, requestedOffset);
        const filter = this.filters(query), { where, args } = filter;
        const join = ' FROM events e LEFT JOIN scene_reviews r ON r.eventId=e.id WHERE ';
        const snapshot = await this.all('WITH matched AS (SELECT e.id,e.at,e.data,e.ackAt,e.ackBy,r.status,r.result,r.history' + join + where +
            ') SELECT page.*,totals.count FROM (SELECT COUNT(*) AS count FROM matched) totals LEFT JOIN (SELECT * FROM matched ORDER BY at DESC,id DESC LIMIT ? OFFSET ?) page ON 1=1', [...args, limit, offset]);
        const rows = snapshot.filter(row => row.data != null), count = snapshot[0].count;
        const counters = this.readJson('ai-counts.json') || {};
        const clearedAt = Math.max(0, Number(counters.clearedAt) || 0);
        const date = new Date(); date.setHours(0, 0, 0, 0);
        const stats = await this.all('SELECT COUNT(*) AS total, COALESCE(SUM(at>=?),0) AS today FROM events WHERE scene IN (' + filter.ids.map(() => '?').join(',') + ') AND at>=?', [Math.max(date.getTime(), clearedAt), ...filter.ids, clearedAt]);
        return { rows: rows.map(row => {
            const event = JSON.parse(row.data);
            return { ...event, ackAt: row.ackAt, ackBy: row.ackBy,
                reviewStatus: row.status || 'pending', review: row.result ? JSON.parse(row.result) : null,
                reviewHistory: row.history ? JSON.parse(row.history) : [] };
        }),
            count, generatedAt: Date.now(), offset, limit, window: { from: filter.from, to: filter.to, endInclusive: true },
            stats: { ...stats[0], filtered: count, clearedAt, scope: 'today_and_since_clear_not_filtered_window', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    }
    async getEvent(id) {
        await this.ingest();
        if (!/^[a-f0-9]{32}$/.test(id)) { throw problem('Invalid event id'); }
        const rows = await this.all('SELECT e.data,e.ackAt,e.ackBy,r.status,r.result FROM events e LEFT JOIN scene_reviews r ON r.eventId=e.id WHERE e.id=?', [id]);
        if (!rows.length) { throw Object.assign(new Error('Event not found'), { code: 'CAM_NOT_FOUND' }); }
        const row = rows[0];
        return { ...JSON.parse(row.data), ackAt: row.ackAt, ackBy: row.ackBy,
            reviewStatus: row.status || 'pending', review: row.result ? JSON.parse(row.result) : null };
    }
    async alarmEvents(query = {}) {
        await this.ingest();
        const from = query.start == null ? 0 : Number(query.start);
        const to = query.end == null ? Number.MAX_SAFE_INTEGER : Number(query.end);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) { throw problem('Invalid alarm time range'); }
        const rows = await this.all('SELECT e.data,e.ackAt,e.ackBy,r.status,r.result FROM events e LEFT JOIN scene_reviews r ON r.eventId=e.id WHERE e.at>=? AND e.at<=?' +
            (query.current ? ' AND e.ackAt IS NULL' : '') + ' ORDER BY e.at DESC,e.id DESC', [from, to]);
        return rows.map(row => ({ ...JSON.parse(row.data), ackAt: row.ackAt, ackBy: row.ackBy,
            reviewStatus: row.status || 'pending', review: row.result ? JSON.parse(row.result) : null }));
    }
    async saveAnalysis(actor, data) {
        await this.ready;
        const id = randomUUID(), at = Date.now();
        await this.run('INSERT INTO scene_analysis(id,at,actor,data) VALUES(?,?,?,?)', [id, at, actor, JSON.stringify(data)]);
        return { analysisId: id, savedAt: at };
    }
    async analysisHistory(id) {
        await this.ready;
        if (id && !/^[a-f0-9-]{36}$/.test(id)) { throw problem('Invalid analysis id'); }
        const rows = id ? await this.all('SELECT * FROM scene_analysis WHERE id=?', [id])
            : await this.all('SELECT id,at,actor,json_extract(data,\'$.intent\') AS intent FROM scene_analysis ORDER BY at DESC LIMIT 100');
        return rows.map(row => row.data ? { id: row.id, at: row.at, actor: row.actor, result: JSON.parse(row.data) } : row);
    }
    async deliveries() {
        await this.ready;
        return this.all('SELECT subscription,eventId,phase,status,attempts,updatedAt,error FROM scene_deliveries ORDER BY updatedAt DESC LIMIT 100');
    }
    claimReview() {
        const claim = async () => {
            await this.ingest();
            const lease = randomUUID(), now = Date.now();
            await this.run(`UPDATE scene_reviews SET status='running',attempts=attempts+1,lease=?,leaseUntil=?
                WHERE eventId=(SELECT r.eventId FROM scene_reviews r JOIN events e ON e.id=r.eventId
                WHERE ((r.status='pending' AND r.nextAt<=?) OR (r.status='running' AND r.leaseUntil<?))
                ORDER BY e.at,e.id LIMIT 1)`, [lease, now + 90000, now, now]);
            const rows = await this.all('SELECT e.data,r.lease,r.attempts FROM scene_reviews r JOIN events e ON e.id=r.eventId WHERE r.lease=?', [lease]);
            return rows.length ? { event: JSON.parse(rows[0].data), lease, attempts: rows[0].attempts } : null;
        };
        const result = this.claiming.then(claim);
        this.claiming = result.catch(() => {});
        return result;
    }
    async finishReview(id, body) {
        await this.ready;
        const result = body?.result;
        if (!/^[a-f0-9]{32}$/.test(id) || typeof body?.lease !== 'string' ||
            !result || !['completed', 'failed', 'timeout', 'unavailable'].includes(result.reviewStatus) ||
            (result.reviewStatus === 'completed' && !['支持', '不支持', '证据不足'].includes(result.verdict))) { throw problem('Invalid review result'); }
        if ((result.reviewProtocol !== undefined && result.reviewProtocol !== 2) ||
            (result.observation !== undefined && !['present','absent','unclear'].includes(result.observation)) ||
            (result.peopleCount != null && (!Number.isInteger(result.peopleCount) || result.peopleCount < 0 || result.peopleCount > 1000)) ||
            (result.errorStage !== undefined && !['generate','validate'].includes(result.errorStage))) { throw problem('Invalid review diagnostics'); }
        if (result.input !== undefined && (!result.input || typeof result.input !== 'object' || Array.isArray(result.input) ||
            Object.keys(result.input).some(k=>!['imageCount','imageGrid','inputTokens'].includes(k)) ||
            (result.input.imageCount !== undefined && (!Number.isInteger(result.input.imageCount) || result.input.imageCount < 1 || result.input.imageCount > 3)) ||
            (result.input.inputTokens !== undefined && (!Number.isSafeInteger(result.input.inputTokens) || result.input.inputTokens < 0)) ||
            (result.input.imageGrid !== undefined && (!Array.isArray(result.input.imageGrid) || result.input.imageGrid.length > 3 ||
                result.input.imageGrid.some(g=>!Array.isArray(g) || g.length !== 3 || g.some(n=>!Number.isSafeInteger(n) || n < 1)))))) { throw problem('Invalid review input diagnostics'); }
        if (result.generation !== undefined && (!result.generation || typeof result.generation !== 'object' || Array.isArray(result.generation) ||
            Object.keys(result.generation).some(k=>!['generatedTokens','finished','limit'].includes(k)) ||
            (result.generation.generatedTokens !== undefined && (!Number.isInteger(result.generation.generatedTokens) || result.generation.generatedTokens < 0 || result.generation.generatedTokens > 512)) ||
            (result.generation.finished !== undefined && typeof result.generation.finished !== 'boolean') ||
            (result.generation.limit != null && !['TOKEN_LIMIT','GENERATION_TIME_LIMIT'].includes(result.generation.limit)))) { throw problem('Invalid review generation diagnostics'); }
        const safe = {};
        for (const key of ['reviewStatus', 'verdict', 'text', 'limitations', 'errorCode', 'generationMs', 'frameAt', 'modelVersion', 'retryable',
            'reviewProtocol', 'observation', 'peopleCount', 'input', 'generation', 'errorStage']) {
            if (result[key] !== undefined) { safe[key] = result[key]; }
        }
        if (JSON.stringify(safe).length > 4096) { throw problem('Review exceeds limit'); }
        const rows = await this.all('SELECT * FROM scene_reviews WHERE eventId=? AND lease=? AND status=\'running\'', [id, body.lease]);
        if (!rows.length) { throw problem('Review lease expired or already completed'); }
        safe.reviewedAt = Date.now();
        const row = rows[0], history = JSON.parse(row.history);
        history.push(safe);
        const retry = safe.reviewStatus !== 'completed' && safe.retryable === true && row.attempts < 3;
        const changed = await this.run('UPDATE scene_reviews SET status=?,result=?,history=?,nextAt=?,lease=NULL,leaseUntil=0 WHERE eventId=? AND lease=?',
            [retry ? 'pending' : safe.reviewStatus, JSON.stringify(safe), JSON.stringify(history), Date.now() + 10000 * row.attempts, id, body.lease]);
        if (!changed) { throw problem('Review lease changed'); }
        return { eventId: id, reviewStatus: retry ? 'pending' : safe.reviewStatus };
    }
    async acknowledge(id, user) {
        await this.ingest();
        if (!/^[a-f0-9]{32}$/.test(id)) { throw problem('Invalid event id'); }
        const found = await this.all('SELECT id FROM events WHERE id=?', [id]);
        if (!found.length) { throw Object.assign(new Error('Event not found'), { code: 'CAM_NOT_FOUND' }); }
        const changed = await this.run('UPDATE events SET ackAt=?,ackBy=? WHERE id=? AND ackAt IS NULL', [Date.now(), user, id]);
        if (changed) { this.onChange(); }
        const rows = await this.all('SELECT ackAt,ackBy FROM events WHERE id=?', [id]);
        return { eventId: id, ...rows[0] };
    }
    start(onError) {
        if (this.timer) { return; }
        const tick = () => this.ingest().catch(onError);
        this.timer = setInterval(tick, 1000); this.timer.unref(); tick();
    }
    async close() {
        clearInterval(this.timer);
        if (this.ingesting) { await this.ingesting; }
        return new Promise((resolve, reject) => this.db.close(err => err ? reject(err) : resolve()));
    }
}
module.exports = { SceneStore };
