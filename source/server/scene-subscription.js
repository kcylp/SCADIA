'use strict';
// Pure contract shared by project validation and the delivery consumer.
const IDS = ['V1','V2','V3','V4','V5','V6','V7','T1'];
function validateSubscription(sub) {
    if (!sub || typeof sub.id !== 'string' || !sub.id || sub.id.length > 200) throw new Error('Invalid scene subscription id');
    for (const [key, allowed, max] of [['sceneIds',IDS,8],['scenePhases',['candidate','review'],2],['sceneKinds',null,64]]) {
        const values=sub[key];
        if (values !== undefined && (!Array.isArray(values) || values.length > max || (key !== 'sceneKinds' && !values.length) ||
            values.some(v=>typeof v!=='string' || (allowed ? !allowed.includes(v) : !/^[a-z][a-z0-9_-]{0,63}$/.test(v))))) {
            throw new Error('Invalid scene subscription '+key);
        }
    }
    return sub;
}
module.exports={IDS,validateSubscription};
