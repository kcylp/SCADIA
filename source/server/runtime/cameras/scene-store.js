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
    constructor(workDir, imagesDir) {
        this.workDir = workDir;
        this.imagesDir = imagesDir;
        this.db = storage.open(storage.resolveDbFile(workDir, 'scene-events'));
        this.ready = this.run('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, scene TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, ackAt INTEGER, ackBy TEXT)')
            .then(() => this.run('CREATE INDEX IF NOT EXISTS events_at ON events(at DESC)'))
            .then(() => this.run('CREATE TABLE IF NOT EXISTS scene_reviews (eventId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT \'pending\', attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, result TEXT, history TEXT NOT NULL DEFAULT \'[]\')'))
            .then(() => this.run('INSERT OR IGNORE INTO scene_reviews(eventId) SELECT id FROM events'))
            .then(() => this.run('CREATE INDEX IF NOT EXISTS scene_reviews_pending ON scene_reviews(status,nextAt,leaseUntil)'));
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
            typeof event.camera !== 'string' || event.camera.length > 128 ||
            typeof event.trackId !== 'string' || event.trackId.length > 128 ||
            !/^scene-[a-f0-9]{32}\.jpg$/.test(event.shot || '') ||
            typeof event.label !== 'string' || event.label.length > 200 ||
            typeof event.calibrationVersion !== 'string' || event.calibrationVersion.length > 128) {
            throw problem('Invalid scene event');
        }
        return { eventId: event.eventId, sceneId: event.sceneId, kind: event.kind, at: event.at,
            camera: event.camera, trackId: event.trackId, shot: event.shot, label: event.label,
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
            await this.run('INSERT OR IGNORE INTO events(id,scene,kind,at,data) VALUES(?,?,?,?,?)',
                [event.eventId, event.sceneId, event.kind, event.at, JSON.stringify(event)]);
            await this.run('INSERT OR IGNORE INTO scene_reviews(eventId) VALUES(?)', [event.eventId]);
            // Commit precedes removal. A crash leaves the file replayable and idempotent.
            fs.unlinkSync(file);
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
            scenes: source.scenes, detections: source.detections });
        return { visible: sanitize(visible), thermal: sanitize(thermal), reviews, now: Date.now() };
    }
    async list(query = {}) {
        await this.ingest();
        const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
        const offset = Math.max(0, Math.min(1000000, Math.floor(Number(query.offset) || 0)));
        const scene = query.scene || 'V1';
        if (!scenes.includes(scene)) { throw problem('Unknown scene'); }
        const from = Math.max(0, Number(query.from) || 0), to = Math.max(from, Number(query.to) || Date.now());
        const where = 'scene=? AND at>=? AND at<=?', args = [scene, from, to];
        const rows = await this.all('SELECT data,ackAt,ackBy FROM events WHERE ' + where + ' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?', [...args, limit, offset]);
        const reviewRows = rows.length ? await this.all('SELECT * FROM scene_reviews WHERE eventId IN (' + rows.map(() => '?').join(',') + ')', rows.map(row => JSON.parse(row.data).eventId)) : [];
        const reviews = new Map(reviewRows.map(row => [row.eventId, row]));
        const count = await this.all('SELECT COUNT(*) AS count FROM events WHERE ' + where, args);
        const counters = this.readJson('ai-counts.json') || {};
        const clearedAt = Math.max(0, Number(counters.clearedAt) || 0);
        const date = new Date(); date.setHours(0, 0, 0, 0);
        const stats = await this.all('SELECT COUNT(*) AS total, COALESCE(SUM(at>=?),0) AS today FROM events WHERE scene=? AND at>=?', [Math.max(date.getTime(), clearedAt), scene, clearedAt]);
        return { rows: rows.map(row => {
            const event = JSON.parse(row.data), review = reviews.get(event.eventId);
            return { ...event, ackAt: row.ackAt, ackBy: row.ackBy,
                reviewStatus: review?.status || 'pending', review: review?.result ? JSON.parse(review.result) : null,
                reviewHistory: review ? JSON.parse(review.history) : [] };
        }),
            count: count[0].count, offset, limit, stats: { ...stats[0], clearedAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
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
        await this.run('UPDATE events SET ackAt=?,ackBy=? WHERE id=? AND ackAt IS NULL', [Date.now(), user, id]);
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
