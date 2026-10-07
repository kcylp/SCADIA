/**
 * Stand-in for an installed driver plugin package.
 *
 * test/devices/driverDispatch.test.js hands the dispatcher a real, resolvable module path and
 * then asks require.cache whether the driver bound it. This file is that path. It exports
 * nothing on purpose: the dispatcher only stores the export, it never calls into it, and a
 * module with behaviour would be a second thing to keep in step with the driver interfaces.
 */

'use strict';

module.exports = { __driverDispatchProbe: true };
