'use strict';
const auth = require('./jwt-helper');
function requireSceneAdmin(req, res, runtime, checkGroups) {
    if (runtime.settings?.secureEnabled) {
        if (!req.isAuthenticated) {
            res.status(401).json({ error: 'CAM_UNAUTHENTICATED', message: 'Login required' }); return null;
        }
        const permission = checkGroups(req);
        if (auth.isGuestUser(req.userId, req.userGroups) || !auth.haveAdminPermission(permission?.groups ?? permission)) {
            res.status(403).json({ error: 'CAM_FORBIDDEN', message: 'Admin permission required' }); return null;
        }
        return { isAdmin: true, userId: req.userId };
    }
    const token = req.headers['x-access-token'];
    if (!token) { res.status(401).json({ error: 'CAM_UNAUTHENTICATED', message: 'Login required' }); return null; }
    try {
        const decoded = require('jsonwebtoken').verify(token, auth.secretCode, { algorithms: ['HS256'] });
        const user = runtime.users?.getUserCache(decoded.id);
        if (!user || decoded.type === 'refresh' || !auth.haveAdminPermission(user.groups)) {
            res.status(403).json({ error: 'CAM_FORBIDDEN', message: 'Admin permission required' }); return null;
        }
        req.isAuthenticated = true; req.userId = decoded.id; req.userGroups = user.groups;
        return { isAdmin: true, userId: decoded.id };
    } catch (_) {
        res.status(401).json({ error: 'CAM_UNAUTHENTICATED', message: 'Login again before managing scene events' }); return null;
    }
}
module.exports = { requireSceneAdmin };
