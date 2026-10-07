'use strict';

const fs = require('fs');
const path = require('path');

describe('Security - API rate limiter ordering', () => {
    let expect;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    it('registers the rate limiter before API sub-routers', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../api/index.js'), 'utf8');
        const limiterIndex = source.indexOf('apiApp.use(limiter)');
        const authLimiterIndex = source.indexOf('apiApp.use(authLimiter)');

        expect(limiterIndex, 'the global limiter is no longer registered at all').to.be.greaterThan(-1);
        expect(authLimiterIndex, 'the auth limiter is no longer registered at all').to.be.greaterThan(-1);

        // WHAT CHANGED, AND WHY THIS TEST NOW LOOKS DIFFERENT
        //
        // This used to grep for five literal "apiApp.use(xxxApi.app())" lines. api/index.js was
        // refactored to mount every domain from the API_REGISTRY table through one loop, so those
        // literals no longer exist - and this test started failing with "-1 should be greater
        // than N". The ordering it guards is still real; what changed is how a domain gets
        // mounted. So it now asserts the same rule against the mechanism that exists:
        // the limiter must be registered before the registry loop runs.
        const mountLoopIndex = source.indexOf('API_REGISTRY.forEach');
        expect(mountLoopIndex, 'the API_REGISTRY mount loop is gone - this test must be rewritten ' +
            'against whatever mounts domains now, not deleted').to.be.greaterThan(-1);
        expect(mountLoopIndex, 'domains are mounted BEFORE the rate limiter, so rate limiting does ' +
            'not cover them').to.be.greaterThan(limiterIndex);
        expect(mountLoopIndex, 'domains are mounted before the AUTH rate limiter').to.be.greaterThan(authLimiterIndex);

        // And the loops really is what mounts: the apiApp.use call is inside it, after the init.
        const useIndex = source.indexOf('apiApp.use(apiModule.app())');
        expect(useIndex, 'the mount loop no longer mounts anything').to.be.greaterThan(mountLoopIndex);
    });
});
