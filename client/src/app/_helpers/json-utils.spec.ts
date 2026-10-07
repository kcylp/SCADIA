import { JsonUtils } from './json-utils';

/**
 * The parse that has to survive whatever the server, a project file or localStorage hands it.
 *
 * Second spec of the client suite (batch 67, N-5), chosen for the same reason as the first: the
 * function is pure, it is called from the editor and from every widget that reads a stored view, and
 * its failure mode is a silently missing chart rather than an error anyone can see.
 */
describe('JsonUtils.tryToParse', () => {
    it('returns an object unchanged instead of re-parsing it', function () {
        const value = { id: 't1', tags: [1, 2] };
        expect(JsonUtils.tryToParse(value)).toBe(value);
    });

    it('parses a JSON string into the object it describes', function () {
        expect(JsonUtils.tryToParse('{"a":1}')).toEqual({ a: 1 });
        expect(JsonUtils.tryToParse('[1,2]')).toEqual([1, 2]);
    });

    it('falls back on anything that is not an object once parsed', function () {
        // A JSON scalar parses fine but is not what the callers want; the fallback keeps the
        // caller's default instead of handing it a number where it expects a view.
        expect(JsonUtils.tryToParse('42', null)).toBe(null);
        expect(JsonUtils.tryToParse('"text"', null)).toBe(null);
        expect(JsonUtils.tryToParse('null', null)).toBe(null);
    });

    it('falls back on malformed input and on absent input rather than throwing', function () {
        expect(() => JsonUtils.tryToParse('{oops', null)).not.toThrow();
        expect(JsonUtils.tryToParse('{oops', null)).toBe(null);
        expect(JsonUtils.tryToParse(null, { fallback: true })).toEqual({ fallback: true });
        expect(JsonUtils.tryToParse(undefined, { fallback: true })).toEqual({ fallback: true });
    });
});
