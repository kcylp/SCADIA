/**
 * D6/D8 - which delivery backends the contract suite can be run against, on this machine.
 *
 * RUNNABLE IS DERIVED, NOT TYPED. A backend is exercised here when a fixture named after it
 * exists in this directory. Bringing one online is therefore "add its fixture" and nothing
 * else - no list to remember to edit, which is how a suite quietly stops covering a backend.
 *
 * What is typed here is only the other half: the backends that are NOT exercised here, each
 * with the reason and the deliverable that changes that. The guard insists the two halves
 * cover the delivery backends exactly.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** Test files in this directory that are not backend fixtures. */
const NON_FIXTURES = ['coverage'];

/** Backends with a fixture in the contract test directory, derived from the filesystem. */
function fixturesHere() {
    return fs.readdirSync(path.join(__dirname, '..'))
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => path.basename(name, '.test.js'))
        .filter((id) => NON_FIXTURES.indexOf(id) === -1)
        .sort();
}

/**
 * Delivery backends that do not run here, and what changes that.
 *
 * The flag fixture:true means the fixture exists and runs the shared suite the moment a server
 * is reachable - that is a wiring problem, not a coding one. Anything else is still to be built.
 */
const NOT_EXERCISED_HERE = {
    postgresql: {
        fixture: true,
        proven: true,
        why: 'PROVEN against PostgreSQL 18 in a container (contract suite 8/8). It is listed here only because a machine without that container reports the suite pending - a property of the machine, not of the backend. Start it with test:backends:up to re-run.',
        closesAt: 'D8',
        proveWith: 'npm run test:backends:up && npm run test:contract'
    },
    tdengine: {
        fixture: true,
        why: 'the adapter was brought up to the contract at D9 (it no longer kills the host on a bad configuration, and KEEP is wired from the retention setting), but no TDengine instance is reachable, so the suite reports pending rather than asserting against nothing',
        closesAt: 'D9',
        proveWith: 'npm run test:backends:up && npm run test:contract'
    },
    dameng: {
        fixture: false,
        why: 'no Dameng instance and no driver package at all; ruling 14 reserves the space rather than implementing it now',
        closesAt: 'D10',
        proveWith: 'obtain the Dameng driver and an instance, then add the adapter and fixture'
    },
    mysql: {
        fixture: false,
        why: 'no MySQL-family instance and no driver package; the xinchuang MySQL branch is reserved, not built',
        closesAt: 'D10',
        proveWith: 'obtain the driver and an instance, then add the adapter and fixture'
    }
};

module.exports = { fixturesHere, NOT_EXERCISED_HERE, NON_FIXTURES };
