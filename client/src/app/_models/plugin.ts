export class Plugin {
    name: string;
    type: PluginType | PluginGroupType;
    version: string;
    current: string;
    status: string;
    pkg: boolean;
    dinamic: boolean;
    group: string;
    canRemove: boolean;
}

/**
 * The driver a plugin packages, as the SERVER names it (server/runtime/plugins/index.js:293-307).
 *
 * `Raspberry` is kept even though the server's registry has no such entry: it is the one member
 * that exists only here, and deleting it would silently change what the icon lookup does for a
 * third-party plugin that reports it. A member present on one side only is flagged by the
 * contract guard rather than quietly dropped.
 */
export enum PluginType {
    OPCUA = 'OPCUA',
    BACnet = 'BACnet',
    Modbus = 'Modbus',
    Raspberry = 'Raspberry',
    SiemensS7 = 'SiemensS7',
    EthernetIP = 'EthernetIP',
    OmronEthernetIP = 'OmronEthernetIP',
    MELSEC = 'MELSEC',
    REDIS = 'REDIS'
}

/**
 * The plugin group, as the SERVER names it.
 *
 * These values are the wire vocabulary (server/runtime/plugins/index.js:19-24). They used to read
 * `Chart = 'Chart'` / `Service = 'Service'`, which the server never sends: the group arrives as
 * 'chart-report' or 'service', so every `case PluginGroupType.Chart:` was dead code and no plugin
 * ever got its chart or service icon. A value that no producer can emit is not a contract, it is
 * a guess - see server/test/architecture/enumContractSync.test.js, which now compares this enum
 * with the server's member for member.
 */
export enum PluginGroupType {
    ConnectionDevice = 'connection-device',
    ConnectionDatabase = 'connection-database',
    Chart = 'chart-report',
    Service = 'service'
}
