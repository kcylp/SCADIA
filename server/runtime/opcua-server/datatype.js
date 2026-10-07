/**
 * 'opcua-server/datatype': map the project's tag types onto OPC UA built-in types.
 *
 * Every device driver names its types differently (S7: Bool/Int/Word/DInt/Real;
 * Modbus: Int16/UInt16/Float32/...; OPC UA client: Boolean/Int32/...). An OPC UA
 * client needs one concrete DataType per variable, and a wrong guess is worse
 * than a conservative one: a numeric value exposed as Int32 when it is really a
 * float would silently truncate on the client. So the mapping is explicit and
 * anything unknown falls back to Double (numeric) or String — never to a
 * narrower integer.
 */

'use strict';

/** Canonical OPC UA built-in type names (node-opcua accepts these strings). */
const T = {
    Boolean: 'Boolean',
    SByte: 'SByte',
    Byte: 'Byte',
    Int16: 'Int16',
    UInt16: 'UInt16',
    Int32: 'Int32',
    UInt32: 'UInt32',
    Int64: 'Int64',
    UInt64: 'UInt64',
    Float: 'Float',
    Double: 'Double',
    String: 'String',
    DateTime: 'DateTime'
};

/**
 * tag type (any driver's spelling) -> OPC UA built-in type.
 * Keys are compared case-insensitively.
 */
const TYPE_MAP = {
    // boolean family
    bool: T.Boolean, boolean: T.Boolean, bit: T.Boolean, discrete: T.Boolean, 'coil': T.Boolean,

    // 8-bit
    byte: T.Byte, uint8: T.Byte, usint: T.Byte, char: T.Byte,
    sbyte: T.SByte, int8: T.SByte, sint: T.SByte,

    // 16-bit
    int: T.Int16, int16: T.Int16, short: T.Int16, 's7int': T.Int16,
    word: T.UInt16, uint16: T.UInt16, ushort: T.UInt16, uint: T.UInt16,

    // 32-bit
    dint: T.Int32, int32: T.Int32, long: T.Int32, dword: T.UInt32, uint32: T.UInt32,
    udint: T.UInt32, udint_: T.UInt32,

    // 64-bit
    lint: T.Int64, int64: T.Int64, ulint: T.UInt64, uint64: T.UInt64,

    // floating point
    real: T.Float, float: T.Float, float32: T.Float, single: T.Float,
    lreal: T.Double, double: T.Double, float64: T.Double, number: T.Double,

    // text / time
    string: T.String, text: T.String, chararray: T.String, datetime: T.DateTime, date: T.DateTime
};

/** Strip the little/big-endian suffixes Modbus tags use (Int16LE, Float32MLE). */
function stripEndian(type) {
    return String(type).replace(/(LE|BE|MLE)$/i, '');
}

function mapTagType(tagType) {
    if (!tagType) { return T.Double; }
    const key = stripEndian(String(tagType)).toLowerCase();
    if (TYPE_MAP[key]) { return TYPE_MAP[key]; }
    // Unknown: keep numeric tags numeric (Double) and anything else text.
    return /^(u?int|float|double|word|dword|byte|real)/.test(key) ? T.Double : T.String;
}

/** True for OPC UA types that carry a number (used to coerce incoming values). */
function isNumericType(opcuaType) {
    return [T.SByte, T.Byte, T.Int16, T.UInt16, T.Int32, T.UInt32, T.Int64, T.UInt64, T.Float, T.Double]
        .indexOf(opcuaType) >= 0;
}

/**
 * Coerce a runtime value to the declared OPC UA type.
 * Returns { ok, value } — `ok:false` means the value cannot represent the type
 * (a client must see Bad quality rather than a fabricated 0).
 */
function coerce(value, opcuaType) {
    if (value === null || value === undefined || value === '') {
        return { ok: false, value: null };
    }
    switch (opcuaType) {
        case T.Boolean: {
            if (typeof value === 'boolean') { return { ok: true, value: value }; }
            if (typeof value === 'number') { return { ok: true, value: !!value }; }
            const s = String(value).trim().toLowerCase();
            if (['true', '1', 'on', 'yes'].indexOf(s) >= 0) { return { ok: true, value: true }; }
            if (['false', '0', 'off', 'no'].indexOf(s) >= 0) { return { ok: true, value: false }; }
            return { ok: false, value: null };
        }
        case T.String:
            return { ok: true, value: String(value) };
        default: {
            const n = Number(value);
            if (!Number.isFinite(n)) { return { ok: false, value: null }; }
            // Ints must not silently truncate a float tag.
            if (isNumericType(opcuaType) && opcuaType !== T.Float && opcuaType !== T.Double &&
                Math.round(n) !== n) {
                return { ok: false, value: null };
            }
            return { ok: true, value: opcuaType === T.Float ? Math.fround(n) : n };
        }
    }
}

module.exports = {
    TYPES: T,
    mapTagType: mapTagType,
    isNumericType: isNumericType,
    coerce: coerce,
    stripEndian: stripEndian
};
