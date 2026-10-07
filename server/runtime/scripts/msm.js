
/*
* My Script Module: script container, scripts defined in frontend (string code) are to load as function
*/

'use strict';
const path = require('path');
const utils = require("../utils");

var Module = module.constructor;

// const eventsIncludes = 'var events = require("../events").create();';
const requireInclude = `const path = require('path');`;
// The script-facing console stub. Every level is defined, because a script that calls
// console.warn() or console.error() against a stub that only HAS log() throws a TypeError -
// and that throw is swallowed by the per-script try/catch below, so the script dies silently
// with no output at all. Defining the whole set makes an unsupported level harmless.
const eventsIncludes = 'var events; var id;' +
    ' function makeConsoleFn(level) {' +
    '   return function () {' +
    '     if (events) {' +
    '       try {' +
    "         events.emit('script-console', { msg: Array.prototype.map.call(arguments, function (a) { return (typeof a === 'string') ? a : JSON.stringify(a); }).join(' '), type: level, id: id });" +
    '       } catch (e) { /* a logging failure must never break the script */ }' +
    '     }' +
    '   };' +
    ' }' +
    ' var console = { log: makeConsoleFn(\'log\'), warn: makeConsoleFn(\'warn\'), error: makeConsoleFn(\'error\'), info: makeConsoleFn(\'info\'), debug: makeConsoleFn(\'debug\') };';
// const eventsIncludes = 'var events = require("../events").create();';// var console = { log: function (msg) { if (events) events.emit(\'script-console\', { msg: msg, type: \'log\' });}}';
// The synthetic entry that binds events/id inside the generated module. It needs an id of its own:
// keyed by the plain name 'init', a project script NAMED 'init' would have collided with it (the
// same collision class as scriptKey above).
const initEvents = { id: '__scadia_init__', name: 'init', code: 'events = _events; id = _id', parameters: [{ name: '_events' }, { name: '_id' }] };
// const setSystemFunctions = { name: 'setSysFunctions', code: 'Object.keys(systemFunctions).forEach(k => {  });', parameters: [{ name: '_sysfncs' }] };
// const consoleLog = { name: 'console', code: 'log: function (msg) { if (events) events.emit(\'script-console\', { msg: msg, type: \'log\' });}', parameters: [] };
// tempScripts['console.error'] = 'function (msg) { events.emit(\'device-status:changed\', { msg: msg, type: \'error\' }); }';

/**
 * The key a script is stored under: its id when it has one, its name otherwise.
 *
 * WHY NOT THE NAME (a real defect, measured 2026-10-06). Both maps in this module used the DISPLAY
 * name as the key, and a name is free text a project may repeat:
 *
 *   result.scriptsMap[script.name] = script;      // msm.js  - the second 'Twin' replaced the first
 *   schedulingMap[script.name] = scriptSchedule;  // index.js - the second 'Twin' was never run
 *
 * so two scripts sharing a name meant one of them was silently unscheduled, and the other became
 * un-authorisable: getScript() could not find it, so isAuthorised() read .permissionRoles off
 * undefined, threw, and answered "not authorised". Nothing was logged. The id is the identity the
 * platform already uses everywhere else (the generated function name is derived from it - see
 * _toFuncName), so it is the key here too. Name remains the fallback for hand-written project files
 * that carry scripts without ids.
 */
function scriptKey(script) {
    if (!script) { return ''; }
    if (script.id) { return String(script.id); }
    return String(script.name);
}

