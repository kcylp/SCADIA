'use strict';

const jwt = require('jsonwebtoken');

const authJwt = require('../../api/jwt-helper');

// A TEST-ONLY secret, deliberately unrelated to jwt-helper.js.
//
// This line used to hold the vendor's historical signing secret, copied here because a comment
// (now removed) claimed it had to match jwt-helper.js. It never had to: that module generates a
// random runtime secret (utils.generateSecretCode()) and overrides it from the persisted
// settings, and this test passes its own value to authJwt.init() below. So the literal was a
// credential with no job in the code - only exposure - and it was published in every commit of
// the public repository. The scanner missed it because it only knew secretCode/password/apiKey
// assignments; scan-secrets.cjs grew a "bare SECRET constant" rule because of this line.
const SECRET = process.env.JWT_TEST_SECRET || 'test-only-secret-not-a-credential';

let expect;

// Helper: crea req/res finti
function createReq(headers = {}, body = {}) {
    return {
        headers,
        body,
        userId: null,
        userGroups: null,
        isAuthenticated: false
    };
}

function createRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(obj) {
            this.body = obj;
            return this;
        },
        end() {
            return this;
        }
    };
}

function next() {
    return;
}

// Helper: crea token
function createToken(payload, expiresIn) {
    return jwt.sign(payload, SECRET, { expiresIn });
}

describe('Security – Heartbeat & Token handling (no supertest)', () => {

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
        authJwt.init(true, SECRET, 60 * 60);
    });

    it('guest cannot refresh token (invalid token)', () => {
        const req = createReq(
            {
                'x-access-token': 'INVALID_TOKEN',
                'x-auth-user': JSON.stringify({ user: 'admin', groups: -1 })
            },
            { params: true }
        );
        const res = createRes();

        // simulate middleware
        authJwt.verifyToken(req, res, next);

        // simulate heartbeat logic
        if (req.body.params) {
            if (!req.isAuthenticated) {
                res.status(200).json({ message: 'guest' });
            }
        }

        expect(req.isAuthenticated).to.equal(false);
        expect(req.userId).to.equal('guest');
        expect(res.body.message).to.equal('guest');
    });

    it('authenticated user can refresh token', () => {
        const validToken = createToken(
            { id: 'user1', groups: ['user'] },
            '1h'
        );

        const req = createReq(
            { 'x-access-token': validToken },
            { params: true }
        );
        const res = createRes();

        authJwt.verifyToken(req, res, next);

        let newToken;
        if (req.body.params && req.isAuthenticated) {
            newToken = jwt.sign(
                { id: req.userId, groups: req.userGroups },
                SECRET,
                { expiresIn: '1h' }
            );
            res.json({ message: 'tokenRefresh', token: newToken });
        }

        expect(req.isAuthenticated).to.equal(true);
        expect(res.body.message).to.equal('tokenRefresh');

        const decoded = jwt.verify(res.body.token, SECRET);
        expect(decoded.id).to.equal('user1');
    });

    it('expired token falls back to guest', () => {
        const expiredToken = createToken(
            { id: 'user1', groups: ['user'] },
            -10
        );

        const req = createReq(
            { 'x-access-token': expiredToken },
            { params: true }
        );
        const res = createRes();

        authJwt.verifyToken(req, res, next);

        if (req.body.params && !req.isAuthenticated) {
            res.json({ message: 'guest' });
        }

        expect(req.isAuthenticated).to.equal(false);
        expect(req.userId).to.equal('guest');
        expect(res.body.message).to.equal('guest');
    });

    it('x-auth-user header is ignored', () => {
        const req = createReq(
            {
                'x-access-token': 'INVALID_TOKEN',
                'x-auth-user': JSON.stringify({ user: 'admin', groups: [-1] })
            },
            { params: true }
        );
        const res = createRes();

        authJwt.verifyToken(req, res, next);

        if (req.body.params && !req.isAuthenticated) {
            res.json({ message: 'guest' });
        }

        expect(req.userId).to.equal('guest');
        expect(req.isAuthenticated).to.equal(false);
        expect(res.body.message).to.equal('guest');
    });

});
