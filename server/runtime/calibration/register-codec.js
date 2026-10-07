/**
 * 'calibration/register-codec': explicit byte/word order codec for Modbus registers
 *
 * All encodings are generated as standard big-endian bytes first, then rearranged
 * by 16-bit word order and intra-word byte order. Word order names describe the
 * byte sequence of the FINAL wire layout:
 *   ABCD       standard big-endian
 *   BADC       byte swap inside each 16-bit word
 *   CDAB       word swap (two 16-bit words)
 *   DCBA       full byte reverse
 *   ABCDEFGH   64-bit standard big-endian
 *   BADCFEHG   64-bit byte swap inside each word
 *   CDABGHEF   64-bit word pair swap
 *   GHEFCDAB   64-bit full word reverse
 *   HGFEDCBA   64-bit full byte reverse
 */

'use strict';

const WORD_ORDERS_16 = ['AB', 'BA'];
const WORD_ORDERS_32 = ['ABCD', 'BADC', 'CDAB', 'DCBA'];
const WORD_ORDERS_64 = ['ABCDEFGH', 'BADCFEHG', 'CDABGHEF', 'GHEFCDAB', 'HGFEDCBA'];

const NUMERIC_TYPES = {
    int16: { bytes: 2, registers: 1, orders: WORD_ORDERS_16 },
    uint16: { bytes: 2, registers: 1, orders: WORD_ORDERS_16 },
    int32: { bytes: 4, registers: 2, orders: WORD_ORDERS_32 },
    uint32: { bytes: 4, registers: 2, orders: WORD_ORDERS_32 },
    float32: { bytes: 4, registers: 2, orders: WORD_ORDERS_32 },
    float64: { bytes: 8, registers: 4, orders: WORD_ORDERS_64 }
};

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function assertType(numericType) {
    const def = NUMERIC_TYPES[numericType];
    if (!def) {
        throw new Error('CAL_CODEC_UNKNOWN_TYPE:' + numericType);
    }
    return def;
}

function assertOrder(numericType, wordOrder) {
    const def = assertType(numericType);
    if (def.orders.indexOf(wordOrder) === -1) {
        throw new Error('CAL_CODEC_UNKNOWN_ORDER:' + numericType + ':' + wordOrder);
    }
    return wordOrder;
}

/**
 * Standard big-endian bytes of the value (no word-order permutation)
 */
function standardBytes(value, numericType) {
    const def = assertType(numericType);
    const buf = Buffer.alloc(def.bytes);
    switch (numericType) {
        case 'int16':
            buf.writeInt16BE(value, 0);
            break;
        case 'uint16':
            buf.writeUInt16BE(value, 0);
            break;
        case 'int32':
            buf.writeInt32BE(value, 0);
            break;
        case 'uint32':
            buf.writeUInt32BE(value, 0);
            break;
        case 'float32':
            buf.writeFloatBE(value, 0);
            break;
        case 'float64':
            buf.writeDoubleBE(value, 0);
            break;
    }
    return buf;
}

/**
 * Permutation map: source byte index (standard big-endian) -> target position.
 * Derived from the wire order name, e.g. CDAB puts standard bytes C,B? no:
 * wire[0]=C(2) wire[1]=D(3) wire[2]=A(0) wire[3]=B(1).
 */
function permutationFromOrder(order) {
    const letters = order.split('');
    const map = new Array(letters.length);
    const base = 'A'.charCodeAt(0);
    for (let i = 0; i < letters.length; i++) {
        map[i] = letters[i].charCodeAt(0) - base;
    }
    return map;
}

/**
 * Encode a value into register words [w0, w1, ...] (each 0..65535) with explicit word order.
 * Rejects non-finite values (business layer should never send NaN/Infinity).
 */
function encode(value, numericType, wordOrder) {
    const def = assertType(numericType);
    assertOrder(numericType, wordOrder);
    if (!isFiniteNumber(value)) {
        throw new Error('CAL_CODEC_NON_FINITE');
    }
    // Range check for integer types
    if (numericType === 'int16' && (value < -32768 || value > 32767 || !Number.isInteger(value))) {
        throw new Error('CAL_CODEC_OUT_OF_RANGE');
    }
    if (numericType === 'uint16' && (value < 0 || value > 65535 || !Number.isInteger(value))) {
        throw new Error('CAL_CODEC_OUT_OF_RANGE');
    }
    if (numericType === 'int32' && (value < -2147483648 || value > 2147483647 || !Number.isInteger(value))) {
        throw new Error('CAL_CODEC_OUT_OF_RANGE');
    }
    if (numericType === 'uint32' && (value < 0 || value > 4294967295 || !Number.isInteger(value))) {
        throw new Error('CAL_CODEC_OUT_OF_RANGE');
    }

    const std = standardBytes(value, numericType);
    const perm = permutationFromOrder(wordOrder);
    const wire = Buffer.alloc(def.bytes);
    for (let i = 0; i < def.bytes; i++) {
        wire[i] = std[perm[i]];
    }
    const words = [];
    for (let i = 0; i < def.bytes; i += 2) {
        words.push(wire.readUInt16BE(i));
    }
    return words;
}

/**
 * Decode register words back to a numeric value (inverse of encode)
 */
function decode(words, numericType, wordOrder) {
    const def = assertType(numericType);
    assertOrder(numericType, wordOrder);
    if (!Array.isArray(words) || words.length !== def.registers) {
        throw new Error('CAL_CODEC_WORD_COUNT');
    }
    const wire = Buffer.alloc(def.bytes);
    for (let i = 0; i < def.registers; i++) {
        if (!Number.isInteger(words[i]) || words[i] < 0 || words[i] > 65535) {
            throw new Error('CAL_CODEC_WORD_RANGE');
        }
        wire.writeUInt16BE(words[i], i * 2);
    }
    const perm = permutationFromOrder(wordOrder);
    const std = Buffer.alloc(def.bytes);
    for (let i = 0; i < def.bytes; i++) {
        std[perm[i]] = wire[i];
    }
    switch (numericType) {
        case 'int16': return std.readInt16BE(0);
        case 'uint16': return std.readUInt16BE(0);
        case 'int32': return std.readInt32BE(0);
        case 'uint32': return std.readUInt32BE(0);
        case 'float32': return std.readFloatBE(0);
        case 'float64': return std.readDoubleBE(0);
    }
    throw new Error('CAL_CODEC_UNKNOWN_TYPE:' + numericType);
}

/**
 * Encode to hex string (wire order), e.g. float32 CDAB 1.0 -> '0000803f' reversed words
 */
function encodeHex(value, numericType, wordOrder) {
    const words = encode(value, numericType, wordOrder);
    return words.map(w => w.toString(16).padStart(4, '0')).join('');
}

module.exports = {
    NUMERIC_TYPES: NUMERIC_TYPES,
    WORD_ORDERS_16: WORD_ORDERS_16,
    WORD_ORDERS_32: WORD_ORDERS_32,
    WORD_ORDERS_64: WORD_ORDERS_64,
    encode: encode,
    decode: decode,
    encodeHex: encodeHex,
    isFiniteNumber: isFiniteNumber
};
