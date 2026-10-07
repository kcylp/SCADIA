/**
 * Device interface managed with StateMachine INIT/IDLE/POLLING
 */

'use strict';
var S7client = require('./s7');
var OpcUAclient = require('./opcua');
var MODBUSclient = require('./modbus');
var BACNETclient = require('./bacnet');
var HTTPclient = require('./httprequest');
var MQTTclient = require('./mqtt');
var EthernetIPclient = require('./ethernetip');
var OmronEthernetIPclient = require('./omron-ethernetip');
var ScadiaServer = require('./scadiaserver');
var ODBCclient = require('./odbc');
var ADSclient = require('./adsclient');
// var TEMPLATEclient = require('./template');
var GpioClient = require('./gpio');
var WebCamClient = require('./webcam');
var MELSECclient = require('./melsec');
var REDISclient = require('./redis');
var WSclient = require('./websocket');

const path = require('path');
const utils = require('../utils');

var deviceCloseTimeout = 1000;
var DEVICE_CHECK_STATUS_INTERVAL = 5000;
var SERVER_POLLING_INTERVAL = 1000;             // with DAQ enabled, will be saved only changed values in this interval
var DEVICE_POLLING_INTERVAL = 3000;             // with DAQ enabled, will be saved only changed values in this interval
var DISABLE_POLLING_INTERVAL = -1;              // disable polling

var fncGetDeviceProperty;

