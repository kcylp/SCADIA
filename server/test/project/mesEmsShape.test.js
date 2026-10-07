'use strict';

/**
 * Regression: MES/EMS project rows must not collapse into one row named null (batch 90-AD).
 *
 * WHAT WAS WRONG. _mesEmsItems() tolerated a keyed OBJECT next to the frozen ARRAY contract,
 * but only one level deep. A hand-written project that groups its models -
 * { workOrders: { wo_a: {...}, wo_b: {...} } } - had Object.values() return the INNER
 * CONTAINER as the single list entry, so the save path wrote ONE row whose name was
 * undefined/null and silently lost every model inside it (ledger 90-K left exactly this
 * unexplained: the nested shape still landed as one row named null after its fix).
 *
 * WHY THIS SEAM. The helper is module-internal, so the test extracts the real function
 * from the real source file and drives it with the shapes that broke - the same trick
 * projectDemoFile.test.js uses, because booting the whole settings object for one pure
 * function is not worth it. A source-level guard keeps the extraction honest.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const READER = path.join(__dirname, '..', '..', 'runtime', 'project', 'index.js');

function readHelper() {
    const source = fs.readFileSync(READER, 'utf8');
    const start = source.indexOf('function _mesEmsItems(');
    expect(start, '_mesEmsItems no longer exists in runtime/project/index.js').to.be.greaterThan(-1);
    const end = source.indexOf('\n}', start);
    expect(end, '_mesEmsItems body is not where this test expects it').to.be.greaterThan(start);
    // eslint-disable-next-line no-eval
    return eval('(' + source.slice(start, end + 2) + ')');
}

describe('MES/EMS rows keep their identity in every tolerated shape', () => {

    it('the frozen contract shape (array of models) is untouched', () => {
        const rows = readHelper()([{ id: 'wo_1', planned: 10 }, { id: 'wo_2', planned: 20 }]);
        expect(rows.map(r => r.id)).to.deep.equal(['wo_1', 'wo_2']);
    });

    it('a flat keyed object still yields one row per model', () => {
        const rows = readHelper()({ wo_a: { id: 'wo_a' }, wo_b: { id: 'wo_b' } });
        expect(rows.map(r => r.id).sort()).to.deep.equal(['wo_a', 'wo_b']);
    });

    it('grouping keys above the models flatten to one row per model (was: 1 row named null)', () => {
        const nested = { workOrders: { wo_a: { id: 'wo_a', planned: 10 }, wo_b: { id: 'wo_b', planned: 20 } } };
        const rows = readHelper()(nested);
        expect(rows.map(r => r.id).sort(), 'the nested shape collapsed to ' + JSON.stringify(rows.map(r => r.id))).to.deep.equal(['wo_a', 'wo_b']);
    });

    it('several grouping keys are all flattened', () => {
        const grouped = { workOrders: { wo_a: { id: 'wo_a' } }, shifts: { sh_1: { id: 'sh_1' } } };
        const rows = readHelper()(grouped);
        expect(rows.map(r => r.id).sort()).to.deep.equal(['sh_1', 'wo_a']);
    });

    it('an array of models under a grouping key is flattened too', () => {
        const rows = readHelper()({ workOrders: [{ id: 'wo_a' }, { id: 'wo_b' }] });
        expect(rows.map(r => r.id).sort()).to.deep.equal(['wo_a', 'wo_b']);
    });

    it('a single bare model object becomes its own row instead of being dropped', () => {
        const rows = readHelper()({ id: 'wo_solo', planned: 7 });
        expect(rows.map(r => r.id)).to.deep.equal(['wo_solo']);
    });

    it('entries without an id never become a row named null', () => {
        const f = readHelper();
        expect(f({ junk: { nope: 1 } }), 'keyed junk must be dropped, not stored as name=null').to.deep.equal([]);
        expect(f([{ nope: 1 }]), 'array junk must be dropped, not stored as name=null').to.deep.equal([]);
        expect(f('noise'), 'a string is not a model list').to.deep.equal([]);
    });

    it('null, undefined and empty stay empty', () => {
        const f = readHelper();
        expect(f(null)).to.deep.equal([]);
        expect(f(undefined)).to.deep.equal([]);
        expect(f({})).to.deep.equal([]);
        expect(f([])).to.deep.equal([]);
    });

    it('the save path still routes mes and ems through the helper', () => {
        const source = fs.readFileSync(READER, 'utf8');
        expect(source, 'the mes branch no longer uses _mesEmsItems').to.contain('var mesItems = _mesEmsItems(prjcontent[key]);');
        expect(source, 'the ems branch no longer uses _mesEmsItems').to.contain('var emsItems = _mesEmsItems(prjcontent[key]);');
        expect(source, 'rows are still named by model id').to.contain('table: prjstorage.TableType.MES, name: mesItems[im].id');
    });
});
