'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const aliases = { shelteralarm: 'tamper', tamperdetection: 'tamper', motiondetection: 'VMD', vmd: 'VMD', badvideo: 'videoloss' };
const canonical = kind => aliases[kind] || kind;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') { return {}; } throw err; }
}
function atomic(file, value) {
    const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8'); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) { fs.unlinkSync(tmp); } }
}
function project(all, now) {
    const today = new Date(now).toISOString().slice(0, 10), total = {}, byKind = {};
    for (const [day, bucket] of Object.entries(all)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { continue; }
        for (const [raw, value] of Object.entries(bucket)) {
            const kind = canonical(raw), n = Number(value);
            if (!Number.isFinite(n) || n < 0) { throw new Error('Invalid event counter'); }
            total[kind] = (total[kind] || 0) + n;
            if (day === today) { byKind[kind] = (byKind[kind] || 0) + n; }
        }
    }
    return { today, byKind, total, updatedAt: now, ...(all._meta || {}) };
}

// Both the HTTP reset and the bridge take this cross-process lock before reading.
// Never expire a live owner's lock: slow disks must not create two simultaneous writers.
async function locked(file, fn) {
    const lock = file + '.lock', deadline = Date.now() + 5000;
    while (true) {
        try { fs.mkdirSync(lock); break; }
        catch (err) {
            if (err.code !== 'EEXIST') { throw err; }
            try {
                const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
                if (Number.isInteger(pid) && pid > 0) {
                    try { process.kill(pid, 0); }
                    catch (e) { if (e.code === 'ESRCH') { fs.rmSync(lock, { recursive: true, force: true }); continue; } }
                }
            } catch (e) {
                // Windows can deny reads while the owner deletes its PID file.
                // Retry without removing the lock: denial is not evidence of a dead owner.
                if (e.code === 'EPERM' || e.code === 'EACCES') {
                    if (Date.now() >= deadline) { throw new Error('Event counters busy; retry later'); }
                    await pause(20); continue;
                }
                if (e.code !== 'ENOENT') { throw e; }
                // The owner can release the directory between readFile and stat.
                try {
                    if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
                        fs.rmSync(lock, { recursive: true, force: true }); continue;
                    }
                } catch (statError) { if (statError.code !== 'ENOENT') { throw statError; } }
            }
            if (Date.now() >= deadline) { throw new Error('Event counters busy; retry later'); }
            await pause(20);
        }
    }
    try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); return fn(); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
async function update(workDir, imagesDir, kind, by) {
    const file = path.join(workDir, 'video-events-count.json'), pub = path.join(imagesDir, 'ai-counts.json');
    return locked(file, () => {
        const before = read(file), now = Date.now();
        const all = kind == null ? { _meta: { clearedAt: now, clearedBy: by || 'unknown' } } : JSON.parse(JSON.stringify(before));
        if (kind != null) {
            const day = new Date(now).toISOString().slice(0, 10), key = canonical(kind);
            all[day] = all[day] || {};
            all[day][key] = (Number(all[day][key]) || 0) + 1;
        }
        const projection = project(all, now);
        atomic(file, all);
        try { atomic(pub, projection); }
        catch (err) {
            try { atomic(file, before); }
            catch (rollback) { err.message += '; private rollback failed: ' + rollback.message; }
            throw err;
        }
        return { status: 'ok', cleared: kind == null ? ['video-events-count.json', 'ai-counts.json'] : [], at: new Date(now).toISOString(), by, error: null, counts: projection };
    });
}
module.exports = { bump: (work, images, kind) => update(work, images, kind), reset: (work, images, by) => update(work, images, null, by), project };
