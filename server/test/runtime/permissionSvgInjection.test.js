/**
 * Hiding a control for permissions must touch the ELEMENT, never a mention of its id.
 *
 * WHY THIS EXISTS - the reported P1, reproduced.
 *
 * _filterProjectPermission hid a control by string-splicing the view's svgcontent at
 * indexOf(item.id). indexOf matches anywhere, and the FIRST match is frequently not the drawn
 * element - an id is commonly repeated in a <title>, and can appear inside a longer id. The
 * attribute was then written into that text: the control stayed visible AND the text it landed in
 * was corrupted. Configuring permissions could therefore scramble a screen, silently.
 *
 * These cases pin the new behaviour: the attribute lands on the opening tag that actually carries
 * the id, a mention in text is ignored, and an absence is reported rather than spliced blindly.
 */
'use strict';

const { expect } = require('chai');
const path = require('path');
const utils = require(path.resolve(__dirname, '..', '..', 'runtime', 'utils.js'));

const HIDE = 'visibility="hidden"';
const call = (svg, id) => utils.domStringSetAttributeOnId(svg, id, HIDE);

describe('permission hiding targets the element, not a mention of its id', () => {
    it('is exported', () => {
        expect(typeof utils.domStringSetAttributeOnId, 'helper is missing').to.equal('function');
    });

    it('adds the attribute to the tag that carries the id', () => {
        const svg = '<svg><rect id="shape_1" x="1" y="2"/></svg>';
        const out = call(svg, 'shape_1');
        expect(out, 'no element found').to.be.a('string');
        expect(out).to.contain('id="shape_1"');
        expect(out).to.contain(HIDE);
        // The attribute must sit inside the SAME opening tag as the id: after the id attribute's
        // closing quote, and before that tag's own '>'. (A bare indexOf('>') would find an earlier
        // tag's terminator and prove nothing.)
        var idAt = out.indexOf('id="shape_1"');
        var idEnd = idAt + 'id="shape_1"'.length;
        var hideAt = out.indexOf(HIDE);
        var tagEnd = out.indexOf('>', idEnd);
        expect(hideAt, 'attribute must come after the id attribute').to.be.greaterThan(idEnd);
        expect(hideAt, 'attribute must sit inside the opening tag').to.be.lessThan(tagEnd);
    });

    it('IGNORES an id that appears in a <title> first (the reported failure)', () => {
        const svg = '<svg><title>shape_1</title><rect id="shape_1" x="1"/></svg>';
        const out = call(svg, 'shape_1');
        expect(out, 'helper returned null despite a real element').to.be.a('string');
        expect(out, 'the <title> must be left alone').to.contain('<title>shape_1</title>');
        const titleEnd = out.indexOf('</title>');
        const hideAt = out.indexOf(HIDE);
        expect(hideAt, 'the attribute must NOT land in the title').to.be.greaterThan(titleEnd);
    });

    it('IGNORES an id that is only a substring of a longer id', () => {
        const svg = '<svg><rect id="shape_10" x="1"/></svg>';
        expect(call(svg, 'shape_1'), 'shape_1 must not match shape_10').to.equal(null);
    });

    it('handles single-quoted ids', () => {
        const svg = "<svg><rect id='shape_2' x='1'/></svg>";
        const out = call(svg, 'shape_2');
        expect(out, 'single-quoted id not found').to.be.a('string');
        expect(out).to.contain(HIDE);
    });

    it('handles a self-closing tag without breaking it', () => {
        const svg = '<svg><rect id="r1"/></svg>';
        const out = call(svg, 'r1');
        expect(out).to.equal('<svg><rect id="r1" ' + HIDE + '/></svg>');
    });

    it('reports an id that is present nowhere as null, rather than splicing blindly', () => {
        expect(call('<svg><rect id="a"/></svg>', 'missing')).to.equal(null);
        expect(call('', 'a')).to.equal(null);
        expect(call(null, 'a')).to.equal(null);
    });

    it('hides several ids without their offsets interfering', () => {
        const svg = '<svg><rect id="a" x="1"/><rect id="b" x="2"/></svg>';
        const first = call(svg, 'a');
        const both = call(first, 'b');
        expect((both.match(/visibility="hidden"/g) || []).length, 'both elements must be hidden').to.equal(2);
        expect(both).to.contain('id="a"');
        expect(both).to.contain('id="b"');
    });
});
describe('disabling targets the element\'s OWN foreignObject', () => {
    it('is exported', () => {
        expect(typeof utils.domStringForeignObjectOfId, 'helper is missing').to.equal('function');
    });

    it('returns the span of the enclosing foreignObject', () => {
        const svg = '<svg><foreignObject id="fo1"><input id="field_1"/></foreignObject></svg>';
        const scope = utils.domStringForeignObjectOfId(svg, 'field_1');
        expect(scope, 'element not found').to.exist;
        expect(scope.inner).to.contain('id="field_1"');
        expect(scope.before).to.equal('<svg>');
        expect(scope.after).to.equal('</foreignObject></svg>');
    });

    it('IGNORES an id mentioned in a <title> before the element', () => {
        const svg = '<svg><title>field_1</title><foreignObject id="fo1"><input id="field_1"/></foreignObject></svg>';
        const scope = utils.domStringForeignObjectOfId(svg, 'field_1');
        expect(scope, 'must still find the real element').to.exist;
        expect(scope.inner).to.contain('id="field_1"');
    });

    it('scopes to the element\'s own container when several exist', () => {
        const svg = '<svg><foreignObject><input id="a"/></foreignObject><foreignObject><input id="b"/></foreignObject></svg>';
        const scope = utils.domStringForeignObjectOfId(svg, 'b');
        expect(scope, 'element b not found').to.exist;
        expect(scope.inner, 'must scope to the SECOND container').to.contain('id="b"');
        expect(scope.inner, 'must not include the first container').to.not.contain('id="a"');
    });

    it('reports null when there is no enclosing foreignObject', () => {
        expect(utils.domStringForeignObjectOfId('<svg><rect id="r"/></svg>', 'r')).to.equal(null);
        expect(utils.domStringForeignObjectOfId('<svg></svg>', 'nope')).to.equal(null);
        expect(utils.domStringForeignObjectOfId(null, 'r')).to.equal(null);
    });

    it('disabling only touches controls inside the found container', () => {
        const svg = '<svg><foreignObject><select id="s_other"/></foreignObject><foreignObject><select id="s_mine"/></foreignObject></svg>';
        const scope = utils.domStringForeignObjectOfId(svg, 's_mine');
        const disabled = utils.domStringSetAttribute(scope.inner, ['select', 'input', 'button'], 'disabled');
        const out = scope.before + scope.tag + disabled + scope.after;
        expect(out).to.contain('id="s_mine" disabled');
        expect(out, 'the other container must be untouched').to.contain('<select id="s_other"/>');
    });
});

