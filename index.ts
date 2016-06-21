import * as fs from "fs";
import * as path from "path";
import * as through from "through2";
const gutil = require("gulp-util");
const swaggerParser = require("swagger-parser");
const swaggerTools = require("swagger-tools").specs.v2; // Validate using the latest Swagger 2.x specification
const CodeGen = require("swagger-js-codegen").CodeGen;
const PLUGIN_NAME = "gulp-ts-swagger";

function loadTemplateFile(template, templateName: string) {
    if (typeof template !== "string" || !template.length) {
        return "";
    }

    template = fs.readFileSync(template, "utf-8");

    if (typeof template !== "string" || !template.length) {
        throw new gutil.PluginError(PLUGIN_NAME, "Could not load " + templateName + " template file. Please make sure path to file is correct.");
    }

    return template;
}

function printErrors(errors: any[]) {
    let message = gutil.colors.red([
        "",
        "",
        "Swagger Schema Errors (" + errors.length + ")",
        "--------------------------",
        errors.map(function (err) {
            return "#/" + err.path.join("/") + ": " + err.message +
                "\n" +
                JSON.stringify(err) +
                "\n";
        }).join("\n"),
        ""
    ].join("\n"));
    gutil.log(message, "");
}

function printWarnings(warnings: any[]) {
    let message = gutil.colors.yellow([
        "",
        "",
        "Swagger Schema Warnings (" + warnings.length + ")",
        "------------------------",
        warnings.map(function (warn) {
            return "#/" + warn.path.join("/") + ": " + warn.message +
                "\n" +
                JSON.stringify(warn) +
                "\n";
        }).join("\n"),
        ""
    ].join("\n"));
    gutil.log(message, "");
}

function buildJSONSchema(swaggerObject) {
    let newPathCollection = {};
    for (let currentPath in swaggerObject.paths) {
        let pathMethods = swaggerObject.paths[currentPath] || {};
        let pathSchemas = Object.keys(pathMethods)
            .reduce(function reduceMethods(newMethodCollection, currentMethod) {
                let methodParameters = (pathMethods[currentMethod].parameters || [])
                    .filter(function filterBodyParameter(parameter) {
                        return parameter.in === "body";
                    })[0] || {};
                let methodResponses = pathMethods[currentMethod].responses || {};
                let methodSchemas = {
                    request: methodParameters.schema,
                    responses: Object.keys(methodResponses)
                        .reduce(function reduceMethods(newResponsesCollection, currentResponse) {
                            let responseSchema = methodResponses[currentResponse].schema || {};

                            newResponsesCollection[currentResponse] = responseSchema;
                            return newResponsesCollection;
                        }, {})
                };

                newMethodCollection[currentMethod] = methodSchemas;
                return newMethodCollection;
            }, {});

        newPathCollection[currentPath] = pathSchemas;
    }

    return newPathCollection;
}

