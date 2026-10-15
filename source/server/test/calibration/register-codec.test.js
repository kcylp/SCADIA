const assert = require('assert');
const codec = require('../../runtime/calibration/register-codec');

describe('Calibration register-codec', () => {

    it('float32 ABCD standard big-endian', () => {
        assert.strictEqual(codec.encodeHex(1.0, 'float32', 'ABCD'), '3f800000');
        assert.strictEqual(codec.encodeHex(-1.0, 'float32', 'ABCD'), 'bf800000');
        assert.strictEqual(codec.encodeHex(0, 'float32', 'ABCD'), '00000000');
    });

    it('float32 CDAB word swap (SCADIA Float32MLE compatible)', () => {
        assert.strictEqual(codec.encodeHex(1.0, 'float32', 'CDAB'), '00003f80');
        assert(codec.decode([0x0000, 0x3f80], 'float32', 'CDAB') === 1.0);
    });

    it('float32 BADC / DCBA', () => {
        assert.strictEqual(codec.encodeHex(1.0, 'float32', 'BADC'), '803f0000');
        assert.strictEqual(codec.encodeHex(1.0, 'float32', 'DCBA'), '0000803f');
        assert(codec.decode([0x0000, 0x803f], 'float32', 'DCBA') === 1.0);
    });

    it('float64 GHEFCDAB independent vectors', () => {
        assert.strictEqual(codec.encodeHex(1.0, 'float64', 'GHEFCDAB'), '0000000000003ff0');
        assert.strictEqual(codec.encodeHex(-1.0, 'float64', 'GHEFCDAB'), '000000000000bff0');
        assert(codec.decode([0x0000, 0x0000, 0x0000, 0x3ff0], 'float64', 'GHEFCDAB') === 1.0);
    });

    it('float64 ABCDEFGH / HGFEDCBA', () => {
        assert.strictEqual(codec.encodeHex(1.0, 'float64', 'ABCDEFGH'), '3ff0000000000000');
        assert.strictEqual(codec.encodeHex(1.0, 'float64', 'HGFEDCBA'), '000000000000f03f');
    });

    it('round-trips all types and orders', () => {
        const samples = {
            int16: [-32768, -1, 0, 1, 32767],
            uint16: [0, 1, 65535],
            int32: [-2147483648, -1, 0, 123456789, 2147483647],
            uint32: [0, 1, 4294967295],
            float32: [0, -0, 1, -1, 0.1, 3.14159, 1e10, -1e-10],
            float64: [0, -0, 1, -1, 0.1, Math.PI, 1e300, -1e-300, 123456.789]
        };
        for (const type of Object.keys(samples)) {
            for (const order of codec.NUMERIC_TYPES[type].orders) {
                for (const v of samples[type]) {
                    const back = codec.decode(codec.encode(v, type, order), type, order);
                    if (type === 'float32') {
                        assert(back === Math.fround(v), type + ' ' + order + ' ' + v);
                    } else if (type === 'float64') {
                        assert(Math.abs(back - v) <= Math.abs(v) * 1e-12 + 1e-15, type + ' ' + order + ' ' + v);
                    } else {
                        assert.strictEqual(back, v, type + ' ' + order + ' ' + v);
                    }
                }
            }
        }
    });

    it('rejects non-finite / out-of-range / bad order / bad word count', () => {
        assert.throws(() => codec.encode(NaN, 'float32', 'ABCD'), /CAL_CODEC_NON_FINITE/);
        assert.throws(() => codec.encode(Infinity, 'float64', 'GHEFCDAB'), /CAL_CODEC_NON_FINITE/);
        assert.throws(() => codec.encode(70000, 'uint16', 'AB'), /CAL_CODEC_OUT_OF_RANGE/);
        assert.throws(() => codec.encode(1.5, 'int32', 'ABCD'), /CAL_CODEC_OUT_OF_RANGE/);
        assert.throws(() => codec.encode(1, 'float32', 'BAD'), /CAL_CODEC_UNKNOWN_ORDER/);
        assert.throws(() => codec.decode([1, 2], 'float64', 'GHEFCDAB'), /CAL_CODEC_WORD_COUNT/);
    });
});
