import * as fs from "fs";
import * as path from "path";
import * as through from "through2";
import * as gutil from "gulp-util";
const swaggerParser = require("swagger-parser");
const swaggerTools = require("swagger-tools").specs.v2; // Validate using the latest Swagger 2.x specification
const CodeGen = require("swagger-js-codegen").CodeGen;
const PLUGIN_NAME = "gulp-ts-swagger";

/**
 * Loads the template from the file.
 * @param templateFile Name of the template file.
 * @param templateName Name of the template for reporting errors.
 * @return Content of the template file. 
 */
function loadTemplateFile(templateFile: string, templateName: string) {
    if (typeof templateFile !== "string" || !templateFile.length) {
        return "";
    }

    const templateContent = fs.readFileSync(templateFile, "utf-8");

    if (typeof templateContent !== "string" || !templateContent.length) {
        throw new gutil.PluginError(PLUGIN_NAME, "Could not load " + templateName + " template file. Please make sure path to file is correct.");
    }

    return templateContent;
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

interface SwaggerMethodName {
    parameters: any;
    responses: any;
}

interface SwaggerPathMethods {
    [methodName: string]: SwaggerMethodName;
}

interface SwaggerPathsCollection {
    [pathName: string]: SwaggerPathMethods;
}

interface SwaggerObject {
    paths: SwaggerPathsCollection;
}

function buildJSONSchema(swaggerObject: SwaggerObject) {
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

class GulpTypeScriptSwaggerFile {
    private swaggerObject;
    private filename;
    private push;

    constructor(private useCodeGen: boolean, private codeGenSettings: CodeGenSettings, private file, private callback) {
        if (file.isStream()) {
            throw new gutil.PluginError(PLUGIN_NAME, "Streaming not supported");
        }
    }

    process(filename, push) {
        this.filename = filename;
        this.push = push;

        const dereferenceOptions = {
            $refs: { internal: false }
        };
        swaggerParser.dereference(
            this.file.history[0],
            dereferenceOptions,
            (error, swaggerObject) => {
                if (error) {
                    this.callback(new gutil.PluginError(PLUGIN_NAME, error));
                    return;
                }

                this.swaggerObject = swaggerObject;
                this.parseSchema();
            });
    }

    parseSchema() {
        // Re-Validate resulting schema using different project (2nd pass), the
        // reason being that this validator gives different (and more accurate) resutls.
        swaggerTools.validate(this.swaggerObject, (err, result) => {
            this.validateSchema(err, result)
        }); // swaggerTools.validate
    }

    validateSchema(err, result) {
        if (typeof result !== "undefined") {
            if (result.errors.length > 0) {
                printErrors(result.errors);
            }

            if (result.warnings.length > 0) {
                printWarnings(result.warnings);
            }

            if (result.errors.length > 0) {
                this.callback(new gutil.PluginError(PLUGIN_NAME, "The Swagger schema is invalid"));
                return;
            }
        }

        // Now that we know for sure the schema is 100% valid,
        // dereference internal $refs as well.
        this.parseSchema2(this.swaggerObject);
    }

    getCodegenFunction() {
        let codeGenFunction = "get" +
                this.codeGenSettings.type[0].toUpperCase() +
                this.codeGenSettings.type.slice(1, this.codeGenSettings.type.length) +
                "Code";
        return codeGenFunction;
    }

    getCodegenSettings(swaggerObject) {
        this.codeGenSettings.esnext = true;
        this.codeGenSettings.swagger = swaggerObject;
        delete this.codeGenSettings.type;

        this.codeGenSettings.mustache = this.codeGenSettings.mustache || {};
        // Allow swagger schema to be easily accessed inside templates.
        this.codeGenSettings.mustache.swaggerObject = swaggerObject;

        this.codeGenSettings.mustache.swaggerJSON = JSON.stringify(swaggerObject);
        // Allow each individual JSON schema to be easily accessed inside templates (for validation purposes).

        this.codeGenSettings.mustache.JSONSchemas = JSON.stringify(buildJSONSchema(swaggerObject));
        return this.codeGenSettings;
    }

    parseSchema2(swaggerObject) {
        let fileBuffer;

        if (this.useCodeGen) {
            const codeGenFunction = this.getCodegenFunction();
            const codegenSettings = this.getCodegenSettings(swaggerObject);

            fileBuffer = CodeGen[codeGenFunction](codegenSettings);
        }
        else {
            fileBuffer = JSON.stringify(swaggerObject);
        }

        // Return processed file to gulp
        this.push(new gutil.File({
            cwd: this.file.cwd,
            base: this.file.base,
            path: path.join(this.file.base, this.filename),
            contents: new Buffer(fileBuffer)
        }));

        this.callback();
    }
}

interface CodeGenTemplate {
    class: string;
    method: string;
    request: string;
}

interface CodeGenSettings {
    type?: "angular" | "node" | "custom";
    moduleName?: string;
    className?: string;
    template?: string | CodeGenTemplate;

    esnext?: boolean;
    swagger?: any;
    mustache?: any;
}

interface GultTsSwaggerOptions {
    filename?:  string;
    codegen?: CodeGenSettings;
}

function gulpSwagger(filename, options: GultTsSwaggerOptions) {
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
    let codeGenSettings: CodeGenSettings;

    // If user wants to use the codeGen
    if (useCodeGen) {
        // Allow for shortcuts by providing sensitive defaults.
        codeGenSettings = options.codegen || {
            type: null
        };
        codeGenSettings.type = codeGenSettings.type || "custom"; // type of codeGen, either: "angular", "node" or "custom".
        codeGenSettings.moduleName = codeGenSettings.moduleName || "API";
        codeGenSettings.className = codeGenSettings.className || "API";

        // If codeGen is of type custom, user must provide templates.
        if (codeGenSettings.type === "custom" && !codeGenSettings.template) {
            throw new gutil.PluginError(PLUGIN_NAME, "Templates are mandatory for a custom codegen");
        }

        // Shortcut: Allow `template` to be a string passing a single template file.
        else if (typeof codeGenSettings.template === "string") {
            const template = loadTemplateFile(codeGenSettings.template, "class");
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
        if (file.isStream()) {
            throw new gutil.PluginError(PLUGIN_NAME, "Streaming not supported");
        }

        const push = this.push.bind(this);
        const fileRequest = new GulpTypeScriptSwaggerFile(useCodeGen, codeGenSettings, file, callback);
        fileRequest.process(filename, push);
    }
    return through.obj(throughObj);
};

module.exports = gulpSwagger;