function Device(data, runtime) {
    var deviceData = data;                                       // Raw project definition (tags map lives here)
    var currentBindingRevision = 0;                              // Stamped by the devices manager on every (re)load
    // Legacy data migration. Projects written by an earlier product generation persist the
    // embedded server pseudo-device under a different type name. Those values live in
    // customer databases, so the old string is kept here as a data constant only - it is
    // never rendered to a user. Renaming it would silently drop the device from every
    // existing project on load.
    var LEGACY_SERVER_DEVICE_TYPE = 'FuxaServer'; // branding-guard:allow persisted legacy identifier, required to load existing projects
    if (data.type === LEGACY_SERVER_DEVICE_TYPE) {
        data.type = 'SCADIAServer';
    }
    var property = { id: data.id, name: data.name, type: data.type };   // Device property (name, id)
    var status = DeviceStatusEnum.INIT;                     // Current status (StateMachine)
    var logger = runtime.logger;                            // Logger
    var events = runtime.events;                            // Events to commit change to runtime
    var manager = runtime.plugins.manager;                  // Plugins manager
    var currentCmd = null;                                  // Current Command (StateMachine)
    var deviceCheckStatus = null;                           // TimerInterval to check Device status (connection)
    var devicePolling = null;                               // TimerInterval to polling read device value
    var connectionStatus = ConnectionStatusEnum.OFF;        // Connection status depending of read tag value response
    var pollingInterval = DEVICE_POLLING_INTERVAL;
    var sharedDevices = data.sharedDevices;
    var tryToConnect = 0;
    var comm;                                               // Interface to OPCUA/S7/.. Device
                                                            // required: connect, disconnect, isConnected, polling, init, load, getValue,
                                                            // getValues, getStatus, setValue, bindAddDaq, getTagProperty,
    fncGetDeviceProperty = runtime.project.getDeviceProperty;

    if (data.type === DeviceEnum.S7) {
        if (!S7client) {
            return null;
        }
        comm = S7client.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.OPCUA) {
        if (!OpcUAclient) {
            return null;
        }
        comm = OpcUAclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.ModbusRTU || data.type === DeviceEnum.ModbusTCP) {
        if (!MODBUSclient) {
            return null;
        }
        comm = MODBUSclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.BACnet) {
        if (!BACNETclient) {
            return null;
        }
        comm = BACNETclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.WebAPI) {
        if (!HTTPclient) {
            return null;
        }
        comm = HTTPclient.create(data, logger, events, runtime);
    } else if (data.type === DeviceEnum.MQTTclient) {
        if (!MQTTclient) {
            return null;
        }
        data.certificatesDir = path.resolve(runtime.settings.appDir, '_certificates');
        comm = MQTTclient.create(data, logger, events, runtime);
    } else if (data.type === DeviceEnum.EthernetIP) {
        if (!EthernetIPclient) {
            return null;
        }
        comm = EthernetIPclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.OmronEthernetIP) {
        if (!OmronEthernetIPclient) {
            return null;
        }
        comm = OmronEthernetIPclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.SCADIAServer) {
        if (!ScadiaServer) {
            return null;
        }
        // The fifth argument is what every other driver already received; this one was missing it,
        // which is why the internal server device's emitter had no runtime to hand to the shared
        // emitter - and threw on every emit under 'use strict'.
        comm = ScadiaServer.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.ODBC) {
        if (!ODBCclient) {
            return null;
        }
        comm = ODBCclient.create(data, logger, events, manager);
    } else if (data.type === DeviceEnum.ADSclient) {
        if (!ADSclient) {
            return null;
        }
        comm = ADSclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.GPIO) {
        if (!GpioClient) {
            return null;
        }
        comm = GpioClient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.WebCam) {
        if (!WebCamClient) {
            return null;
        }
        comm = WebCamClient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.MELSEC) {
        if (!MELSECclient) {
            return null;
        }
        comm = MELSECclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.REDIS) {
        if (!REDISclient) {
            return null;
        }
        comm = REDISclient.create(data, logger, events, manager, runtime);
    } else if (data.type === DeviceEnum.WebSocket) {
        if (!WSclient) {
            return null;
        }
        comm = WSclient.create(data, logger, events, runtime);
    }
    // else if (data.type === DeviceEnum.Template) {
    //     if (!TEMPLATEclient) {
    //         return null;
    //     }
    //     comm = TEMPLATEclient.create(data, logger, events, manager);
    // }
    if (!comm) {
        return null;
    }
    /**
     * Start StateMachine, init and start TimerInterval to check Device status
     */
    this.start = function () {
        currentCmd = DeviceCmdEnum.START;
        if (status === DeviceStatusEnum.INIT) {
            logger.info(`'${property.name}' start`);
            var self = this;
            this.checkStatus();
            deviceCheckStatus = setInterval(function () {
                self.checkStatus();
            }, DEVICE_CHECK_STATUS_INTERVAL);
        }
    }

    /**
     * Stop StateMachine, Close Device connection, break all TimerInterval (Device status/polling)
     */
    this.stop = function () {
        return new Promise(function (resolve, reject) {
            currentCmd = DeviceCmdEnum.STOP;
            logger.info(`'${property.name}' stop`);
            if (devicePolling) {
                clearInterval(devicePolling);
                devicePolling = null;
            }
            if (deviceCheckStatus) {
                clearInterval(deviceCheckStatus);
                deviceCheckStatus = null;
            }
            connectionStatus = ConnectionStatusEnum.OFF;
            comm.disconnect().then(function () {
                status = DeviceStatusEnum.INIT;
                resolve();
            }).catch(function (err) {
                reject(err);
            });;
        });
    }

    /**
     * Check the Device connection, Reconnect
     */
    this.checkStatus = function () {
        if (status === DeviceStatusEnum.INIT && currentCmd === DeviceCmdEnum.START) {
            const self = this;
            this.connect().then(() => {
                tryToConnect = 0;
                status = DeviceStatusEnum.IDLE;
                self.restoreValues();
            }).catch(function (err) {
                logger.error(`'${property.name}' connect error! ${err} (${tryToConnect})`);
                if (tryToConnect++ > 3) {
                    tryToConnect = 0;
                    self.disconnect().then(() => {});
                }
            });
        } else if (status === DeviceStatusEnum.IDLE && !comm.isConnected()) {
            status = DeviceStatusEnum.INIT;
            if (devicePolling) {
                clearInterval(devicePolling);
                devicePolling = null;
            }
        }
        // check connection status
        const now = Date.now();
        var lastRead = comm.lastReadTimestamp() || 0;
        if (lastRead < now - pollingInterval * 5) {
            connectionStatus = ConnectionStatusEnum.OFF;
        } else if (lastRead < now - pollingInterval * 2) {
            connectionStatus = ConnectionStatusEnum.WARNING;
        } else {
            connectionStatus = ConnectionStatusEnum.ON;
        }
        if (this.updateConnectionStatus) {
            this.updateConnectionStatus(property.id, connectionStatus);
        }
    }

    /**
     * Call Device to polling
     */
    this.polling = function () {
        comm.polling();
    }

    /**
     * Call Device to connect and start TimerInterval for read value polling
     */
    this.connect = function () {
        var self = this;
        if (data.type === DeviceEnum.ModbusRTU) {
            comm.init(MODBUSclient.ModbusTypes.RTU);
        } else if (data.type === DeviceEnum.ModbusTCP) {
            comm.init(MODBUSclient.ModbusTypes.TCP);
        }
        return comm.connect().then(function () {
            if (pollingInterval !== DISABLE_POLLING_INTERVAL){
                devicePolling = setInterval(function () {
                    self.polling();
                }, pollingInterval);
            }
        });
    }

    /**
     * Call Device to disconnect
     */
    this.disconnect = function () {
        return comm.disconnect();
    }

    /**
     * Call Device to load Tags propperty in local for polling read values
     */
    this.load = function (data) {
        pollingInterval = data.polling || ((data.type === DeviceEnum.SCADIAServer) ? SERVER_POLLING_INTERVAL : DEVICE_POLLING_INTERVAL);
        data.polling = pollingInterval;
        // Adopt the revision of this binding BEFORE the driver rebuilds its tag maps, so a
        // read that starts now is already stamped with the generation it belongs to.
        if (typeof data.bindingRevision === 'number') {
            currentBindingRevision = data.bindingRevision;
        }
        return comm.load(data);
    }

    /**
     * Binding generation this device instance is currently wired to.
     *
     * A driver snapshots this when a read STARTS and re-checks it when the read COMPLETES;
     * a difference means the device was rebound mid-read and the result must be dropped
     * (see devices/binding-guard).
     */
    this.getBindingRevision = function () {
        return currentBindingRevision;
    }

    /**
     * Call Device to retrun Tags with values
     */
    this.getValues = function () {
        return comm.getValues();
    }

    /**
     * Call Device to get Tag value with Timestamp
     */
    this.getValue = function (id, value) {
        return comm.getValue(id);
    }

    /**
     * Call Device to return current status
     */
    this.getStatus = function () {
        return comm.getStatus();
    }

    /**
     * Call Device to set Tag value
     */
    this.setValue = async function (id, value, fnc) {
        var fncvalue = this.getValueInFunction(this.getValue(id), value, fnc);
        return await comm.setValue(id, value);
    }

    /**
     * Write several tags at once.
     *
     * Drivers that can express a batch (WebAPI, WebSocket, MQTT) do it in one
     * request/round trip; the rest fall back to sequential writes so the caller
     * gets one consistent result shape either way.
     *
     * @returns {Promise<{ok:boolean, written:number, failed:Array<{id,error}>}>}
     */
    this.setValues = async function (entries) {
        if (comm.setValues) {
            return await comm.setValues(entries);
        }
        const failed = [];
        let written = 0;
        for (const e of (entries || [])) {
            try {
                const ok = await this.setValue(e.id, e.value);
                if (ok) { written++; } else { failed.push({ id: e.id, error: 'write failed' }); }
            } catch (err) {
                failed.push({ id: e.id, error: err.message || String(err) });
            }
        }
        return { ok: failed.length === 0 && written > 0, written: written, failed: failed, batched: false };
    }

    /**
     * Call Device to return browser result Tags/Nodes (only OPCUA)
     */
    this.browse = function (path, callback) {
        return new Promise(function (resolve, reject) {
            if (data.type === DeviceEnum.OPCUA) {
                comm.browse(path).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else if (data.type === DeviceEnum.BACnet) {
                comm.browse(path).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else if (data.type === DeviceEnum.MQTTclient) {
                comm.browse(path, callback).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else if (data.type === DeviceEnum.ODBC) {
                comm.browse(path, callback).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else if (data.type === DeviceEnum.REDIS) {
                comm.browse(path, callback).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else if (data.type === DeviceEnum.WebSocket) {
                comm.browse(path, callback).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else {
                reject('Browse not supported!');
            }
        });
    }

    /**
     * Call Device to return Tag/Node attribute (only OPCUA)
     */
    this.readNodeAttribute = function(node) {
        return new Promise(function (resolve, reject) {
            if (data.type === DeviceEnum.OPCUA) {
                comm.readAttribute(node).then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else {
                reject('Read Node attribute not supported!');
            }
        });
    }

    /**
     * Call Device to return Tags property (WebAPI)
     */
    this.getTagsProperty = function() {
        return new Promise(function (resolve, reject) {
            if (data.type === DeviceEnum.WebAPI && comm.getTagsProperty) {
                comm.getTagsProperty().then(function (result) {
                    resolve(result);
                }).catch(function (err) {
                    reject(err);
                });
            } else {
                reject('Get Tags Property not supported!');
            }
        });
    }

    /**
     * Call Device to bind the DAQ store function
     */
    this.bindSaveDaqValue = function (fnc) {
        comm.bindAddDaq(fnc);
        //return comm.addDaq = fnc;
    }

    this.bindGetDaqValueToRestore = function (fnc) {
        this.getDaqValueToRestore = fnc;
    }
    this.getDaqValueToRestore = null;   // Function to get current value to restore by start

    /**
     * Call Device to return Tag property
     */
    this.getTagProperty = function (id) {
        return comm.getTagProperty(id);
    }

    /**
     * The device's tag definition map (tagId -> definition), exactly as read from the
     * project. Deliberately independent of `comm`: the runtime tag index must be able to
     * resolve tag ownership without asking a driver, which may not be connected yet.
     */
    this.getTags = function () {
        return (deviceData && deviceData.tags && typeof deviceData.tags === 'object') ? deviceData.tags : {};
    }

    /**
     * Bind function to ask project stored property (security)
     */
    this.bindGetProperty = function (fnc) {
        if (data.type === DeviceEnum.OPCUA || data.type === DeviceEnum.MQTTclient || data.type === DeviceEnum.ODBC ||
            data.type === DeviceEnum.WebSocket) {
            comm.bindGetProperty(fnc);
        }
    }

    /**
     * Bind function to update connection status to server
     */
    this.bindUpdateConnectionStatus = function (fnc) {
        this.updateConnectionStatus = fnc;
    }

    this.updateConnectionStatus = null;

    /**
     * Set connection status of device in SCADIAServer
     * used only from SCADIAServer device
     * @param {*} deviceId
     * @param {*} status
     */
    this.setDeviceConnectionStatus = function (deviceId, status) {
        comm.setConnectionStatus(deviceId, status);
    }

    /**
     * return the value calculated with the function if defined
     */
    this.getValueInFunction = function (current, value, fnc) {
        try {
            if (!fnc || fnc.length < 2) return value;
            if (!current) {
                current = 0;
            }
            if (fnc[0] === 'add') {
                return parseFloat(current) + parseFloat(fnc[1]);
            } else if (fnc[0] === 'remove') {
                return parseFloat(current) - parseFloat(fnc[1]);
            }
        } catch (err) {
            logger.error(err);
        }
        return value;
    }

    this.restoreValues = () => {
        try {
            if (this.getDaqValueToRestore) {
                var self = this;
                this.getDaqValueToRestore(property.id).then(async (toRestore) => {
                    var restored = 0;
                    for (let element of toRestore) {
                        if (element.id && !utils.isNullOrUndefined(element.value)) {
                            const result = await self.setValue(element.id, element.value);
                            if (result) {
                                restored++;
                            }
                        }
                    }
                    logger.info(`'${property.name}' restored ${restored}/${toRestore.length} values`);
                }).catch((err) => {
                    logger.error(`'${property.name}' restore error! ${err}`);
                });
            }
        } catch (err) {
            logger.error(`'${property.name}' restore error! ${err}`);
        }
    }

    this.getTagDaqSettings = (tagId) => {
        return comm.getTagDaqSettings ? comm.getTagDaqSettings(tagId) : null;
    }

    this.setTagDaqSettings = (tagId, settings) => {
        return comm.setTagDaqSettings ? comm.setTagDaqSettings(tagId, settings) : null;
    }

    this.getComm = () => {
        return comm;
    }

    this.getName = () => {
        return property.name;
    }

    this.getType = () => {
        return property.type;
    }

    this.load(data);
}

/**
 * Return the property (security mode) supported from device
 * @param {*} endpoint
 * @param {*} type
 */
function getSupportedProperty(endpoint, type, packagerManager) {
    var self = this;
    return new Promise(function (resolve, reject) {
        if (type === DeviceEnum.OPCUA) {
            OpcUAclient.getEndPoints(endpoint, packagerManager).then(function (result) {
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        } else if (type === DeviceEnum.ODBC) {
            ODBCclient.getTables(endpoint, fncGetDeviceProperty, packagerManager).then(function (result) {
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        } else {
            reject('getSupportedProperty not supported!');
        }
    });
}

/**
 * Return the result of request
 * @param {*} property
 */
function getRequestResult(property) {
    return new Promise(function (resolve, reject) {
        if (HTTPclient) {
            HTTPclient.getRequestResult(property).then(function (result) {
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        } else {
            reject('getRequestResult not supported!');
        }
    });
}

/**
 * Load the plugin library
 * @param {*} type
 */
function loadPlugin(type, module) {
    if (type === DeviceEnum.S7) {
        S7client = require(module);
    } else if (type === DeviceEnum.OPCUA) {
        OpcUAclient = require(module);
    } else if (type === DeviceEnum.ModbusTCP || type === DeviceEnum.ModbusRTU) {
        MODBUSclient = require(module);
    } else if (type === DeviceEnum.BACnet) {
        BACNETclient = require(module);
    } else if (type === DeviceEnum.WebAPI) {
        HTTPclient = require(module);
    } else if (type === DeviceEnum.MQTTclient) {
        MQTTclient = require(module);
    } else if (type === DeviceEnum.EthernetIP) {
        EthernetIPclient = require(module);
    } else if (type === DeviceEnum.OmronEthernetIP) {
        OmronEthernetIPclient = require(module);
    } else if (type === DeviceEnum.SCADIAServer) {
        ScadiaServer = require(module);
    } else if (type === DeviceEnum.ODBC) {
        ODBCclient = require(module);
    } else if (type === DeviceEnum.ADSclient) {
        ADSclient = require(module);
    } else if (type === DeviceEnum.GPIO) {
        GpioClient = require(module);
    } else if (type === DeviceEnum.MELSEC) {
        MELSECclient = require(module);
    } else if (type === DeviceEnum.REDIS) {
        REDISclient = require(module);
    } else if (type === DeviceEnum.WebSocket) {
        WSclient = require(module);
    }
}

function isInternal(device) {
    return (device.type === DeviceEnum.internal);
}

module.exports = {
    init: function (settings) {
        // deviceCloseTimeout = settings.deviceCloseTimeout || 15000;
    },
    create: function (data, runtime) {
        return new Device(data, runtime);
    },
    getSupportedProperty: getSupportedProperty,
    getRequestResult: getRequestResult,
    loadPlugin: loadPlugin,
    isInternal: isInternal,

    get DeviceType() { return DeviceEnum }
}

/**
 * Device type supported
 */
var DeviceEnum = {
    S7: 'SiemensS7',
    OPCUA: 'OPCUA',
    ModbusRTU: 'ModbusRTU',
    ModbusTCP: 'ModbusTCP',
    BACnet: 'BACnet',
    WebAPI: 'WebAPI',
    MQTTclient: 'MQTTclient',
    EthernetIP: 'EthernetIP',
    OmronEthernetIP: 'OmronEthernetIP',
    SCADIAServer: 'SCADIAServer',
    ODBC: 'ODBC',
    ADSclient: 'ADSclient',
    GPIO: 'GPIO',
    internal: 'internal',
    WebCam: 'WebCam',
    MELSEC: 'MELSEC',
    REDIS: 'REDIS',
    WebSocket: 'WebSocket',
    // Template: 'template'
}

/**
 * State of StateMachine
 */
var DeviceStatusEnum = {
    INIT: 'init',
    IDLE: 'idle',
    POLLING: 'polling'
}

/**
 * Command of StateMachine
 */
var DeviceCmdEnum = {
    STOP: 'stop',
    START: 'start',
    CONNECT: 'connect'
}

/**
 * State of Connection
 */
 var ConnectionStatusEnum = {
    OFF: 0,
    WARNING: 3, // up to 5 times the polling interval without response
    ON: 5,
}
