// Karma configuration for the client, written in batch 67 (N-5).
//
// WHY IT DID NOT EXIST: angular.json has pointed at this file (and at src/test.ts) since the
// project was set up, but neither file was ever written and there was not a single .spec.ts
// under src/ - so `ng test` could not run at all, and every client rule had to be enforced by a
// guard on the SERVER side scanning client sources (see test/architecture/controllerErrors.test.js
// and the uiConsistency guards). That works for "does this string appear in the source"; it cannot
// answer "does this arithmetic produce the right buckets", which is what the first tests here do.

module.exports = function (config) {
    config.set({
        basePath: '',
        frameworks: ['jasmine', '@angular-devkit/build-angular'],
        plugins: [
            require('karma-jasmine'),
            require('karma-chrome-launcher'),
            require('karma-jasmine-html-reporter'),
            require('karma-coverage'),
            require('@angular-devkit/build-angular/plugins/karma')
        ],
        client: {
            jasmine: {},
            clearContext: false
        },
        jasmineHtmlReporter: {
            suppressAll: true
        },
        coverageReporter: {
            dir: require('path').join(__dirname, '../coverage'),
            subdir: '.',
            reporters: [{ type: 'html' }, { type: 'text-summary' }]
        },
        reporters: ['progress', 'kjhtml'],
        browsers: ['ChromeHeadlessNoSandbox'],
        customLaunchers: {
            // The container this project is built in has no sandbox available; Chrome refuses to
            // start without this flag and the whole suite then reports "no captured browser".
            ChromeHeadlessNoSandbox: {
                base: 'ChromeHeadless',
                flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
            }
        },
        restartOnFileChange: false,
        singleRun: true
    });
};
