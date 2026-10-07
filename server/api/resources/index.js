/**
 * 'api/resources': Diagnose API to GET resources: images
 */

const fs = require('fs');
const path = require('path');
var express = require("express");
const authJwt = require('../jwt-helper');
const Report = require('../../runtime/jobs/report');
const fontkit = require('fontkit');
const os = require('os');
const { resolveWithin } = require('../path-helper');
const { projectGuard } = require('../_domain');

var runtime;
var secureFnc;
var checkGroupsFnc;

/**
 * The three template routes answer 501: the feature is deliberately NOT in this release.
 *
 * WHAT WAS WRONG. They were written against `runtime.resourcesMgr`, which is never created anywhere
 * in the tree (measured, batch 75: the name appears in this file and nowhere else). Every call threw
 * `TypeError: Cannot read properties of undefined (reading 'getTemplates')` and Express answered its
 * default HTML 500 page - so an operator saw a stack trace and read it as "the system is broken".
 *
 * WHY 501 AND NOT A WORKING MANAGER. The decision on 2026-10-04 was that widget/project templates are
 * not part of this release; building the manager is a feature, not a fix, and shipping a plausible
 * empty answer would hide that. 501 says exactly what is true, in the same { error, message } frame
 * every other domain uses, and leaves the route discoverable instead of deleting public surface.
 */