function MyScriptsModule(_events, _logger) {
    var events = _events;
    var logger = _logger;
    var module = new Module();
    var scriptsMap = {};
    var systemFunctions = {};
    var scriptsModule;

    this.init = function (sysfncs) {
        systemFunctions = sysfncs;
        Object.keys(systemFunctions).forEach(k => {
            global[k] = systemFunctions[k];
        });
    }

    this.loadScripts = function (_scripts) {
        let result = _scriptsToModule(_scripts);
        scriptsModule = result.module;
        scriptsMap = result.scriptsMap;
        return result;
    }

    this.runTestScript = function (_script) {
        // clone scripts and add or replace script to test
        var tempScripts = utils.clone(scriptsMap);
        tempScripts[scriptKey(_script)] = _script;
        tempScripts[scriptKey(initEvents)] = initEvents;

        var result = _scriptsToModule(tempScripts, eventsIncludes);
        if (result.module) {
            var paramValues = _paramValues(_script);
            result.module[_toFuncName(initEvents)](events, _script.outputId);
            return _moduleFunc(_script)(...paramValues);
        }
        throw new Error(result);
    }

    this.runScript = function (_script) {
        if (scriptsModule) {
            var paramValues = _paramValues(_script);
            if (_script.id) {
                _script = Object.values(scriptsMap).find(s => s.id === _script.id);
            }
            try {
                return _moduleFunc(_script)(...paramValues);
            } catch (err) {
                console.error(err);
                return err;
            }
        }
    }

    this.runScriptWithoutParameter = function (_script) {
        if (scriptsModule) {
            if (!_script.name) {
                _script = Object.values(scriptsMap).find(s => s.id === _script.id);
            }
            try {
                return _moduleFunc(_script)();
            } catch (err) {
                console.error(err);
                return err;
            }
        }
    }

    this.runSysFunction = function (functionName, params) {
        return global[functionName](...params || []);
    }

    this.getScript = function (_script) {
        return Object.values(scriptsMap).find(s => s.id === _script.id);
    }

    this.getScriptByName = function (scriptName) {
        return Object.values(scriptsMap).find(s => s.name === scriptName);
    }

    /**
     * 由脚本 id 派生一个合法的 JS 函数名。
     *
     * WHY THIS EXISTS - a real defect, measured.
     * The generated module used to be built with the script's DISPLAY name as the function
     * name: the generated text was  'async function <script.name> (params) { ... }'.  A name
     * is free text, so a script named  OEE 计算  produced 'function OEE 计算 () {}' - a
     * SyntaxError.  Every script in a project is concatenated into ONE module, so a single bad
     * name failed _compile, was swallowed below as 'return ex', left scriptsModule null, and
     * from then on EVERY script silently returned undefined.  (Measured: 每班产量汇总 compiles
     * - CJK has been a legal identifier character since ES2015 - while 'OEE 计算', 'oee-calc'
     * and '1oee' do not.  The illegal parts are the SPACE, the hyphen and the leading digit.)
     *
     * The id is already a valid identifier by platform convention (s_<function>_<action>);
     * the strip-and-prefix is a belt-and-braces guard for hand-edited project files.
     */
    /**
     * The values to pass to a script function, in declaration order.
     *
     * `parameters` is OPTIONAL: the shipped demo carries parameters:[], but a hand-written project
     * file - the MES/EMS template among them - simply omits it. Reading .length/.map on it threw,
     * both at load time and at run time, so such a script could never be called. Absence means
     * "takes no parameters".
     */
    var _paramValues = function (script) {
        return (script.parameters || []).map(p => utils.isNullOrUndefined(p.value) ? p : p.value);
    }

    var _toFuncName = function (script) {
        return 'fn_' + String(script.id).replace(/[^a-zA-Z0-9_]/g, '_');
    }

    /**
     * Find the module export for a script: by id, then by name.
     *
     * Order is deliberate and load-bearing. runscriptSecurity.test.js:92 asks for
     * {id:'public-script-id', name:'admin_script'} while an ACTUAL script named
     * 'admin_script' exists - resolving that by name would run the wrong script and turn an
     * authorization test green-to-red. So an id is authoritative when present, and the name
     * is consulted only by callers that have nothing else (the name-only path of
     * runScriptWithoutParameter, kept for backwards compatibility).
     */
    var _moduleFunc = function (script) {
        if (!script || !scriptsModule) {
            return null;
        }
        var match = null;
        if (script.id) {
            match = Object.values(scriptsMap).find(s => s.id === script.id);
        } else if (script.name) {
            match = Object.values(scriptsMap).find(s => s.name === script.name);
        }
        return scriptsModule[_toFuncName(match || script)] || null;
    }

    var _scriptsToModule = function (_scripts, _includes) {
        let result = { module: null, messages: [], scriptsMap: {} };
        try {
            let functions = '';
            let toexport = '';
            Object.values(_scripts).forEach((script) => {
                try {
                    if (script.code) {
                        var params = '';
                        // A script MAY arrive without a parameters array - the shipped demo project always
                        // carries parameters:[], which is why this read as safe for so long, but a
                        // hand-written project file (and the MES/EMS template) simply omits the field.
                        // Reading .length on it threw inside the per-script try below, so the script was
                        // reported as 'load.script <name> error' and never became callable - the whole
                        // scheduled script silently did nothing. Absence means 'no parameters'.
                        var scriptParams = script.parameters || [];
                        for (let i = 0; i < scriptParams.length; i++) {
                            if (params.length) params += ',';
                            params += `${scriptParams[i].name}`;
                        }
                        const asyncText = script.sync ? '' : 'async';
                        // The function name comes from the id, never from the display name - a
                        // name is free text and may not be a legal JS identifier (see _toFuncName).
                        const funcName = _toFuncName(script);
                        functions += `${asyncText} function ${funcName} (${params}) { try { ${script.code} \n} catch (scadiaError) { console.log(scadiaError); return JSON.stringify(scadiaError); } }`;
                        toexport += `${funcName}: ${funcName}, `;
                        result.scriptsMap[scriptKey(script)] = script;
                    } else {
                        logger.warn(`load.script ${script.name} without code!`);
                        result.messages.push(`load.script ${script.name} without code!`);
                    }
                } catch(e) {
                    logger.error(`load.script ${script.name} error: ${(e.stack) ? e.stack : e}`);
                    result.messages.push(`load.script ${script.name} error!`);
                }
            });
            var code = '';
            if (_includes) {
                code = `${_includes}`;
            }
            var code = `${requireInclude} ${code} ${functions} module.exports = { ${toexport} };`;
            var filename = path.resolve(__dirname, 'msm-scripts.js');
            result.module = _requireFromString(code, filename);
        } catch(ex) {
            logger.error(`load.script error: ${(ex.stack) ? ex.stack : ex}`);
            return ex;
        }
        return result;
    }

    var _requireFromString = function (src, filename) {
        delete require.cache[filename];
        var Module = module.constructor;
        var m = new Module();
        m._compile(src, filename);
        return m.exports;
    }
}

module.exports = {
    create: function (events, logger) {
        return new MyScriptsModule(events, logger);
    },
    // Shared with runtime/scripts/index.js so the two maps key scripts the same way (see scriptKey).
    scriptKey: scriptKey
};
