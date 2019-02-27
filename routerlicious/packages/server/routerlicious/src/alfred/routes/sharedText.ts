import { IPragueResolvedUrl } from "@prague/container-definitions";
import { IAlfredTenant, IDocumentStorage, ITenantManager } from "@prague/services-core";
import { Router } from "express";
import * as safeStringify from "json-stringify-safe";
import * as jwt from "jsonwebtoken";
import { Provider } from "nconf";
import * as path from "path";
import { parse } from "url";
import { getConfig, getToken } from "../utils";
import { defaultPartials } from "./partials";

const defaultTemplate = "pp.txt";
const defaultSpellChecking = "enabled";

// This one is going to need to have references to all storage options

export function create(
    config: Provider,
    tenantManager: ITenantManager,
    storage: IDocumentStorage,
    appTenants: IAlfredTenant[],
    ensureLoggedIn: any): Router {

    const router: Router = Router();

    /**
     * Loads count number of latest commits.
     */
    router.get("/:tenantId?/:id/commits", ensureLoggedIn(), (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const versionsP = storage.getVersions(tenantId, request.params.id, 30);
        versionsP.then(
            (versions) => {
                response.render(
                    "commits",
                    {
                        documentId: request.params.id,
                        partials: defaultPartials,
                        tenantId,
                        type: "sharedText",
                        versions: JSON.stringify(versions),
                    });
            },
            (error) => {
                response.status(400).json(safeStringify(error));
            });
    });

    /**
     * Loads task graph for the document.
     */
    router.get("/:tenantId?/:id/taskGraph", ensureLoggedIn(), (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const workerConfigP = getConfig(
            config.get("worker"),
            tenantManager,
            tenantId,
            config.get("error:track"),
            config.get("client"));
        const versionP = storage.getLatestVersion(tenantId, request.params.id);
        const token = getToken(tenantId, request.params.id, appTenants);

        Promise.all([workerConfigP, versionP]).then((values) => {
            response.render(
                "taskGraph",
                {
                    config: values[0],
                    documentId: request.params.id,
                    partials: defaultPartials,
                    tenantId,
                    title: request.params.id,
                    token,
                    version: JSON.stringify(values[1]),
                });
        }, (error) => {
            response.status(400).json(safeStringify(error));
        });
    });

    /**
     * Loading of a specific version of shared text.
     */
    router.get("/:tenantId?/:id/commit", ensureLoggedIn(), async (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const disableCache = "disableCache" in request.query;
        const token = getToken(tenantId, request.params.id, appTenants);

        const workerConfigP = getConfig(
            config.get("worker"),
            tenantManager,
            tenantId,
            config.get("error:track"),
            config.get("client"));
        const targetVersionSha = request.query.version;
        const versionP = storage.getVersion(
            tenantId,
            request.params.id,
            targetVersionSha);

        Promise.all([workerConfigP, versionP]).then((values) => {
            const pragueUrl = "prague://" +
                `${parse(config.get("worker:serverUrl")).host}/` +
                `${encodeURIComponent(tenantId)}/` +
                `${encodeURIComponent(request.params.id)}` +
                `?version=${values[1].sha}`;
            const resolved: IPragueResolvedUrl = {
                ordererUrl: config.get("worker:serverUrl"),
                storageUrl: config.get("worker:blobStorageUrl"),
                tokens: { jwt: token },
                type: "prague",
                url: pragueUrl,
            };

            const options = {
                spellchecker: "disabled",
            };
            response.render(
                "sharedText",
                {
                    config: values[0],
                    disableCache,
                    from: Number.NaN,
                    options: JSON.stringify(options),
                    pageInk: request.query.pageInk === "true",
                    partials: defaultPartials,
                    resolved: JSON.stringify(resolved),
                    template: undefined,
                    title: request.params.id,
                    to: Number.NaN,
                    version: JSON.stringify(values[1]),
                });
        }, (error) => {
            response.status(400).json(safeStringify(error));
        });
    });

    router.post("/:tenantId?/:id/fork", ensureLoggedIn(), (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const forkP = storage.createFork(tenantId, request.params.id);
        forkP.then(
            (fork) => {
                response.redirect(`/sharedText/${fork}`);
            },
            (error) => {
                response.status(400).json(safeStringify(error));
            });
    });

    /**
     * Loading of a specific shared text.
     */
    router.get("/:tenantId?/:id", ensureLoggedIn(), async (request, response, next) => {
        const start = Date.now();

        const disableCache = "disableCache" in request.query;
        const direct = "direct" in request.query;

        const tenantId = request.params.tenantId || appTenants[0].id;
        const token = getToken(tenantId, request.params.id, appTenants);

        const from = +request.query.from;
        const to = +request.query.to;

        const jwtToken = jwt.sign(
            {
                user: request.user,
            },
            config.get("alfred:key"));

        const workerConfigP = getConfig(
            config.get("worker"),
            tenantManager,
            tenantId,
            config.get("error:track"),
            config.get("client"),
            direct);

        const fullTreeP = storage.getFullTree(tenantId, request.params.id);

        // Track timing
        const workerTimeP = workerConfigP.then(() => Date.now() - start);
        const treeTimeP = fullTreeP.then(() => Date.now() - start);
        const timingsP = Promise.all([workerTimeP, treeTimeP]);

        Promise.all([workerConfigP, fullTreeP, timingsP]).then(([workerConfig, fullTree, timings]) => {
            const parsedTemplate = path.parse(request.query.template ? request.query.template : defaultTemplate);
            const template =
                parsedTemplate.base !== "empty" ? `/public/literature/${parsedTemplate.base}` : undefined;

            const parsedSpellchecking =
                path.parse(request.query.spellchecking ? request.query.spellchecking : defaultSpellChecking);
            const spellchecker = parsedSpellchecking.base === "disabled" ? `disabled` : defaultSpellChecking;
            const options = {
                spellchecker,
                translationLanguage: "language" in request.query ? request.query.language : undefined,
            };

            timings.push(Date.now() - start);

            const pragueUrl = "prague://" +
                `${parse(config.get("worker:serverUrl")).host}/` +
                `${encodeURIComponent(tenantId)}/` +
                `${encodeURIComponent(request.params.id)}`;
            const resolved: IPragueResolvedUrl = {
                ordererUrl: config.get("worker:serverUrl"),
                storageUrl: config.get("worker:blobStorageUrl"),
                tokens: { jwt: token },
                type: "prague",
                url: pragueUrl,
            };

            response.render(
                "sharedText",
                {
                    cache: JSON.stringify(fullTree.cache),
                    config: workerConfig,
                    disableCache,
                    from,
                    jwt: jwtToken,
                    options: JSON.stringify(options),
                    pageInk: request.query.pageInk === "true",
                    partials: defaultPartials,
                    resolved: JSON.stringify(resolved),
                    template,
                    timings: JSON.stringify(timings),
                    title: request.params.id,
                    to,
                });
            }, (error) => {
                response.status(400).json(safeStringify(error));
        });
    });

    return router;
}
