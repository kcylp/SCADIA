'use strict';

const Utils = require('../../runtime/utils');

/**
 * Test hygiene notes (2026-09-29, review item L-03):
 *
 *  - `expect` used to be assigned WITHOUT a declaration, so it leaked into the
 *    global object and every later test file silently inherited it. It is now a
 *    module-local, set up in `before`.
 *  - The `Utils.endTime` case used to assert inside a `setTimeout` callback with
 *    no `done`/promise, so on a loaded machine the assertion fired AFTER the test
 *    had finished. Mocha then attributed the failure to whatever test was running
 *    at that moment (an OPC UA `before all` hook), which is exactly the
 *    "2 Windows environment failures" that were reported for months. The case is
 *    now a fully awaited, deterministic assertion.
 */

describe('Utils Help functions', () => {
    let expect;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    describe('Utils.domStringSplitter with foreignobject', () => {
        it('should split the HTML string correctly using <foreignobject> as the tag', () => {
            const src = `
                <svg>
                    <foreignobject width="100" height="100">
                        <body xmlns="http://www.w3.org/1999/xhtml">
                            <div>Hello SVG World</div>
                        </body>
                    </foreignobject>
                    <circle cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
                </svg>`;
            const tagsplitter = 'foreignobject';
            const first = 0;

            const result = Utils.domStringSplitter(src, tagsplitter, first);

            expect(result).to.be.an('object');
            expect(result).to.have.property('before').that.includes('<svg>');
            expect(result).to.have.property('tagcontent').that.includes('<foreignobject width="100" height="100">');
            expect(result).to.have.property('after').that.includes('<circle cx="50" cy="50" r="40"');
        });

        it('should return empty strings if <foreignobject> is not found', () => {
            const src = `
                <svg>
                    <circle cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
                </svg>`;
            const tagsplitter = 'foreignobject';
            const first = 0;

            const result = Utils.domStringSplitter(src, tagsplitter, first);

            expect(result).to.be.an('object');
            expect(result.tagcontent).to.equal('');
        });

        it('should handle case-insensitivity for <foreignobject> tags', () => {
            const src = `
                <svg>
                    <ForeignObject width="100" height="100">
                        <body xmlns="http://www.w3.org/1999/xhtml">
                            <div>Hello SVG World</div>
                        </body>
                    </ForeignObject>
                    <circle cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" />
                </svg>`;
            const tagsplitter = 'foreignobject';
            const first = 0;

            const result = Utils.domStringSplitter(src, tagsplitter, first);

            expect(result).to.have.property('before').that.includes('<svg>');
            expect(result).to.have.property('tagcontent').that.includes('<ForeignObject width="100" height="100">');
            expect(result).to.have.property('after').that.includes('<circle cx="50" cy="50" r="40"');
        });

        it('should split at the correct occurrence of <foreignobject> if "first" is specified', () => {
            const src = `
                <svg>
                    <foreignobject width="100" height="100">
                        <body xmlns="http://www.w3.org/1999/xhtml">
                            <div>First ForeignObject</div>
                        </body>
                    </foreignobject>
                    <foreignobject width="50" height="50">
                        <body xmlns="http://www.w3.org/1999/xhtml">
                            <div>Second ForeignObject</div>
                        </body>
                    </foreignobject>
                </svg>`;
            const tagsplitter = 'foreignobject';
            const first = src.toLowerCase().indexOf('<foreignobject', src.toLowerCase().indexOf('<foreignobject') + 1); // Second <foreignobject>

            const result = Utils.domStringSplitter(src, tagsplitter, first);

            expect(result).to.have.property('before').that.includes('<foreignobject width="100" height="100">');
            expect(result).to.have.property('tagcontent').that.includes('<foreignobject width="50" height="50">');
            expect(result).to.have.property('after').that.includes('</svg>');
        });
    });

    describe('Utils.domStringSetAttribute - Use', () => {
        it('should add "disabled" attribute to select, input, and button tags', () => {
            const tags = ['select', 'input', 'button'];
            const attribute = 'disabled';

            var tagcontent = `
                    <select name="options">
                        <option value="1">Option 1</option>
                    </select>`;

            // These assertions used to pin WHERE the attribute was inserted ('<select disabled name=...',
            // and '<button disabled >' with the stray space the old code left behind). Placement is
            // not the contract - disabling the control is - and the old placement routine was
            // mangling tags: measured, '<button id="y">' came back as '<bdisabled utton id="y">'.
            // The attribute is now appended to the end of the opening tag, which is equivalent
            // markup and cannot split a tag name. See test/runtime/permissionSvgInjection.test.js.
            const disabledIn = (html, tag) => {
                // (?=[\s/>]|$) rather than \\b: for '<button>' the character after the tag name
                // is '>', and there is no word boundary between 'n' and '>'.
                const m = new RegExp('<' + tag + '(?=[\\s/>]|$)[^>]*>').exec(html);
                return m ? m[0] : null;
            };

            var result = Utils.domStringSetAttribute(tagcontent, tags, attribute);
            expect(disabledIn(result, 'select'), 'select must carry disabled').to.contain('disabled');
            expect(disabledIn(result, 'select')).to.contain('name="options"');
            expect(result, 'the rest of the markup must survive').to.contain('<option value="1">Option 1</option>');

            tagcontent = `<input type="text" value="test" />`;
            result = Utils.domStringSetAttribute(tagcontent, tags, attribute);
            expect(disabledIn(result, 'input'), 'input must carry disabled').to.contain('disabled');
            expect(disabledIn(result, 'input')).to.contain('value="test"');

            tagcontent = `<button>Click Me</button>`;
            result = Utils.domStringSetAttribute(tagcontent, tags, attribute);
            expect(disabledIn(result, 'button'), 'button must carry disabled').to.contain('disabled');
            expect(result, 'the tag name must stay intact').to.not.contain('bdisabled');
        });

        it('should not modify tags not in the list', () => {
            const tagcontent = `
                <div>
                    <textarea>Some text</textarea>
                    <button>Submit</button>
                </div>`;
            const tags = ['input'];
            const attribute = 'disabled';

            const result = Utils.domStringSetAttribute(tagcontent, tags, attribute);

            expect(result).to.include('<textarea>Some text</textarea>');
            expect(result).to.include('<button>Submit</button>');

            expect(result).to.equal(tagcontent);
        });
    });

    describe('Utils.getHostInterfaces', () => {
        it('should return a list of valid network interfaces', async () => {
            const result = await Utils.getHostInterfaces();

            const ipv4 = result.find((iface) =>
                iface.address &&
                (
                    iface.address.startsWith('192.') ||
                    iface.address.startsWith('10.') ||
                    iface.address.startsWith('172.')
                )
            );
            expect(result).to.be.an('array');
            expect(result.length).to.be.greaterThan(0);
            expect(ipv4).to.not.be.undefined;
        });
    });

    describe('Utils.endTime', () => {
        it('returns a positive elapsed time in milliseconds', () => {
            const startTime = new Date();
            const result = Utils.endTime(startTime);
            expect(result).to.be.a('number');
            expect(result).to.be.at.least(0);
        });

        it('measures the elapsed time between two timestamps (deterministic)', () => {
            // Uses an explicit start timestamp instead of a real timer: asserting
            // on wall-clock scheduling is what made the old case flaky under load.
            const start = new Date(Date.now() - 120);
            const result = Utils.endTime(start);
            expect(result).to.be.a('number');
            expect(result).to.be.at.least(100);
        });
    });
});