function sendTemplatesNotImplemented(res, op) {
    runtime.logger.warn('api resources ' + op + ': templates are not implemented in this release');
    res.status(501).json({
        error: 'RES_TEMPLATES_NOT_IMPLEMENTED',
        message: 'widget/project templates are not part of this release'
    });
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        var resourcesApp = express();
        resourcesApp.use(projectGuard(() => runtime));

        /**
         * GET Server images folder content
         */
        resourcesApp.get('/api/resources/images', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api get resources/images: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api get resources/images: Unauthorized!");
            } else {
                try {
                    var result = { ...req.query, ...{ groups: [] } };
                    var resourcesDirs = getDirectories(runtime.settings.imagesFileDir);
                    for (var i = 0; i < resourcesDirs.length; i++) {
                        var group = { name: resourcesDirs[i], items: [] };
                        var dirPath = path.resolve(runtime.settings.imagesFileDir, resourcesDirs[i]);
                        var wwwSubDir = path.join('_images', resourcesDirs[i]);
                        // Recurse so nested assets under each group appear in the editor picker
                        // (relative path kept in name/path to avoid collisions).
                        var files = getFilesRecursive(dirPath, ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.mp4', '.webm', '.ogg', '.ogv']);
                        for (var x = 0; x < files.length; x++) {
                            var filename = files[x].replace(/\.[^\/.]+$/, '');
                            group.items.push({ path: path.join(wwwSubDir, files[x]).split(path.sep).join(path.posix.sep), name: filename });
                        }
                        result.groups.push(group);
                    }
                    res.json(result);
                } catch (err) {
                    if (err.code) {
                        res.status(400).json({ error: err.code, message: err.message });
                    } else {
                        res.status(400).json({ error: "unexpected_error", message: err.toString() });
                    }
                    runtime.logger.error("api get resources/images: " + err.message);
                }
            }
        });

        /**
         * GET Server resources folder content
         */
        resourcesApp.get('/api/resources/resources', secureFnc, function (req, res) {
            try {
                const resourcesFilter = { fonts: ['ttf'] };
                const wwwSubDir = '_resources';
                const result = { ...req.query, ...{ groups: [] } };
                const group = { name: wwwSubDir, items: [] };
                var files = getFiles(runtime.settings.resourcesFileDir, ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.pdf', '.ttf', '.mp4', '.webm', '.ogg', '.ogv']);
                for (var x = 0; x < files.length; x++) {
                    const fileName = files[x];
                    const filePath = path.join(wwwSubDir, files[x]).split(path.sep).join(path.posix.sep);
                    var fileLabel;
                    if (resourcesFilter.fonts.some(suffix => fileName.endsWith(suffix))) {
                        const font = fontkit.openSync(filePath);
                        fileLabel = font.fullName;
                    }

                    group.items.push({
                        path: filePath,
                        name: fileName,
                        label: fileLabel
                    });
                }
                result.groups.push(group);
                res.json(result);
            } catch (err) {
                if (err.code) {
                    res.status(400).json({ error: err.code, message: err.message });
                } else {
                    res.status(400).json({ error: "unexpected_error", message: err.toString() });
                }
                runtime.logger.error("api get resources/resources: " + err.message);
            }
        });

        /**
         * Keep the readable name; only step aside when a DIFFERENT file already claims it.
         * Using the same library asset twice must reuse the copy, not grow the project with
         * files nobody can tell apart.
         */
        function freeNameFor(dir, name, source) {
            const ext = path.extname(name);
            const stem = path.basename(name, ext);
            let candidate = path.join(dir, name);
            let n = 1;
            while (fs.existsSync(candidate)) {
                try {
                    if (fs.readFileSync(candidate).equals(fs.readFileSync(source))) {
                        return candidate;
                    }
                } catch (err) { /* unreadable: fall through and step aside */ }
                n += 1;
                candidate = path.join(dir, stem + '-' + n + ext);
            }
            return candidate;
        }

        /**
         * POST copy one built-in library asset into THIS project.
         *
         * The library ships with the software and is shared by every project; the picture a
         * screen references must not. A shared reference would let a library update silently
         * change the screen a plant was signed off with, so using an asset COPIES it into the
         * project's own images folder and the copy is what the view points at. The project stays
         * self-contained, portable, and frozen.
         */
        resourcesApp.post('/api/resources/useAsset', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api post resources/useAsset: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api post resources/useAsset: Unauthorized");
            } else {
                try {
                    const requested = req.body?.file;
                    const resolved = resolveWithin(runtime.settings.assetsDir, requested);
                    if (!resolved || !fs.existsSync(resolved.resolvedTarget)) {
                        res.status(400).json({ error: "unknown_asset", message: "No such library asset." });
                        return;
                    }
                    const group = 'library';
                    const targetDir = path.join(runtime.settings.imagesFileDir, group);
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                    const target = freeNameFor(targetDir, path.basename(resolved.normalized), resolved.resolvedTarget);
                    if (!fs.existsSync(target)) {
                        fs.copyFileSync(resolved.resolvedTarget, target);
                    }
                    const wwwPath = path.join('_images', group, path.basename(target)).split(path.sep).join(path.posix.sep);
                    runtime.logger.info("library asset '" + path.basename(resolved.normalized) + "' is now the project's '" + wwwPath + "'", true);
                    res.json({ path: wwwPath, name: path.basename(target, path.extname(target)) });
                } catch (err) {
                    if (err && err.code) {
                        res.status(400).json({ error: err.code, message: err.message });
                    } else {
                        res.status(400).json({ error: "unexpected_error", message: err.toString() });
                    }
                    runtime.logger.error("api post resources/useAsset: " + (err && err.message ? err.message : err));
                }
            }
        });

        /**
         * POST remove resource file
         */
        resourcesApp.post('/api/resources/remove', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api post device: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api post remove resource: Unauthorized");
            } else {
                try {
                    const resolvedFile = resolveWithin(runtime.settings.resourcesFileDir, req.body.file);
                    if (!resolvedFile) {
                        res.status(400).json({ error: "invalid_path", message: "Invalid resource path." });
                        return;
                    }
                    const filePath = resolvedFile.resolvedTarget;
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                    runtime.logger.info(`resources '${filePath}' deleted!`, true);
                    res.end();
                } catch (err) {
                    if (err && err.code) {
                        res.status(400).json({ error: err.code, message: err.message });
                        runtime.logger.error("api remove resource: " + err.message);
                    } else {
                        res.status(400).json({ error: "unexpected_error", message: err });
                        runtime.logger.error("api remove resource: " + err);
                    }
                }
            }
        });

        /**
         * GET svg/canvas rendered and converted to image
         */
        resourcesApp.get('/api/resources/generateImage', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api get resources/generateImage: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api get resources/generateImage: Unauthorized!");
            } else {
                try {
                    var query = JSON.parse(req.query.param);
                    const report = Report.create(null, runtime);
                    report.getChartImage(query).then((content) => {
                        res.end(content.toString('base64'));
                    }).catch(function (err) {
                        if (err.code) {
                            res.status(400).json({ error: err.code, message: err.message });
                        } else {
                            res.status(400).json({ error: "unexpected_error", message: err.toString() });
                        }
                        runtime.logger.error("createImage: " + err.message);
                    });
                } catch (err) {
                    if (err.code) {
                        res.status(400).json({ error: err.code, message: err.message });
                    } else {
                        res.status(400).json({ error: "unexpected_error", message: err.toString() });
                    }
                    runtime.logger.error("api get resources/generateImage: " + err.message);
                }
            }
        });

        /**
         * GET Templates
         * Take from resources storage and reply
         */
        resourcesApp.get("/api/resources/templates", secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api get templates: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api get templates: Unauthorized!");
            } else {
                sendTemplatesNotImplemented(res, 'getTemplates');
            }
        });

        /**
         * POST template
         */
        resourcesApp.post('/api/resources/template', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api post device: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api post template: Unauthorized");
            } else {
                sendTemplatesNotImplemented(res, 'setTemplate');
            }
        });

        /**
         * DELETE template
         */
        resourcesApp.delete("/api/resources/templates", secureFnc, function (req, res, next) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api delete templates: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api delete templates: Unauthorized");
            } else {
                sendTemplatesNotImplemented(res, 'removeTemplates');
            }
        });

        /**
        * GET Server widgets folder content
        */
        resourcesApp.get('/api/resources/widgets', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api get resources/widgets: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
                runtime.logger.error("api get resources/widgets: Unauthorized!");
            } else {
                try {
                    var result = { ...req.query, ...{ groups: [] } };
                    var resourcesDirs = getDirectories(runtime.settings.widgetsFileDir);
                    for (var i = 0; i < resourcesDirs.length; i++) {
                        var group = { name: resourcesDirs[i], items: [] };
                        var dirPath = path.resolve(runtime.settings.widgetsFileDir, resourcesDirs[i]);
                        var wwwSubDir = path.join('_widgets', resourcesDirs[i]);
                        var files = getFilesRecursive(dirPath, ['.svg']);
                        for (var x = 0; x < files.length; x++) {
                            var filename = files[x];
                            group.items.push({
                                path: path.join(wwwSubDir, files[x]).split(path.sep).join(path.posix.sep),
                                name: filename
                            });
                        }
                        result.groups.push(group);
                    }
                    res.json(result);
                } catch (err) {
                    if (err.code) {
                        res.status(400).json({ error: err.code, message: err.message });
                    } else {
                        res.status(400).json({ error: "unexpected_error", message: err.toString() });
                    }
                    runtime.logger.error("api get resources/widgets: " + err.message);
                }
            }
        });

        /**
         * POST Remove Server widget item
         */
        resourcesApp.post('/api/resources/removeWidget', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error("api resources/removeWidget: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                runtime.logger.error("api resources/removeWidget: Unauthorized!");
                return res.status(401).json({ error: "unauthorized_error", message: "Unauthorized!" });
            }
            try {
                let relPath = req.body?.path;
                if (!relPath || typeof relPath !== 'string') {
                    return res.status(400).json({ error: "invalid_path", message: "Missing or invalid widget path." });
                }
                let basePath = path.resolve(runtime.settings.appDir);
                if (process.versions.electron) {
                    basePath = process.env.userDir || path.join(os.homedir(), '.scadia');
                }
                const resolvedWidget = resolveWithin(basePath, relPath);
                if (!resolvedWidget) {
                    runtime.logger.error("api resources/widgets: security_violation " + relPath);
                    return res.status(403).json({ error: 'security_violation', message: 'Invalid path' });
                }
                const fullPath = resolvedWidget.resolvedTarget;

                if (!fs.existsSync(fullPath)) {
                    return res.status(404).json({ error: "not_found", message: "Widget file not found." });
                }

                try {
                    fs.unlinkSync(fullPath);
                    res.json({ success: true, path: relPath });
                } catch (err) {
                    runtime.logger.error("api removeWidget: " + err.message);
                    res.status(500).json({ error: "delete_failed", message: err.message });
                }
            } catch (err) {
                if (err.code) {
                    res.status(400).json({ error: err.code, message: err.message });
                } else {
                    res.status(400).json({ error: "unexpected_error", message: err.toString() });
                }
                runtime.logger.error("api resources/removeWidget: " + err.message);
            }
        });

        return resourcesApp;
    }
}

function getDirectories(pathDir) {
    const directoriesInDIrectory = fs.readdirSync(pathDir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name);
    return directoriesInDIrectory;
}

function getFiles(pathDir, extensions) {
    const filesInDIrectory = fs.readdirSync(pathDir)
        .filter((item) => extensions.indexOf(path.extname(item).toLowerCase()) !== -1);
    return filesInDIrectory;
}

function getFilesRecursive(pathDir, extensions, baseDir = pathDir) {
    const entries = fs.readdirSync(pathDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const entryPath = path.join(pathDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...getFilesRecursive(entryPath, extensions, baseDir));
        } else if (extensions.indexOf(path.extname(entry.name).toLowerCase()) !== -1) {
            files.push(path.relative(baseDir, entryPath));
        }
    }
    return files;
}