function gulpSwagger(filename, options) {
    // Allow for passing the `filename` as part of the options.
    if (typeof filename === "object") {
        options = filename;
        filename = options.filename;
    }

    // File name is mandatory (otherwise gulp won"t be able to write the file properly)
    if (!filename) {
        throw new gutil.PluginError(PLUGIN_NAME, "A file name is required");
    }

    options = options || {};

    // Flag if user actually wants to use codeGen or just parse the schema and get json back.
    let useCodeGen = typeof options.codegen === "object";
    let codeGenSettings;

    // If user wants to use the codeGen
    if (useCodeGen) {
        // Allow for shortcuts by providing sensitive defaults.
        codeGenSettings = options.codegen || {};
        codeGenSettings.type = codeGenSettings.type || "custom"; // type of codeGen, either: "angular", "node" or "custom".
        codeGenSettings.moduleName = codeGenSettings.moduleName || "API";
        codeGenSettings.className = codeGenSettings.className || "API";

        // If codeGen is of type custom, user must provide templates.
        if (codeGenSettings.type === "custom" && !codeGenSettings.template) {
            throw new gutil.PluginError(PLUGIN_NAME, "Templates are mandatory for a custom codegen");
        }

        // Shortcut: Allow `template` to be a string passing a single template file.
        else if (typeof codeGenSettings.template === "string") {
            let template = fs.readFileSync(codeGenSettings.template, "utf-8");

            if (typeof template !== "string" || !template.length) {
                throw new gutil.PluginError(PLUGIN_NAME, "Could not load template file");
            }

            codeGenSettings.template = {
                class: template,
                method: "",
                request: ""
            };
        }

        // Regular codeGen template object, but allowing for missing templates.
        // (e.g. use case: if `request` is too simple, there's no need for a dedicated template file)
        else if (typeof codeGenSettings.template === "object") {
            codeGenSettings.template.class = loadTemplateFile(codeGenSettings.template.class, "class");
            codeGenSettings.template.method = loadTemplateFile(codeGenSettings.template.method, "method");
            codeGenSettings.template.request = loadTemplateFile(codeGenSettings.template.request, "request");
        }
    }

    function throughObj(file, encoding, callback) {
        let _this = this;

        if (file.isStream()) {
            throw new gutil.PluginError(PLUGIN_NAME, "Streaming not supported");
        }

        function parseSchema(error, swaggerObject) {
            if (error) {
                callback(new gutil.PluginError(PLUGIN_NAME, error));
                return;
            }

            function validateSchema(err, result) {
                if (err) {
                    callback(new gutil.PluginError(PLUGIN_NAME, err));
                    return;
                }

                if (typeof result !== "undefined") {
                    if (result.errors.length > 0) {
                        printErrors(result.errors);
                    }

                    if (result.warnings.length > 0) {
                        printWarnings(result.warnings);
                    }

                    if (result.errors.length > 0) {
                        callback(new gutil.PluginError(PLUGIN_NAME, "The Swagger schema is invalid"));
                        return;
                    }
                }

                function parseSchema2(error, swaggerObject) {
                    if (error) {
                        callback(new gutil.PluginError(PLUGIN_NAME, error));
                        return;
                    }

                    let fileBuffer;

                    if (useCodeGen) {
                        let codeGenFunction = "get" +
                            codeGenSettings.type[0].toUpperCase() +
                            codeGenSettings.type.slice(1, codeGenSettings.type.length) +
                            "Code";

                        codeGenSettings.esnext = true;
                        codeGenSettings.swagger = swaggerObject;
                        delete codeGenSettings.type;

                        codeGenSettings.mustache = codeGenSettings.mustache || {};
                        // Allow swagger schema to be easily accessed inside templates.
                        codeGenSettings.mustache.swaggerObject = swaggerObject;

                        codeGenSettings.mustache.swaggerJSON = JSON.stringify(swaggerObject);
                        // Allow each individual JSON schema to be easily accessed inside templates (for validation purposes).

                        codeGenSettings.mustache.JSONSchemas = JSON.stringify(buildJSONSchema(swaggerObject));

                        fileBuffer = CodeGen[codeGenFunction](codeGenSettings);
                    }
                    else {
                        fileBuffer = JSON.stringify(swaggerObject);
                    }

                    // Return processed file to gulp
                    _this.push(new gutil.File({
                        cwd: file.cwd,
                        base: file.base,
                        path: path.join(file.base, filename),
                        contents: new Buffer(fileBuffer)
                    }));

                    callback();
                }

                // Now that we know for sure the schema is 100% valid,
                // dereference internal $refs as well.
                swaggerParser.dereference(swaggerObject, parseSchema2); // swaggerParser.dereference (internal $refs)
            }

            // Re-Validate resulting schema using different project (2nd pass), the
            // reason being that this validator gives different (and more accurate) resutls.
            swaggerTools.validate(swaggerObject, validateSchema); // swaggerTools.validate
        }

        // Load swagger main file resolving *only* external $refs and validate schema (1st pass).
        // We keep internal $refs intact for more accurate results in 2nd validation pass bellow.
        swaggerParser.dereference(file.history[0], {
            $refs: { internal: false }
        }, parseSchema); // swaggerParser.dereference (external $refs)
    }

    return through.obj(throughObj);
};

module.exports = gulpSwagger;
