
var events = require("events");

/**
 * @enum
 */
const IoEventTypes = {
    DEVICE_STATUS: 'device-status',
    DEVICE_PROPERTY: 'device-property',
    DEVICE_VALUES: 'device-values',
    // Server -> client, and only ever for a LOST update (batch 48, N-27): when every subscribed
    // socket refused the frame, the operator's picture silently stops moving. Name follows the
    // DAQ_ERROR / RECIPE_UPLOAD_ERROR precedent, hyphenated like the rest of the device family.
    DEVICE_VALUES_ERROR: 'device-values-error',
    DEVICE_BROWSE: 'device-browse',
    DEVICE_NODE_ATTRIBUTE: 'device-node-attribute',
    DEVICE_WEBAPI_REQUEST: 'device-webapi-request',
    DEVICE_TAGS_REQUEST: 'device-tags-request',
    DEVICE_TAGS_SUBSCRIBE: 'device-tags-subscribe',
    DEVICE_TAGS_UNSUBSCRIBE: 'device-tags-unsubscribe',
    DEVICE_ENABLE: 'device-enable',
    DAQ_QUERY: 'daq-query',
    DAQ_RESULT: 'daq-result',
    DAQ_ERROR: 'daq-error',
    ALARMS_STATUS: 'alarms-status',
    HOST_INTERFACES: 'host-interfaces',
    SCRIPT_CONSOLE: 'script-console',
    SCRIPT_COMMAND: 'script-command',
    RECIPE_CANCEL: 'recipe:cancel-execution',
    ALIVE: 'heartbeat',
    SCHEDULER_UPDATED: 'scheduler:updated',
    SCHEDULER_ACTIVE: 'scheduler:event-active',
    SCHEDULER_REMAINING: 'scheduler:remaining-time',
    RECIPE_DOWNLOAD_PROGRESS: 'recipe:download-progress',
    RECIPE_DOWNLOAD_COMPLETE: 'recipe:download-complete',
    RECIPE_DOWNLOAD_ERROR: 'recipe:download-error',
    RECIPE_UPLOAD_PROGRESS: 'recipe:upload-progress',
    RECIPE_UPLOAD_COMPLETE: 'recipe:upload-complete',
    RECIPE_UPLOAD_ERROR: 'recipe:upload-error',
    RECIPE_CANCELED: 'recipe:cancel-confirmed',
    CALIBRATION_SAMPLE_PROGRESS: 'calibration:sample-progress',
    CALIBRATION_SAMPLE_COMPLETE: 'calibration:sample-complete',
    CALIBRATION_SAMPLE_ERROR: 'calibration:sample-error',
    CALIBRATION_FIT_COMPLETE: 'calibration:fit-complete',
    CALIBRATION_WRITE_PROGRESS: 'calibration:write-progress',
    CALIBRATION_WRITE_COMPLETE: 'calibration:write-complete',
    CALIBRATION_WRITE_ERROR: 'calibration:write-error',
    CALIBRATION_CANCELED: 'calibration:canceled'
}

// module.exports = IoEventTypes;

module.exports = {
    create: function () {
        return new events.EventEmitter();
    },
    IoEventTypes: IoEventTypes
}