describe('domStringSetAttribute adds attributes without breaking the tag', () => {
    it('separates the attribute from the tag name (the measured corruption)', () => {
        // Measured before the rewrite: '<button id="y">' came back as '<bdisabled utton id="y">'.
        const out = utils.domStringSetAttribute('<button id="y">', ['button'], 'disabled');
        expect(out, 'the tag name must stay intact').to.contain('<button');
        expect(out, 'must not split the tag name').to.not.contain('bdisabled');
        expect(out).to.equal('<button id="y" disabled>');
    });

    it('keeps the separating space when the tag already has attributes', () => {
        const out = utils.domStringSetAttribute('<select id="s" class="c">', ['select'], 'disabled');
        expect(out).to.equal('<select id="s" class="c" disabled>');
    });

    it('preserves the self-closing slash', () => {
        const out = utils.domStringSetAttribute('<input id="i"/>', ['input'], 'disabled');
        expect(out).to.equal('<input id="i" disabled/>');
    });

    it('handles EVERY listed tag, not only the last one', () => {
        const out = utils.domStringSetAttribute('<select id="a"/><input id="b"/><button id="c"/>', ['select', 'input', 'button'], 'disabled');
        expect((out.match(/disabled/g) || []).length, 'all three controls must be disabled').to.equal(3);
    });

    it('does not touch a longer tag name that merely starts with a listed one', () => {
        const out = utils.domStringSetAttribute('<inputfield id="x"/>', ['input'], 'disabled');
        expect(out, 'inputfield is not input').to.equal('<inputfield id="x"/>');
    });

    it('returns the input unchanged when there is nothing to do', () => {
        expect(utils.domStringSetAttribute('<div/>', ['button'], 'disabled')).to.equal('<div/>');
        expect(utils.domStringSetAttribute('<button/>', [], 'disabled')).to.equal('<button/>');
    });
});
