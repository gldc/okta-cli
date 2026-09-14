# okta-cli 19.5.0: Okta Identity Governance (OIG) API coverage

**Goal:** Cover the whole Okta Identity Governance surface (`/governance/api/v1` and `/governance/api/v2`) as one top-level `governance` group (alias `gov`), skipping only the 28 end-user `/my/**` paths. 87 spec paths, one subgroup per family, same `defineResource` machinery as every other group.

**Conventions:** as the "Conventions" section of `docs/superpowers/plans/2026-09-12-more-endpoints.md` (read it — it is the authority for file layout, `defineResource`, `addOutputOptions(addVerbose(...), FIELDS)`, `-b/--body` + `-s/--set` via `bodyOpts`/`bodyFromOpts`, per-file `tests/commands-<group>.test.ts` with a `knownPath()` test for every path plus one mock-server test per subcommand, and `bun run check` green before each commit). Two additions for this release: (a) every governance ResourceSpec/`client.*` call passes an explicit `basePath` (`GOV_V1`/`GOV_V2`) — nothing under `/governance/` resolves against the default `/api/v1`; (b) field names in `defaultFields` must be grepped out of the generated `src/okta/gov-schema.d.ts` before use — the field lists below were read off the spec's list-item schemas on 2026-09-14 and are quoted verbatim, but if the regenerated types disagree, **the spec wins and you record the deviation in a code comment** (see the `BRANDS` "Deviation from the plan" comment in `src/commands/brands.ts` for the house style). Observe the repo's two standing text quirks: never write the pw-word followed by a colon or an equals sign as a literal in a source file (a local filter mangles it - build such path segments by string concatenation, as `src/commands/pw.ts` and the PAM rotate path do), and never write a literal PEM begin-marker span. Neither comes up naturally in this release - no governance path or body field contains either - but the rule still applies to any test fixture you write. Each task's commit message is given; end every commit with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Background (verified against the governance spec, 2026.08.4, on 2026-09-14)

Spec: `https://raw.githubusercontent.com/okta/okta-management-openapi-spec/master/dist/2026.08.4/governance-combined-production-reference-oneOfInheritance.yaml` (115 paths, 770 component schemas). Same `SPEC_VERSION` pin as the management spec already in `scripts/gen-types.ts`.

- **Two base paths.** `/governance/api/v1` (53 non-`/my` paths) and `/governance/api/v2` (34). v2 owns: catalogs, requests, request-conditions / -sequences / -settings, resource entitlement-settings, revoke-principal-access, security-access-reviews, tasks. Several families exist in *both* versions with different schemas (see "Resolved ambiguities").
- **List envelope.** Every list response is `{ data: [...], _links: { self, next? } }`; ~a third also carry `metadata` (`list-metadata`, e.g. `metadata.total` when `include=counts` is passed). `client.getAll(path, { basePath, listKey: "data", query })` already handles this: `nextLinkFallback()` (src/okta/client.ts) falls back to the body's `_links.next.href` when there is no `Link` header, and the follow-up request uses the absolute URL, so `basePath` is irrelevant after page 1.
- **Not every "list-looking" response is an envelope.** `GET /v1/principal-access` returns a single `principal-access` object (`parentResourceOrn, parent, targetPrincipalOrn, targetPrincipal, expirationTime, timeZone, base, additional[]`). `GET /v1/principal-entitlements/history` returns `{ resourceOrn, resource, principalOrn, principal, entitlementHistory: [...], _links, metadata }` — the array key is `entitlementHistory`, **not** `data`. `GET /v1/settings`, `/v1/settings/certification`, `/v2/request-settings`, `/v2/resources/{id}/request-settings`, `/v2/.../entitlement-settings`, `/v1/operations/{id}`, `/v2/security-access-reviews/stats` are plain objects. Use `client.get` (JSON output) for those, not `getAll`.
- **Query parameters.** 37 list endpoints take `filter`, `after`, `limit`; 17 take `orderBy`; 8 take `include`. `after` is never exposed as a CLI option — `getAll` paginates. `limit` is never sent as a query parameter either (see below). `orderBy` is declared as an array with `maxItems: 1`, so a single `--order-by "<prop> asc|desc"` string is correct.
- **`limit` is a client-side cap, not a page size.** Per-endpoint maxima differ (200 on most, 100 on `/v1/principal-entitlements/history`, 50 on the shared `limit` parameter, 10 default on some), and `GET /v1/labels` rejects it outright (`Query parameter limit is unexpected` — it declares only `filter`). So: `--limit <n>` maps to `getAll`'s `max` option and the CLI never puts `limit` in the query string. Document this once in the README governance section.
- **`filter` is REQUIRED (400 without it) on 10 endpoints:** `/v1/entitlements`, `/v1/entitlements/values`, `/v1/grants`, `/v1/principal-access`, `/v1/principal-entitlements`, `/v1/principal-entitlements/history`, `/v1/resource-labels`, `/v1/resource-owners`, `/v1/resource-owners/catalog/resources`, `/v2/catalogs/default/entries` (and `/v2/catalogs/default/user/{userId}/entries`, which shares the same required parameter — 11 operations across 10 declared-required parameter refs). These get a commander **`requiredOption("-f, --filter <expr>", ...)` with no default value** — the repo already learned that a default on a required filter silently masks the 400 and produces wrong results.
- **ORNs are pervasive.** `resourceOrn`/`parentResourceOrn`/`targetResourceOrn`/`principalOrn` path and body fields take Okta Resource Names, e.g. `orn:okta:idp:00ofsdghasfhas54wewe:apps:salesforce:0oafxqCAJWWGELFTYASJ` (gov.yaml:1130), `orn:okta:directory:00o1a2b3c4d5e6f7g8h9:user:00u1a2b3c4d5e6f7g8h1` (gov.yaml:6647), `orn:okta:governance:00o11rndFqmZ5rNfs0g4:collections:cole8sBBMFDxPgcHx0g3` (gov.yaml:12014). `GET /v1/resource-labels?filter=...` *validates* the ORN and answers `Invalid resource orn(s)` for a made-up one, so any live check needs a real app ORN of the form `orn:okta:idp:<orgId>:apps:<appType>:<appId>`. Grep the spec for `orn:okta` for more shapes; do not invent them. `/v2/resources/{resourceOrn}/entitlement-settings` takes an ORN in the **path** — always `encodeURIComponent` it (the colons survive but it keeps slashes safe).
- **PATCH bodies come in two shapes** (checked per endpoint, see the per-task tables):
  - *JSON-patch-style arrays*: `/v1/labels/{labelId}` (`patch-labels`, 1-10 items, `{op,path,value,refType}` with `refType` discriminator `LABEL-CATEGORY`|`LABEL-VALUE`, ops `REPLACE` for category / `ADD`,`REMOVE`,`REPLACE` for value), `/v1/entitlements/{entitlementId}` (`entitlement-patch`, 1-100 items, `refType` `ENTITLEMENT`|`ENTITLEMENT-VALUE`, ops `ADD`,`REMOVE`,`REPLACE`), `/v1/collections/{cid}/assignments/{aid}` (`assignment-patch`, 1-100 items, `{op,path,value}`, no refType), `/v1/resource-owners` (`resource-owners-patch` = `{resourceOrn, data: [{op: "REMOVE", path: "/principalOrn", value}]}` — an object *wrapping* an op array, max 5).
  - *Partial objects*: `/v1/grants/{grantId}` (`grant-patch` = `{id, scheduleSettings}`, both required), `/v1/principal-settings/{targetPrincipalId}` (`{delegates: {appointments: [...]}}`), `/v1/settings` (`{delegates, governanceAI, escalations}`), `/v1/settings/certification` (`{integrations: {settings: [...]}}`), `/v2/request-settings` (`{subprocessorsAcknowledged, integrations}`), `/v2/resources/{id}/request-conditions/{cid}` (`request-condition-patchable`), `/v2/resources/{id}/request-settings` (`{requestOnBehalfOfSettings, riskSettings}`), `/v2/resources/{orn}/entitlement-settings` (`{status: OPTED_IN|OPTED_OUT}`), `/v2/security-access-reviews/{id}` (`{endTime, reviewerSettings}`), `/v2/tasks/{taskId}` (`{assignees: [...]}`).
  - Rule applied below: array-shaped PATCH endpoints get an `--op <ADD|REMOVE|REPLACE> --path <p> --value <v>` triple (plus `--ref-type` where the schema has the discriminator) that builds the single-element array, **and** still accept `-b/--body` for a multi-op array. Object-shaped PATCH endpoints get plain `bodyOpts`/`bodyFromOpts`.
- **`include` serialisation is an open question.** The 8 `include` parameters are declared `type: array` with no `style`/`explode`, so the OpenAPI default is repeated `include=a&include=b`; Okta's docs show the comma form. Six of the eight have a single enum value (`counts`, `full_entitlements`, `parent_resource_owner`), so it only matters for `collection-resources-include-param` (`entitlements`,`entitlementValueCount`), `collection-resource-include-param` (`labels`,`relatedApps`,`resourceProfile`) and `grants-include-param` (`full_entitlements`,`metadata`). Ship `--include <what>` as a repeatable option (`collect`) joined with `,` into one query parameter (`Query` in src/okta/client.ts cannot express repeats), and verify the multi-value case live on runlayer.okta.com in Task 2 (`gov grants list -f '<filter>' --include full_entitlements --include metadata`). If the comma form is rejected, widen `Query` to accept `string[]` in a follow-up ticket rather than in this PR — record it in the PR body.

## Live verification

Two tenants, different licences. Probed read-only with SSWS on 2026-09-14:

- **`runlayer.okta.com`** — campaigns licensed. Answers with data for `/v1/campaigns`, `/v1/reviews`, `/v1/labels` (non-empty), `/v1/entitlement-bundles` (non-empty), `/v1/delegates`, `/v1/settings`, `/v1/settings/certification`, `/v1/settings/integrations` (one `SLACK` integration), `/v1/risk-rules` (`{data:[], metadata:{total:0}}`), `/v2/tasks`, `/v2/requests`, `/v2/security-access-reviews`, `/v2/security-access-reviews/stats` (`{activeCount,closedCount,errorCount,pendingCount}`), `/v2/request-settings`. **Read-only checks only on this tenant.** `/v1/request-types` and `/v1/teams` answer `E0000195` "Authenticated user not assigned to Okta Access Requests" — an app-assignment prerequisite, not a CLI bug; note it in the README. `/v1/collections` is `E0000015` (unlicensed).
- **`integrator-1184409`** (disposable dev tenant, creds in `okta-cli/.env`) — entitlement management only. `/v1/entitlement-bundles` (`{data:[]}`), `/v1/entitlements`, `/v1/grants` (with the required filter) answer; everything else is `E0000015`. **This is the only tenant where write paths (add/replace/patch/delete) may be exercised**, and only for entitlements / entitlement-bundles / grants.
- Everything else is proven by the mock-server tests. Do not attempt live campaign/collection/review writes anywhere.

## Resolved ambiguities (decisions the implementer must not relitigate)

1. **v1 vs v2 `requests` — ship both.** The sparse schemas differ materially, not cosmetically: v1 `request-sparse` = `{id, createdBy, created, lastUpdated, lastUpdatedBy, requestTypeId, subject, requesterUserIds, type(ACCESS_REQUEST|CUSTOM), requestStatus, resolved, permalinkId}`; v2 `request-sparse-2` = `{id, created…, status, resolved, grantStatus, granted, revocationStatus, revoked, requestedBy, requestedFor, requested}` — v2 has no `requestTypeId`/`subject`/`permalinkId` and adds the grant/revocation lifecycle. POST bodies differ too (`request-creatable` vs `request-creatable-2`, 201 vs 202). Decision: `gov requests …` is **v2** (the current surface), `gov requests-v1 …` is the v1 surface. Say so in `--help` text and the README.
2. **v2 `resources`-scoped families are addressed as `<resourceId>` positional arguments, not a `resources` subgroup.** i.e. `gov request-conditions list <resourceId>`, `gov request-sequences list <resourceId>`, `gov request-settings get <resourceId>`, `gov entitlement-settings get <resourceOrn>`. Rationale: a `resources` subgroup would imply a `resources list` endpoint that does not exist in this spec, and the four families have different id types (`resourceId` is "ORN or Okta id"; entitlement-settings takes a strict `resourceOrn`). Be consistent: every one of these takes the resource as the **first** positional.
3. **`gov reviews`** is `/v1/reviews` (campaign reviews, `review-sparse`). `gov campaigns reviews <campaign>` is the same endpoint with `filter=campaignId eq "<id>"` prefilled — a convenience wrapper, not a second implementation. `gov security-access-reviews` is the unrelated v2 family; do not conflate them.
4. **Group alias.** `.alias(` appears nowhere in `src/` today, so `gov` is free. Add it anyway: `subgroup(program, "governance", …).alias("gov")`.
5. **No `--after` option anywhere.** `getAll` paginates; exposing a cursor would be a footgun with `max`.

### Task sizing (paths per task, self-checked against `paths.txt`)

T1 3 · T2 9 · T3 12 · T4 15 · T5 14 · T6 14 · T7 20 · T8 release. Every one of the 87 non-`/my` paths appears in exactly one task - see the coverage table at the end. T7 carries the highest count because 13 of its paths are single-GET subcommands on one family; by files-touched and body-shape work it is the same size as T4-T6.

## Task 1: foundation — governance types, `knownPath`, `ResourceSpec.basePath`, `governance` group skeleton (commit `feat: governance spec types, ResourceSpec basePath, governance group skeleton`)

Files: `scripts/gen-types.ts`, `src/okta/spec-paths.ts`, `src/commands/resource.ts`, `src/commands/governance.ts` (new), `src/cli/program.ts`, `tests/spec-paths.test.ts`, `tests/resource.test.ts`, `tests/commands-governance.test.ts` (new). Generated: `src/okta/gov-schema.d.ts`, `src/okta/gov-spec-paths.json`.

**1a. `scripts/gen-types.ts`** — keep `SPEC_VERSION = "2026.08.4"`; add
```ts
export const GOV_SPEC_URL = `https://raw.githubusercontent.com/okta/okta-management-openapi-spec/master/dist/${SPEC_VERSION}/governance-combined-production-reference-oneOfInheritance.yaml`;
```
Refactor the fetch/parse/emit into a small local `async function emit(url: string, dts: string, paths: string): Promise<void>` and call it twice: `(SPEC_URL, "src/okta/schema.d.ts", "src/okta/spec-paths.json")` and `(GOV_SPEC_URL, "src/okta/gov-schema.d.ts", "src/okta/gov-spec-paths.json")`. Keep the existing `console.log` per spec. Run `bun run gen:types` and commit both generated files (the repo commits `schema.d.ts` today). Expect `gov-spec-paths.json` to hold 115 paths.

**1b. `src/okta/spec-paths.ts`** — import `govSpecPaths from "./gov-spec-paths.json"` and build `templates` from `[...specPaths, ...govSpecPaths]`. Add `"/governance/"` to `FULL_PATH_PREFIXES`. Nothing else changes: governance paths in `gov-spec-paths.json` are already full (`/governance/api/v1/...`), so they must not get the `/api/v1` prefix.
Tests in `tests/spec-paths.test.ts`: `knownPath("/governance/api/v1/campaigns")`, `knownPath("/governance/api/v2/security-access-reviews/x/accesses/y/sub-accesses")`, `knownPath("/governance/api/v2/resources/orn%3Aokta%3Aidp%3Ax%3Aapps%3Aoidc_client%3Ay/entitlement-settings")` → true; `knownPath("/governance/api/v1/nope")` → false; and assert the existing management assertions still pass (merging the lists must not regress them).

**1c. `ResourceSpec.basePath`** (`src/commands/resource.ts`) — add `basePath?: string` to the interface, documented as "API base other than `/api/v1` (e.g. `/governance/api/v1`); passed through to every `client` call this spec drives." Thread it through:
- `resourceList`: `client.getAll(spec.path, { query, listKey: spec.listKey, basePath: spec.basePath, max })` — while here, add `max?: number` to the `resourceList` signature (`resourceList(client, spec, partial, query, max?)`) so the `--limit` cap works for governance lists; existing callers pass nothing and are unaffected.
- `resourceGet`: `client.get(...)` → `client.json("GET", `${spec.path}/${encodeURIComponent(nameOrId)}`, { basePath: spec.basePath })`.
- `add`/`replace`/`delete`/`activate`/`deactivate` in `defineResource`: add `basePath: spec.basePath` to each `client.json(...)` options object.
- `getNested(client, path, arg, nameField, singular, basePath?)` — optional 6th argument, passed to both the `client.json("GET", …)` and the `client.getAll(…)` inside it. Existing 5-arg callers unchanged.

**1d. required filter on `defineResource`'s `list`** — add `filterRequired?: boolean` to `ResourceSpec`. In `defineResource`, when set, use `.requiredOption("-f, --filter <expr>", "Okta SCIM filter expression (required by this endpoint)")` instead of `.option(...)`; **no default value**. Also add `limitOption?: boolean` (default off) which adds `--limit <n>` (parsed with `int`) and passes it as `resourceList`'s `max`.
**And fix the name-lookup fallback for filter-required specs:** `resourceGet` currently falls back to `resourceList(client, spec, nameOrId, query)` when the by-id GET 404s — on a `filterRequired` spec that fallback issues a filterless list and gets a 400 instead of a useful message. When `spec.filterRequired` is set, skip the fallback and throw `new ExitError(`${spec.singular} must be given by id (${spec.path} requires a filter, so name lookup isn't possible).`)`. Test it.

**1e. `src/commands/governance.ts`** — the group skeleton plus the three trivial org-wide reads that prove the wiring end to end:
```ts
export const GOV_V1 = "/governance/api/v1";
export const GOV_V2 = "/governance/api/v2";
```
`export function registerGovernance(program: Command, ctx: Ctx): Command` → `const g = subgroup(program, "governance", "Okta Identity Governance (OIG): access certification, entitlements, access requests").alias("gov");` then, in this file:
- `operations get <operationId>` → GET `${GOV_V1}/operations/{id}`, fields `id,type,status,created,completed,timeElapsedInSeconds` (schema `operation`). Async governance writes return an operation id in `_links`; this is how you poll them.
- `delegates list [--filter <expr>] [--limit <n>]` → GET `${GOV_V1}/delegates`, `listKey "data"`, fields `id,delegate,delegator,startTime,endTime,note` (schema `delegate-appointment`; `delegate`/`delegator` are objects, so a dotted field may read better — grep `delegate-appointment-delegate` in `gov-schema.d.ts` and use `delegate.id`-style dotted paths if the object has an obvious display property).
- `teams list [--filter <expr>] [--limit <n>]` → GET `${GOV_V1}/teams`, `listKey "data"`, fields `id,name,created,lastUpdated` (schema `team`).
These three are plain `addOutputOptions(addVerbose(...))` commands, not `defineResource`.
Every later task adds `registerGovernance<Family>(g, ctx)` calls at the bottom of `registerGovernance`, each imported from its own `src/commands/governance-<family>.ts`.

**1f. `src/cli/program.ts`** — `import { registerGovernance } from "../commands/governance";` (alphabetical, between `registerGroups` and `registerIdps` imports — note the existing import block is only *roughly* alphabetical; match the neighbours) and call `registerGovernance(program, ctx);` in the registration list after `registerGroupRules`.

**Tests (`tests/commands-governance.test.ts`)**: `knownPath` for the three paths above; a `defineResource`-with-`basePath` unit test (a throwaway spec with `basePath: "/governance/api/v1"` — assert `list`/`get`/`add`/`replace`/`delete` all hit `/governance/api/v1/...` on the mock server, and that `_links.next.href` pagination is followed across two pages with `listKey: "data"`); a `filterRequired` test (running `list` without `-f` exits non-zero with commander's "required option" message, and there is no default `filter` in the query when it *is* given); a `--limit` test (two pages of 2, `--limit 3` → 3 rows and no `limit` query parameter sent); and one mock-server test each for `operations get`, `delegates list`, `teams list`. Also add `expect(buildProgram(ctx).commands.find(c => c.name() === "governance")?.aliases()).toContain("gov")`.

**Verification:** `bun run check`; `bun run start -- governance --help` and `bun run start -- gov --help` print the same group.

## Task 2: entitlements, entitlement values, entitlement bundles, grants (commit `feat: governance entitlements, entitlement bundles, grants`)

Files: `src/commands/governance-entitlements.ts` (`registerGovernanceEntitlements(g, ctx)`), `tests/commands-governance-entitlements.test.ts`. 9 paths. This is the only family exercisable live on the dev tenant, so do it first.

```ts
export const GOV_ENTITLEMENTS: ResourceSpec = {
  name: "entitlements", description: "Entitlements (app-level permission definitions)", path: "/entitlements",
  basePath: GOV_V1, singular: "entitlement", nameField: "name", listKey: "data",
  defaultFields: "id,name,externalValue,dataType,multiValue,required,parentResourceOrn",
  filterRequired: true, limitOption: true, replaceable: true, creatable: true, deletable: true,
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc", e.g. "name asc"' }],
};
export const GOV_ENTITLEMENT_BUNDLES: ResourceSpec = {
  name: "entitlement-bundles", description: "Entitlement bundles (named groups of entitlement values)", path: "/entitlement-bundles",
  basePath: GOV_V1, singular: "entitlement bundle", nameField: "name", listKey: "data",
  defaultFields: "id,name,status,targetResourceOrn,description", limitOption: true,
  listOptions: [
    { flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc"' },
    { flags: "--include <what>", param: "include", description: "full_entitlements", choices: ["full_entitlements"] },
  ],
};
export const GOV_GRANTS: ResourceSpec = {
  name: "grants", description: "Access grants (principal -> resource/entitlement assignments)", path: "/grants",
  basePath: GOV_V1, singular: "grant", nameField: "id", idField: "id", listKey: "data",
  defaultFields: "id,status,grantType,action,targetPrincipalOrn,targetResourceOrn,entitlementBundleId",
  filterRequired: true, limitOption: true, deletable: false, replaceable: true, creatable: true,
  listOptions: [{ flags: "--include <what>", param: "include", description: "full_entitlements and/or metadata (repeatable)", choices: ["full_entitlements", "metadata"] }],
};
```
`defineResource` gives `list/get/add/replace/delete` for entitlements, `list/get/add/replace/delete` for bundles, `list/get/add/replace` for grants (no DELETE on `/grants/{id}` in the spec — `deletable: false`; revocation is `gov revoke-principal-access`, Task 6).

Extra subcommands on the `entitlements` group:
- `values-all -f/--filter <expr> [--order-by <expr>] [--limit <n>]` → GET `${GOV_V1}/entitlements/values`, `listKey "data"`, fields `id,name,externalValue,entitlementId,parentResourceOrn` (schema `entitlement-value-with-parent`). `--filter` is a **requiredOption**.
- `values <entitlementId> [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `${GOV_V1}/entitlements/{id}/values`, same fields; filter optional here.
- `value <entitlementId> <valueId>` → GET `${GOV_V1}/entitlements/{id}/values/{valueId}`, same fields (schema `entitlement-value-2`).
- `patch <entitlementId> [-b/--body <json>] [--op <ADD|REMOVE|REPLACE>] [--path <p>] [--value <v>] [--ref-type <ENTITLEMENT|ENTITLEMENT-VALUE>]` → PATCH `${GOV_V1}/entitlements/{id}`. Body is the array `entitlement-patch` (1-100 items). With `-b` the body is used verbatim (must be an array — `ExitError("The body for this endpoint must be a JSON array of patch operations")` if not). With the triple, build `[{ op, path, value, refType }]`; `--ref-type` defaults to `ENTITLEMENT`; when `--ref-type ENTITLEMENT-VALUE`, `value` is an object (`{name,externalValue,description}`) so accept `-s name=…` style assignments for it via `bodyOpts` and nest them under `value` — simpler and explicit: require `-b` for `ENTITLEMENT-VALUE` and document that `--value` is a plain string only valid for `ENTITLEMENT`. `path` examples from the schema: `/name`, `/description` (ENTITLEMENT); `/values/{id}` for REMOVE/REPLACE and `/values/-` for ADD (ENTITLEMENT-VALUE). Fields: entitlement defaults.

Extra subcommands on the `grants` group:
- `patch <grantId> -b/-s` → PATCH `${GOV_V1}/grants/{id}` with the **object** body `grant-patch` = `{id, scheduleSettings}` (both required). Plain `bodyOpts`/`bodyFromOpts`; if `id` is absent from the body, inject the positional `grantId` (the schema requires it and duplicating it on the command line is pointless). Fields: grant defaults.
- Note in a comment that `GET /v1/grants` and `GET /v1/grants/{id}` are `oneOf` (`grants-list`|`grants-list-with-entitlements`, `grant-full`|`grant-full-with-entitlements`) selected by `include=full_entitlements`; the default fields exist in both variants, so no branching is needed.

`add` bodies for reference (do not re-derive): entitlements `entitlement-create`; bundles `entitlement-bundle-creatable`; grants a 4-way `oneOf` (`grant-type-bundle-writeable` | `grant-type-custom-writeable` | `grant-type-policy-writeable` | `grant-type-entitlement-writeable`) discriminated by `grantType` — mention the four values in the `add` description so `-s grantType=…` is discoverable.

**Tests:** `knownPath` for all 9 paths (full `${GOV_V1}${path}` strings). Mock-server tests: entitlements `list` (assert `filter` in query, `limit` **not** in query, `/governance/api/v1/entitlements` path, table output); `list` without `-f` → non-zero exit; `get` by id; `get` by name → the `ExitError` about needing an id (proves 1d); `add` body passthrough; `replace` merge (GET then PUT); `delete`; `patch` triple → body `[{op:"REPLACE",path:"/name",value:"x",refType:"ENTITLEMENT"}]`; `patch -b '[...]'` passthrough; `patch -b '{}'` → ExitError. `values-all` (required filter), `values`, `value`. Bundles `list --include full_entitlements` → `include=full_entitlements`; `get`/`add`/`replace`/`delete`. Grants `list` with `--include full_entitlements --include metadata` → `include=full_entitlements,metadata`; `get`; `add`; `replace`; `patch` injecting `id`. Pagination test on `entitlements list` using `_links.next.href`.

**Live check (dev tenant `integrator-1184409`):** `gov entitlement-bundles list` → `{data:[]}` renders an empty table, exit 0. `gov entitlements list -f '<real app orn filter>'`, `gov grants list -f 'target.externalId eq "<appId>" AND target.type eq "APPLICATION"'`. Run the `--include full_entitlements --include metadata` grants probe against **runlayer.okta.com** to settle the comma-vs-repeat question; record the answer in the PR body.

## Task 3: campaigns, campaign reviews, principal access/entitlements/settings (commit `feat: governance campaigns, reviews, principal access and entitlements`)

Files: `src/commands/governance-campaigns.ts` (`registerGovernanceCampaigns(g, ctx)`), `src/commands/governance-principals.ts` (`registerGovernancePrincipals(g, ctx)`), `tests/commands-governance-campaigns.test.ts`, `tests/commands-governance-principals.test.ts`. 12 paths.

### `governance-campaigns.ts` (7 paths)

```ts
export const GOV_CAMPAIGNS: ResourceSpec = {
  name: "campaigns", description: "Access certification campaigns", path: "/campaigns",
  basePath: GOV_V1, singular: "campaign", nameField: "name", listKey: "data",
  defaultFields: "id,status,name,scheduleType,startDate,endDate,reviewerType",
  limitOption: true, replaceable: false, // no PUT/PATCH on /campaigns/{id}
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc", e.g. "created desc"' }],
};
```
`defineResource` → `list/get/add/delete`. **Record in a code comment:** the list item (`campaign-sparse`) carries `scheduleType`, `startDate`, `endDate`, `reviewerType`, but the `get`/`add` representation (`campaign-full`) does not — it nests those under `scheduleSettings`/`reviewerSettings` and adds `campaignType`. So those four columns render blank on `get`; the default fields follow the repo convention of matching the *list* response, and `get` users should pass `-j`. Do not "fix" this by adding dotted fields that only exist on one side.

Extra subcommands (each takes `<campaign>` = id or unique `name` substring via `resourceGet`):
- `launch <campaign>` → POST `${GOV_V1}/campaigns/{id}/launch`, no body, 202. String result (`addVerbose` only): `campaign {id} ({name}) launched`.
- `end <campaign> [--skip-remediation]` → POST `${GOV_V1}/campaigns/{id}/end`, body `{ skipRemediation: boolean }` (schema `campaign-end-skip-remediation`; only send the key when the flag is given), 202. String result: `campaign {id} ({name}) ended`.
- `reviews-reassign <campaign> --reviewer <userId> --review <reviewId...> --note <text> [--reviewer-level <LEVEL>]` → POST `${GOV_V1}/campaigns/{id}/reviews/reassign`, body `{ reviewerId, reviewIds: [...], note, reviewerLevel? }` (`reviews-reassign`; `reviewerId`, `reviewIds`, `note` are **required**). `--review` is repeatable via `collect`. Response is `review-reassign-list` (`{data:[review-sparse]}`) → fields = `REVIEW_FIELDS` below. Also accept `-b/--body` as an escape hatch (mutually exclusive with the flags; `ExitError("Use either -b or --reviewer/--review/--note")`).
- `reviews <campaign> [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `${GOV_V1}/reviews` with `filter` = `campaignId eq "<resolved id>"` AND-ed with any user `--filter` (`(<user filter>) AND campaignId eq "<id>"`). Convenience wrapper over the standalone `reviews` group; say so in the description.

Standalone `reviews` subgroup in the same file (`subgroup(g, "reviews", "Campaign reviews (certification decisions)")`, not `defineResource` — there is no create/update/delete):
- `REVIEW_FIELDS = "id,campaignId,resourceId,decision,decided,remediationStatus,reviewerType,principalProfile.email,reviewerProfile.email"` — `principal-profile-enriched` has `{id,email,firstName,lastName,login,status,type}`, so the dotted `.email` reads are safe.
- `list [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `${GOV_V1}/reviews`, `listKey "data"`.
- `get <reviewId>` → GET `${GOV_V1}/reviews/{id}` (schema `review-full`).

### `governance-principals.ts` (5 paths)

No `defineResource` — none of these is a CRUD resource. `subgroup(g, "principal-access", …)`, `subgroup(g, "principal-entitlements", …)`, `subgroup(g, "principal-settings", …)`.

- `principal-access get -f/--filter <expr>` → GET `${GOV_V1}/principal-access`. **requiredOption.** Response is a single object (`principal-access`: `parentResourceOrn, parent, targetPrincipalOrn, targetPrincipal, expirationTime, timeZone, base, additional[]`), so `client.get` + `addOutputOptions(..., null)` (JSON by default, like the `rate-limits settings` command in `src/commands/tenant.ts`). Name it `get`, not `list`, precisely because it is not an envelope.
- `principal-entitlements list -f/--filter <expr> [--limit <n>]` → GET `${GOV_V1}/principal-entitlements`, `listKey "data"`, fields `id,name,externalValue,dataType,multiValue,required,parentResourceOrn,targetPrincipalOrn` (schema `principal-entitlement`). **requiredOption.**
- `principal-entitlements history -f/--filter <expr> [--include counts] [--limit <n>]` → GET `${GOV_V1}/principal-entitlements/history`. **The array key is `entitlementHistory`, not `data`** — `client.getAll(path, { basePath: GOV_V1, listKey: "entitlementHistory", query, max })`. Item schema `entitlement-history-record` = `{startDate, endDate, lifecycle(ACTIVE|INACTIVE|SCHEDULED|EXPIRED), entitlements[]}`, so fields `startDate,endDate,lifecycle`. `limit` max here is 100 (still a client-side cap, never sent). `--include counts` populates `metadata.total`, which the table drops — mention in the description that `--include counts -j` is the way to see it.
- `principal-entitlements changes <principalEntitlementsChangeId>` → GET `${GOV_V1}/principal-entitlements-changes/{id}`. Single object (`principal-entitlements-change`: `entitlementsChanged[], resourceOrn, resource, principalOrn, principal`) → JSON default (`addOutputOptions(..., null)`). Note the id is an opaque base64-ish token (spec example `cmVwMWtOQ2NmQnhhRWVEbXcwZzI6cmVwOHBCVVRWVG9na2lYNWUwZzI`) — `encodeURIComponent` it.
- `principal-settings update <targetPrincipalId> -b/-s` → PATCH `${GOV_V1}/principal-settings/{id}`, **object** body `principal-settings-patchable` = `{ delegates: { appointments: [ delegate-patchable ] } }` (max 1 appointment). Response `principal-settings` (`{delegates}`) → JSON default. `targetPrincipalId` is "ORN or Okta id" per the spec parameter `target-principal-id-orn-or-okta`, so accept either and `encodeURIComponent`. There is no GET for this path — say so in the description (`gov delegates list --filter 'delegatorId eq "<id>"'` is the read side).

**Tests:** `knownPath` for all 12 paths. Campaigns: `list` (query `orderBy`, no `limit`), `get` by id and by name substring, `add`, `delete`, `launch` (202 empty body → string result), `end --skip-remediation` (body `{skipRemediation:true}`) and `end` (empty body), `reviews-reassign` (body shape + repeatable `--review`), `reviews <campaign>` (asserts the composed `filter`). Reviews: `list`, `get`. Principals: each of the five, including a `principal-entitlements history` test whose mock returns `{entitlementHistory:[…], _links:{}}` to prove the non-`data` listKey, and a "missing required `-f`" non-zero-exit test for the three required-filter commands.

**Live check (runlayer.okta.com, read-only):** `gov campaigns list`, `gov reviews list --limit 5`, `gov campaigns reviews <campaignId> --limit 5`. Do **not** run `launch`/`end`/`reviews-reassign` anywhere.

## Task 4: collections, labels, resource labels, resource owners (commit `feat: governance collections, labels, resource labels and owners`)

Files: `src/commands/governance-collections.ts` (`registerGovernanceCollections(g, ctx)`), `src/commands/governance-labels.ts` (`registerGovernanceLabels(g, ctx)`), plus the two test files. 15 paths.

### `governance-collections.ts` (8 paths)

```ts
export const GOV_COLLECTIONS: ResourceSpec = {
  name: "collections", description: "Collections (grouped resources with shared assignments)", path: "/collections",
  basePath: GOV_V1, singular: "collection", nameField: "name", listKey: "data",
  defaultFields: "id,name,description,orn,counts.principalAssignmentCount", limitOption: true,
  listOptions: [{ flags: "--include <what>", param: "include", description: "counts", choices: ["counts"] }],
};
```
`defineResource` → `list/get/replace/delete` (+ `add`; POST body `collection-creatable`, PUT body `collection-updatable`). `counts` (`collection-counts` = `{principalAssignmentCount, resourceCounts}`) only appears when `--include counts` is passed, so that column is blank otherwise — note it in the option description.

Extra subcommands, all resolving `<collection>` via `resourceGet(client, GOV_COLLECTIONS, arg)`:
- `ASSIGNMENT_FIELDS = "id,assignmentType,collectionId,expirationTime,timeZone,principalProfile.email,principalProfile.status"` (schema `assigned-principal-details`; `principalProfile` is `principal-profile` = `{id,email,firstName,lastName,login,status}`).
- `assignments-all [--filter <expr>] [--limit <n>]` → GET `${GOV_V1}/collections/assignments` (org-wide, **no** collection argument), `listKey "data"`, `ASSIGNMENT_FIELDS`.
- `assignments <collection> [--filter <expr>] [--limit <n>]` → GET `${GOV_V1}/collections/{cid}/assignments`, same fields.
- `assignment-add <collection> -b/-s` → POST `${GOV_V1}/collections/{cid}/assignments`. Body is an **array** (`add-principals-to-collection`, 1-20 × `assigned-principal` = `{expirationTime, timeZone, principal: {externalId, type}, actor, collectionId}`). With `-b` pass through (ExitError if not an array); with only `-s` wrap the single built object in an array. Response `array<assigned-principal-full>`, 201 → `ASSIGNMENT_FIELDS`.
- `assignment-update <collection> <assignmentId> [-b] [--op <ADD|REMOVE|REPLACE> --path <p> --value <v>]` → PATCH `${GOV_V1}/collections/{cid}/assignments/{aid}`. Array body `assignment-patch` (1-100 × `{op, path, value}`, **no** `refType`). Schema's documented paths: `/expirationTime`, `/timeZone`. Returns 204 → string result `assignment {aid} updated` (`addVerbose` only).
- `assignment-delete <collection> <assignmentId>` → DELETE, 204, string result.
- `catalog-users <collection> [--filter <expr>]` → GET `${GOV_V1}/collections/{cid}/catalog/users`, `listKey "data"`, fields `id,email,firstName,lastName,login,status` (schema `principal-profile`). This endpoint declares **only** `filter` — no `limit`/`after`, so no `--limit` option and no pagination options; still use `getAll` (harmless, `_links.next` simply never appears).
- `RESOURCE_FIELDS = "resourceId,resourceOrn,resourceProfile.name,entitlementValueCount"` (schema `collection-resource-full`; `resourceProfile` is `resource-profile` = `{id,name,label,logo}`).
- `resources <collection> [--include <entitlements|entitlementValueCount>] [--limit <n>]` → GET `${GOV_V1}/collections/{cid}/resources`, `listKey "data"`. `--include` repeatable, joined with `,` (this is one of the three multi-value `include` parameters — see Background).
- `resource-add <collection> -b/-s` → POST `${GOV_V1}/collections/{cid}/resources`. Body is an **array** of `collection-resource-creatable` (`resourceOrn` required, optional `entitlements`); same array-wrapping rule as `assignment-add`. Response is `collection-resources-list` (an envelope) → `RESOURCE_FIELDS`.
- `resource <collection> <resourceId>` → GET `${GOV_V1}/collections/{cid}/resources/{rid}`.
- `resource-replace <collection> <resourceId> -b/-s` → PUT (body `collection-resource-updatable`); with only `-s`, fetch-and-merge like `defineResource`'s `replace` (reuse `omitFields` + `deepMerge`, stripping `_links`/`resourceId`/`resourceOrn`).
- `resource-delete <collection> <resourceId>` → DELETE, 204, string result.

### `governance-labels.ts` (7 paths)

```ts
export const GOV_LABELS: ResourceSpec = {
  name: "labels", description: "Governance label categories and their values", path: "/labels",
  basePath: GOV_V1, singular: "label", nameField: "name", idField: "labelId", listKey: "data",
  defaultFields: "labelId,name,values", replaceable: false, // PATCH only, no PUT
  // GET /v1/labels declares only `filter` - it 400s on `limit` ("Query parameter limit is
  // unexpected"), so no limitOption here even though every other list has one.
};
```
`defineResource` → `list/get/add/delete`. **`idField: "labelId"`** matters: `delete`/`get`-by-name resolve through `idOf(spec, item)`.
- `update <label> [-b] [--op <ADD|REMOVE|REPLACE>] [--path <p>] [--value <v>] [--ref-type <LABEL-CATEGORY|LABEL-VALUE>]` → PATCH `${GOV_V1}/labels/{labelId}`. Array body `patch-labels` (1-**10** items). Discriminator `refType`: `LABEL-CATEGORY` (op `REPLACE` only, path `/name`, value a string ≤50 chars) or `LABEL-VALUE` (ops `ADD`/`REMOVE`/`REPLACE`, path `/values/-` for ADD, `/values/{id}` for REMOVE, `/values/{id}/…` for REPLACE, value an object `label-value-update` = `{name, metadata}`). `--ref-type` defaults to `LABEL-CATEGORY`; for `LABEL-VALUE` require `-b` (the value is an object) and say so in the error. Response `label` → label fields.

`resource-labels` subgroup (`subgroup(g, "resource-labels", "Labels assigned to resources")`, 3 paths):
- `list -f/--filter <expr> [--limit <n>]` → GET `${GOV_V1}/resource-labels`, `listKey "data"`, fields `orn,profile.name,profile.id,labels` (schema `resource-label` = `{orn, profile: external-resource-profile{id,name,description,parent,label,logo}, labels[]}`). **requiredOption**, and the ORN in the filter is validated server-side — the test tenant needs a real app ORN (`orn:okta:idp:<orgId>:apps:oidc_client:<appId>`); grep `orn:okta` in the spec for more shapes.
- `assign --resource <orn...> --label-value <id...>` → POST `${GOV_V1}/resource-labels/assign`, body `{ resourceOrns: [...], labelValueIds: [...] }` (`assign-resource-labels`, both required), both options repeatable via `collect`, plus `-b` escape hatch. Response `{data:[resource-label]}` → same fields as `list`.
- `unassign --resource <orn...> --label-value <id...>` → POST `${GOV_V1}/resource-labels/unassign`, identical body, 204 → string result `labels unassigned from N resource(s)`.

`resource-owners` subgroup (2 paths, 4 operations):
- `list -f/--filter <expr> [--include parent_resource_owner] [--limit <n>]` → GET `${GOV_V1}/resource-owners`, `listKey "data"`, fields `parentResourceOrn,resource.orn,resource.type,principals` (schema `resource-owner` = `{parentResourceOrn, principals: [{id,type,orn,profile}], resource: resource-owner-resource}`). **requiredOption.**
- `set -b/-s` → POST `${GOV_V1}/resource-owners`, body `resource-owners-updatable` = `{principalOrns: [...], resourceOrns: [...]}` (`resourceOrns` required). Response `resource-owners-response` (`{data:[resource-owner]}`) → same fields. Name it `set`, not `add`: the POST is an upsert of the owner list.
- `remove -b | --resource <orn> --principal <orn...>` → PATCH `${GOV_V1}/resource-owners`, body `resource-owners-patch` = `{ resourceOrn, data: [{op: "REMOVE", path: "/principalOrn", value: <principalOrn>}] }` (max **5** ops; `op` enum is `REMOVE` only). Build one op per `--principal`. 204 → string result.
- `catalog-resources -f/--filter <expr> [--limit <n>]` → GET `${GOV_V1}/resource-owners/catalog/resources`, `listKey "data"`, fields `id,type,orn,profile.name` (schema `resource-owner-resource`). **requiredOption.** Note the envelope also has a top-level `parentResourceOrn`, which `getAll` drops — mention `-j` in the description.

**Tests:** `knownPath` for all 15 paths. One mock-server test per subcommand asserting method, `/governance/api/v1/...` path, query and body. Specifically cover: `assignment-add`/`resource-add` array wrapping from `-s` and passthrough from `-b`; `assignment-update` op triple; `labels list` sending **no** `limit` even with a big result set; `labels update` LABEL-CATEGORY triple and the LABEL-VALUE "use -b" error; `resource-labels assign`/`unassign` body shape and repeatable options; `resource-owners remove` building the wrapped op array and rejecting >5 principals (`ExitError`); the three required-filter commands exiting non-zero without `-f`.

**Live check:** `gov labels list` and `gov resource-labels list -f 'orn eq "<real app orn>"'` on runlayer.okta.com (read-only). Collections are unlicensed on both tenants — mock tests only, and say so in the PR body.

## Task 5: request types, access requests (v1 and v2), catalog (commit `feat: governance request types, access requests v1/v2, catalog entries`)

Files: `src/commands/governance-requests.ts` (`registerGovernanceRequests(g, ctx)`), `tests/commands-governance-requests.test.ts`. 14 paths. See "Resolved ambiguities" #1 — both request APIs ship; `requests` is v2, `requests-v1` is v1.

```ts
export const GOV_REQUEST_TYPES: ResourceSpec = {
  name: "request-types", description: "Access request types (request templates)", path: "/request-types",
  basePath: GOV_V1, singular: "request type", nameField: "name", listKey: "data",
  defaultFields: "id,status,name,description,lastUpdated", limitOption: true, replaceable: false,
  listOptions: [{ flags: "--order-by <expr>", param: "orderBy", description: 'property + " asc"/" desc"' }],
};
```
`defineResource` → `list/get/add/delete` (POST body `request-type-creatable`; required `name`, `ownerId`, `resourceSettings`, `approvalSettings` — name them in the `add` description). Plus:
- `publish <request-type>` → POST `${GOV_V1}/request-types/{id}/publish`, no body, 200 `request-type-full` → request-type fields.
- `unpublish <request-type>` → POST `${GOV_V1}/request-types/{id}/un-publish` (note the hyphen in the **path**, not in the command name), same response.

`requests` subgroup — **v2**, `subgroup(g, "requests", "Access requests (v2 API)")`:
- `REQUEST_V2_FIELDS = "id,status,grantStatus,revocationStatus,created,resolved,requestedFor.externalId,requested.entryId"` (schema `request-sparse-2`; `requestedFor` is `target-principal` = `{externalId,type}`, `requested` is `{entryId,resourceId,resourceType,accessScopeId,accessScopeType}`).
- `list [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `${GOV_V2}/requests`, `listKey "data"`.
- `get <requestId>` → GET `${GOV_V2}/requests/{id}` (`request-full-2`).
- `add -b/-s` → POST `${GOV_V2}/requests`, body `request-creatable-2` = `{requested!, requestedFor!, requestedBy?, requesterFieldValues?}`, **202** `request-submission-full` → `REQUEST_V2_FIELDS`.
- `message <requestId> --message <text>` (or `-b`) → POST `${GOV_V2}/requests/{id}/messages`, body `{ message }` (`request-message-creatable`), 201 with no body → string result `message posted to request {id}`.

`requests-v1` subgroup — `subgroup(g, "requests-v1", "Access requests (v1 API; superseded by 'requests')")`:
- `REQUEST_V1_FIELDS = "id,requestStatus,type,subject,requestTypeId,created,resolved"` (schema `request-sparse`; also has `requesterUserIds`, `permalinkId`).
- `list [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `${GOV_V1}/requests`.
- `get <requestId>` → GET `${GOV_V1}/requests/{id}` (`request-full`).
- `add -b/-s` → POST `${GOV_V1}/requests`, body `request-creatable` = `{requestTypeId!, subject!, requesterUserIds?, requesterFieldValues?}`, 201 `request-full`.
- `message <requestId> --message <text>` → POST `${GOV_V1}/requests/{id}/messages`, same `request-message-creatable` body, 201 no body → string result.

`catalog` subgroup — v2 request catalog, `subgroup(g, "catalog", "Request catalog entries (v2)")`:
- `ENTRY_FIELDS = "id,name,label,parent,description"` (schema `rcar-entry`; `requestable` and `counts` are objects — `counts.resourceCounts` only via `-j`).
- `entries -f/--filter <expr> [--match <text>] [--limit <n>]` → GET `${GOV_V2}/catalogs/default/entries`, `listKey "data"`. **requiredOption** (`filter`, spec example `not(parent pr)`); `--match <text>` is a 3-50 char free-text search.
- `entry <entryId>` → GET `${GOV_V2}/catalogs/default/entries/{entryId}` (`rcar-entry-get`).
- `user-entries <userId> -f/--filter <expr> [--match <text>] [--limit <n>]` → GET `${GOV_V2}/catalogs/default/user/{userId}/entries`, same fields. **requiredOption.** `userId` is a strict 20-char Okta id per the spec parameter.
- `request-fields <entryId> <userId>` → GET `${GOV_V2}/catalogs/default/entries/{entryId}/users/{userId}/request-fields`, `listKey "data"`, fields `id,label,type,required,readOnly,value` (schema `request-field`; `choices` is an array — `-j` for it). Note the envelope also carries a `metadata` object.

**Tests:** `knownPath` for all 14 (four under `${GOV_V2}`, ten under `${GOV_V1}`). Mock-server tests per subcommand; explicitly assert that `requests list` hits `/governance/api/v2/requests` and `requests-v1 list` hits `/governance/api/v1/requests` (the whole point of `basePath`), and that `add` on v2 accepts a 202 with a body. Test `publish`/`unpublish` paths character-for-character (`/publish`, `/un-publish`). Test the two required-filter catalog commands.

**Live check (runlayer.okta.com, read-only):** `gov requests list --limit 5` works. `gov request-types list` returns `E0000195` ("Authenticated user not assigned to Okta Access Requests") — that is an app-assignment prerequisite on the tenant, not a bug; capture the exact error text in the README note and do not add a workaround.

## Task 6: resource-scoped request configuration, entitlement settings, revoke access, tasks (commit `feat: governance request conditions/sequences/settings, entitlement settings, revoke access, tasks`)

Files: `src/commands/governance-resources.ts` (`registerGovernanceResources(g, ctx)`), `src/commands/governance-tasks.ts` (`registerGovernanceTasks(g, ctx)`), plus two test files. 14 paths, all `${GOV_V2}`. See "Resolved ambiguities" #2 — the resource is always the **first positional**, there is no `resources` subgroup.

### `governance-resources.ts` (11 paths)

`request-conditions` subgroup (4 paths). `CONDITION_FIELDS = "id,status,priority,name,description,approvalSequenceId"` (schema `request-condition-sparse`; `requesterSettings`/`accessScopeSettings`/`accessDurationSettings` are objects → `-j`).
- `list <resourceId> [--filter <expr>]` → GET `${GOV_V2}/resources/{rid}/request-conditions`, `listKey "data"`. The path-level spec declares only `resourceId`; a `conditions-list-filter` parameter exists in the spec's parameter set but is **not** referenced by this operation — do not add `--filter` unless `gov-spec-paths.json`/`gov-schema.d.ts` shows otherwise after regeneration; if it isn't there, drop the option and note the check in a comment.
- `get <resourceId> <conditionId>` → GET `.../request-conditions/{cid}`.
- `add <resourceId> -b/-s` → POST, body `request-condition-creatable`, 201.
- `update <resourceId> <conditionId> -b/-s` → PATCH, **object** body `request-condition-patchable` = `{name?, description?, requesterSettings?, accessScopeSettings?, accessDurationSettings?, approvalSequenceId?, priority?}` — plain `bodyOpts`/`bodyFromOpts`, no op triple.
- `delete <resourceId> <conditionId>` → DELETE, 204 → string result.
- `activate <resourceId> <conditionId>` / `deactivate <resourceId> <conditionId>` → POST `.../activate` | `.../deactivate`, no body, 200 `request-condition-full` → `CONDITION_FIELDS`.

`request-sequences` subgroup (3 paths). `SEQUENCE_FIELDS = "id,name,description,compatibleResourceTypes"` (schema `request-sequence`).
- `list <resourceId>` → GET `${GOV_V2}/resources/{rid}/request-sequences`, `listKey "data"`.
- `get <resourceId> <sequenceId>` → GET `${GOV_V2}/resources/{rid}/request-sequences/{sid}`.
- `delete <sequenceId>` → DELETE `${GOV_V2}/request-sequences/{sid}` — note the **asymmetry**: the delete path is not resource-scoped, so this command takes only the sequence id. Call that out in the description so nobody "fixes" it. 204 → string result.

`request-settings` subgroup (2 paths, 4 operations). All responses are plain objects → `addOutputOptions(..., null)` (JSON default).
- `get <resourceId>` → GET `${GOV_V2}/resources/{rid}/request-settings` (`request-settings`: `validAccessScopeSettings!, validRequesterSettings!, validAccessDurationSettings!, requestOnBehalfOfSettings, validRiskSettings, riskSettings, validRequestOnBehalfOfSettings`).
- `update <resourceId> -b/-s` → PATCH, object body `resource-request-settings-patchable` = `{requestOnBehalfOfSettings?, riskSettings?}`.
- `org-get` → GET `${GOV_V2}/request-settings` (`org-request-settings`: `subprocessorsAcknowledged!, provisioningStatus!, requestExperiences![], longTimePastProvisioned!, integrations`).
- `org-update -b/-s` → PATCH `${GOV_V2}/request-settings`, object body `org-request-settings-patchable` = `{subprocessorsAcknowledged?, integrations?}`.

`entitlement-settings` subgroup (1 path, 2 operations). Fields `status` (schema `entitlement-settings-full`).
- `get <resourceOrn>` → GET `${GOV_V2}/resources/{orn}/entitlement-settings`. `encodeURIComponent` the ORN.
- `set <resourceOrn> --status <OPTED_IN|OPTED_OUT>` → PATCH, body `{ status }` (`entitlement-settings-updatable`, `status` required, enum `OPTED_IN`/`OPTED_OUT` — use commander `.choices()`), **202**. The response `status` enum is wider (`OPTING_IN|OPTED_IN|OPTING_OUT|OPTED_OUT`) because the change is async — mention `gov operations get <id>` for polling.

`revoke-principal-access` command (1 path, top level on the governance group, not a subgroup):
- `revoke-principal-access --principal <orn> --revoke <orn...>` (or `-b`) → POST `${GOV_V2}/revoke-principal-access`, body `{ principalOrn, revokeOrns: [...], actor? }` (`revoke-principal-access-creatable`; `principalOrn` and `revokeOrns` required). `--revoke` repeatable via `collect`. Response `{data:[{_links}]}` carries only links, so JSON default (`addOutputOptions(..., null)`) and a description saying the `_links` point at the operations to poll.

### `governance-tasks.ts` (3 paths)

`TASK_FIELDS = "id,status,type,label,requestId,createdAt,updatedAt"` (schema `task-sparse`; `assignees` is an array → `-j`).
- `tasks list [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `${GOV_V2}/tasks`, `listKey "data"`.
- `tasks get <taskId>` → GET `${GOV_V2}/tasks/{id}` (`task-full`, adds `isEscalated`, `isDelegated`, `originalAssigneeId`, `completedBy`).
- `tasks update <taskId> --assignee <id...>` (or `-b`) → PATCH `${GOV_V2}/tasks/{id}`, **inline object** body `{ assignees: [...] }` (the spec defines it inline, not as a named schema — grep `task-assignees` in `gov-schema.d.ts` for the item shape before deciding whether `--assignee` takes a bare id or needs `-b`; if the item is an object, make `-b` required and drop `--assignee`). 200 `task-full`.
- `tasks resolve <taskId> --value <v>` → POST `${GOV_V2}/tasks/{id}/resolve`, inline body `{ value: string }`, 200 `task-full`.

**Tests:** `knownPath` for all 14. Mock-server tests per subcommand, asserting the `/governance/api/v2/...` paths (including the un-scoped `request-sequences delete` path), the ORN path-encoding on `entitlement-settings`, the `--status` choices rejection of a bad value, the `revoke-principal-access` body shape with repeated `--revoke`, and both task bodies.

**Live check (runlayer.okta.com, read-only):** `gov tasks list --limit 5` and `gov request-settings org-get` both answer. Everything resource-scoped needs a real resource id/ORN; use mock tests. Never run `revoke-principal-access` against a live tenant.

## Task 7: security access reviews, org settings, integrations, risk rules (commit `feat: governance security access reviews, org settings and integrations, risk rules`)

Files: `src/commands/governance-security-reviews.ts` (`registerGovernanceSecurityReviews(g, ctx)`), `src/commands/governance-settings.ts` (`registerGovernanceSettings(g, ctx)`), plus two test files. 20 paths — the largest count, but 13 of them are near-identical single-GET subcommands.

### `governance-security-reviews.ts` (13 paths, all `${GOV_V2}`)

`subgroup(g, "security-access-reviews", "AI security access reviews (v2)")`. Unrelated to campaign `reviews` (ambiguity #3) — say so in the description.
- `SAR_FIELDS = "id,status,name,endTime,created,lastUpdated"` (schema `security-access-review-sparse`; `reviewerSettings` is an object).
- `list [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `/security-access-reviews`, `listKey "data"`.
- `add -b/-s` → POST `/security-access-reviews`, body `security-access-review-request`, **202** `security-access-review` → `SAR_FIELDS`.
- `stats` → GET `/security-access-reviews/stats`, plain object, fields `activeCount,pendingCount,errorCount,closedCount` (verified live on runlayer.okta.com).
- `get <reviewId>` → GET `/security-access-reviews/{id}` (`security-access-review`, adds `summary: ai-message`).
- `update <reviewId> -b/-s` → PATCH, **object** body `security-access-review-update-request` = `{endTime?, reviewerSettings?}`.
- `ACCESS_FIELDS = "id,type,name,resourceId,severity,remediationStatus"` (schemas `security-access-review-access-item` / `security-access-review-sub-access-item` — the six fields exist on both).
- `accesses <reviewId> [--filter <expr>] [--order-by <expr>] [--limit <n>]` → GET `/{id}/accesses`, `listKey "data"`.
- `sub-accesses <reviewId> <accessId> [--filter] [--order-by] [--limit]` → GET `/{id}/accesses/{accessId}/sub-accesses`, `listKey "data"`.
- `access-action <reviewId> <targetId> --type <REVOKE_ACCESS|RESTORE_ACCESS|FLAG_FOR_MANUAL_REMEDIATION|FLAG_FOR_MANUAL_RESTORATION>` → POST `/{id}/accesses/{targetId}/actions`, body `{ type }` (`security-access-review-accesses-action-request`, required; use `.choices()` with those four enum values), **202** no body → string result.
- `anomalies <reviewId> <targetId>` → GET `/{id}/accesses/{targetId}/anomalies`, `listKey "data"`, fields `type,severity,subtext` (schema `security-access-review-anomaly`; `sodConflicts` is an array → `-j`).
- `access-summary <reviewId> <targetId>` → **POST** `/{id}/accesses/{targetId}/summary` (a POST that generates an AI summary), response `ai-message` = `{message!, deltaMessage, errors}`, fields `message`.
- `summary <reviewId>` → POST `/{id}/summary`, same `ai-message` response.
- `actions <reviewId>` → GET `/{id}/actions`, `listKey "data"`, fields `actionType` (schema `security-access-review-action`).
- `action <reviewId> --type <CLOSE_REVIEW|RESTORE_ALL_ACCESS>` → POST `/{id}/actions`, body `{ actionType }` (`security-access-review-action-request`, required; `.choices()`), 202 no body → string result. Note the deliberate `actions` (GET, plural) vs `action` (POST, singular) pairing, and that the review-level body key is `actionType` while the access-level one is `type` — an easy transposition; assert both in tests.
- `comment <reviewId> --comment <text>` → POST `/{id}/comment`, body `{ comment }` (required), 204 → string result.
- `history <reviewId> [--limit <n>]` → GET `/{id}/history`, `listKey "data"`, fields `id,timestamp,systemGenerated,message,principalProfile.email` (schema `security-access-review-history-item`). Declares only `after` and `limit` — no `filter`/`orderBy`.
- `principal <reviewId>` → GET `/{id}/principal`, plain object, fields `id,email,login,status,type,department,manager,role` (schema `security-access-review-principal`; also has `homeLocation`, `lastLoginInfo`, `oktaAdminRoles` → `-j`).

### `governance-settings.ts` (7 paths, all `${GOV_V1}`)

`settings` subgroup:
- `get` → GET `/settings` (`org-settings` = `{delegates, governanceAI, escalations, integrations}`, all objects) → JSON default.
- `update -b/-s` → PATCH `/settings`, object body `org-settings-patchable` = `{delegates?, governanceAI?, escalations?}` — note `integrations` is read-only here (it is on the GET schema but not the PATCH schema); mention that in the description.
- `certification` → GET `/settings/certification` (`{integrations: {settings: []}}`) → JSON default.
- `certification-update -b/-s` → PATCH `/settings/certification`, object body `org-certification-settings-patchable` = `{integrations}`.
- `integrations` → GET `/settings/integrations`, `listKey "data"`, fields `id,type,status` (schema `integration-readable`). Verified live: one `SLACK` integration on runlayer.okta.com.
- `integration-add --type <t>` (or `-b/-s`) → POST `/settings/integrations`, body `integration-creatable` = `{ type }`; grep `integration-type` in `gov-schema.d.ts` for the enum and wire it as `.choices()`. 201 `integration-full`.
- `integration-delete <integrationId>` → DELETE `/settings/integrations/{id}`, 204 → string result.

```ts
export const GOV_RISK_RULES: ResourceSpec = {
  name: "risk-rules", description: "Separation-of-duties risk rules", path: "/risk-rules",
  basePath: GOV_V1, singular: "risk rule", nameField: "name", listKey: "data",
  defaultFields: "id,name,status,type,description", limitOption: true,
};
```
`defineResource` → `list/get/add/replace/delete` (POST `create-risk-rule-request`, PUT `update-risk-rule-request`). `status` enum is `ACTIVE|INVALID` and `type` is `SEPARATION_OF_DUTIES` only. Plus, on the same group:
- `assess --principal <orn> [--resource <orn...>]` (or `-b`) → POST `${GOV_V1}/risk-rule-assessments`, body `potential-risk-assessment-request` = `{principalOrn!, resourceOrn?, resourceOrnList?}`. One `--resource` → send `resourceOrn`; two or more → send `resourceOrnList`. Response `{data:[rule-conflict]}` → `listKey "data"`, fields `ruleId,ruleName,type,principalOrn,resourceOrn` (schema `rule-conflict`; `conflictCriteria` is an object). Call it `assess` because it is a dry-run "what would conflict" check, not a mutation of anything.

**Tests:** `knownPath` for all 20. Mock-server tests per subcommand. Must-cover: the `actions` GET vs `action` POST pair and their differing body keys (`actionType` vs `type`); `access-summary`/`summary` being POSTs that return `ai-message`; `stats` and `principal` as plain objects; `history` sending no `filter`/`orderBy`; `.choices()` rejection for a bad `--type`; `risk-rules assess` picking `resourceOrn` vs `resourceOrnList` by cardinality; `settings update` rejecting nothing client-side but sending exactly the `-s` keys.

**Live check (runlayer.okta.com, read-only):** `gov security-access-reviews list`, `... stats`, `gov settings get`, `gov settings certification`, `gov settings integrations`, `gov risk-rules list` (returns `{data:[], metadata:{total:0}}` → empty table, exit 0). No writes.

## Task 8: release — README, CHANGES, version bump, PR (commit `docs: 19.5.0 changelog and readme`)

- `package.json` version → `19.5.0`; update the two pinned version tests (`tests/smoke.test.ts:4-5`, `tests/cli.test.ts:23`).
- `CHANGES.rst`: prepend a `v19.5.0` entry (same `=======` underline style) listing the families: campaigns + reviews; entitlements, entitlement values, entitlement bundles, grants; principal access/entitlements/settings; collections (+ assignments, catalog users, resources); labels, resource labels, resource owners; request types and access requests (v1 + v2) and the request catalog; resource request conditions/sequences/settings, entitlement settings, revoke principal access; tasks; security access reviews; org governance settings, integrations, risk rules; delegates, teams, operations. Mention explicitly: new `governance`/`gov` group; `--limit` is a client-side cap (the CLI never sends the `limit` query parameter); `-f/--filter` is mandatory on the 11 endpoints that require it; end-user `/my/**` paths are intentionally not covered.
- `README.md`: add `governance` to the group list; add a `# new in 19.5.0` quickstart block after the `# new in 19.4.0` block (line ~105) with, e.g.:
  ```sh
  okta-cli gov campaigns list
  okta-cli gov reviews list --limit 20
  okta-cli gov entitlement-bundles list --include full_entitlements
  okta-cli gov grants list -f 'target.externalId eq "0oa1b2c3" AND target.type eq "APPLICATION"'
  okta-cli gov security-access-reviews stats
  okta-cli gov tasks list --filter 'status eq "PENDING"'
  ```
  Add a short `### Identity Governance` subsection under Quickstart (or in "Compatibility notes") covering: the two base paths; that `/my/**` end-user paths are out of scope; `--limit` semantics and why `labels list` has none; the required-`--filter` endpoints; the ORN format with a real example; and the two tenant prerequisites seen live — `E0000015` when the OIG feature is unlicensed and `E0000195` "Authenticated user not assigned to Okta Access Requests" when the admin user is not assigned the Access Requests app.
- `bun run check` (typecheck + full test suite) and `bun run build`; then `./dist/okta-cli governance --help`, `./dist/okta-cli gov --help` and `./dist/okta-cli gov campaigns --help` list the expected subcommands.
- Push branch `feat/governance`; `gh pr create --base main` against `gldc/okta-cli` with body sections **Why / What changed / Review focus / Verification** (terse). Review focus should name: the `ResourceSpec.basePath` threading (Task 1c), the `filterRequired` name-lookup change (Task 1d), the `include` comma-vs-repeat finding from Task 2, and the v1/v2 `requests` duplication decision. Verification should list the live read-only probes actually run and on which tenant. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Coverage table (all 87 non-`/my` paths, each in exactly one task)

| Path | Methods | Task | Command(s) |
| --- | --- | --- | --- |
| `/governance/api/v1/delegates` | GET | 1 | `gov delegates list` |
| `/governance/api/v1/operations/{operationId}` | GET | 1 | `gov operations get` |
| `/governance/api/v1/teams` | GET | 1 | `gov teams list` |
| `/governance/api/v1/entitlement-bundles` | POST GET | 2 | `gov entitlement-bundles list` / `add` |
| `/governance/api/v1/entitlement-bundles/{entitlementBundleId}` | GET PUT DELETE | 2 | `gov entitlement-bundles get`/`replace`/`delete` |
| `/governance/api/v1/entitlements` | POST GET | 2 | `gov entitlements list` / `add` |
| `/governance/api/v1/entitlements/values` | GET | 2 | `gov entitlements values-all` |
| `/governance/api/v1/entitlements/{entitlementId}` | DELETE GET PUT PATCH | 2 | `gov entitlements get`/`replace`/`patch`/`delete` |
| `/governance/api/v1/entitlements/{entitlementId}/values` | GET | 2 | `gov entitlements values` |
| `/governance/api/v1/entitlements/{entitlementId}/values/{valueId}` | GET | 2 | `gov entitlements value` |
| `/governance/api/v1/grants` | POST GET | 2 | `gov grants list` / `add` |
| `/governance/api/v1/grants/{grantId}` | GET PUT PATCH | 2 | `gov grants get`/`replace`/`patch` |
| `/governance/api/v1/campaigns` | POST GET | 3 | `gov campaigns list` / `add` |
| `/governance/api/v1/campaigns/{campaignId}` | GET DELETE | 3 | `gov campaigns get` / `delete` |
| `/governance/api/v1/campaigns/{campaignId}/end` | POST | 3 | `gov campaigns end` |
| `/governance/api/v1/campaigns/{campaignId}/launch` | POST | 3 | `gov campaigns launch` |
| `/governance/api/v1/campaigns/{campaignId}/reviews/reassign` | POST | 3 | `gov campaigns reviews-reassign` |
| `/governance/api/v1/principal-access` | GET | 3 | `gov principal-access get` |
| `/governance/api/v1/principal-entitlements` | GET | 3 | `gov principal-entitlements list` |
| `/governance/api/v1/principal-entitlements-changes/{principalEntitlementsChangeId}` | GET | 3 | `gov principal-entitlements changes` |
| `/governance/api/v1/principal-entitlements/history` | GET | 3 | `gov principal-entitlements history` |
| `/governance/api/v1/principal-settings/{targetPrincipalId}` | PATCH | 3 | `gov principal-settings update` |
| `/governance/api/v1/reviews` | GET | 3 | `gov reviews list`, `gov campaigns reviews <c>` |
| `/governance/api/v1/reviews/{reviewId}` | GET | 3 | `gov reviews get` |
| `/governance/api/v1/collections` | POST GET | 4 | `gov collections list` / `add` |
| `/governance/api/v1/collections/assignments` | GET | 4 | `gov collections assignments-all` |
| `/governance/api/v1/collections/{collectionId}` | GET PUT DELETE | 4 | `gov collections get`/`replace`/`delete` |
| `/governance/api/v1/collections/{collectionId}/assignments` | GET POST | 4 | `gov collections assignments` / `assignment-add` |
| `/governance/api/v1/collections/{collectionId}/assignments/{assignmentId}` | PATCH DELETE | 4 | `gov collections assignment-update` / `assignment-delete` |
| `/governance/api/v1/collections/{collectionId}/catalog/users` | GET | 4 | `gov collections catalog-users` |
| `/governance/api/v1/collections/{collectionId}/resources` | GET POST | 4 | `gov collections resources` / `resource-add` |
| `/governance/api/v1/collections/{collectionId}/resources/{resourceId}` | DELETE GET PUT | 4 | `gov collections resource`/`resource-replace`/`resource-delete` |
| `/governance/api/v1/labels` | POST GET | 4 | `gov labels list` / `add` |
| `/governance/api/v1/labels/{labelId}` | DELETE GET PATCH | 4 | `gov labels get`/`update`/`delete` |
| `/governance/api/v1/resource-labels` | GET | 4 | `gov resource-labels list` |
| `/governance/api/v1/resource-labels/assign` | POST | 4 | `gov resource-labels assign` |
| `/governance/api/v1/resource-labels/unassign` | POST | 4 | `gov resource-labels unassign` |
| `/governance/api/v1/resource-owners` | POST GET PATCH | 4 | `gov resource-owners list` / `set` / `remove` |
| `/governance/api/v1/resource-owners/catalog/resources` | GET | 4 | `gov resource-owners catalog-resources` |
| `/governance/api/v1/request-types` | POST GET | 5 | `gov request-types list` / `add` |
| `/governance/api/v1/request-types/{requestTypeId}` | GET DELETE | 5 | `gov request-types get` / `delete` |
| `/governance/api/v1/request-types/{requestTypeId}/publish` | POST | 5 | `gov request-types publish` |
| `/governance/api/v1/request-types/{requestTypeId}/un-publish` | POST | 5 | `gov request-types unpublish` |
| `/governance/api/v1/requests` | GET POST | 5 | `gov requests-v1 list` / `add` |
| `/governance/api/v1/requests/{requestId}` | GET | 5 | `gov requests-v1 get` |
| `/governance/api/v1/requests/{requestId}/messages` | POST | 5 | `gov requests-v1 message` |
| `/governance/api/v2/catalogs/default/entries` | GET | 5 | `gov catalog entries` |
| `/governance/api/v2/catalogs/default/entries/{entryId}` | GET | 5 | `gov catalog entry` |
| `/governance/api/v2/catalogs/default/entries/{entryId}/users/{userId}/request-fields` | GET | 5 | `gov catalog request-fields` |
| `/governance/api/v2/catalogs/default/user/{userId}/entries` | GET | 5 | `gov catalog user-entries` |
| `/governance/api/v2/requests` | GET POST | 5 | `gov requests list` / `add` |
| `/governance/api/v2/requests/{requestId}` | GET | 5 | `gov requests get` |
| `/governance/api/v2/requests/{requestId}/messages` | POST | 5 | `gov requests message` |
| `/governance/api/v2/request-sequences/{sequenceId}` | DELETE | 6 | `gov request-sequences delete` |
| `/governance/api/v2/request-settings` | GET PATCH | 6 | `gov request-settings org-get` / `org-update` |
| `/governance/api/v2/resources/{resourceId}/request-conditions` | GET POST | 6 | `gov request-conditions list` / `add` |
| `/governance/api/v2/resources/{resourceId}/request-conditions/{requestConditionId}` | GET DELETE PATCH | 6 | `gov request-conditions get`/`update`/`delete` |
| `/governance/api/v2/resources/{resourceId}/request-conditions/{requestConditionId}/activate` | POST | 6 | `gov request-conditions activate` |
| `/governance/api/v2/resources/{resourceId}/request-conditions/{requestConditionId}/deactivate` | POST | 6 | `gov request-conditions deactivate` |
| `/governance/api/v2/resources/{resourceId}/request-sequences` | GET | 6 | `gov request-sequences list` |
| `/governance/api/v2/resources/{resourceId}/request-sequences/{sequenceId}` | GET | 6 | `gov request-sequences get` |
| `/governance/api/v2/resources/{resourceId}/request-settings` | GET PATCH | 6 | `gov request-settings get` / `update` |
| `/governance/api/v2/resources/{resourceOrn}/entitlement-settings` | PATCH GET | 6 | `gov entitlement-settings get` / `set` |
| `/governance/api/v2/revoke-principal-access` | POST | 6 | `gov revoke-principal-access` |
| `/governance/api/v2/tasks` | GET | 6 | `gov tasks list` |
| `/governance/api/v2/tasks/{taskId}` | GET PATCH | 6 | `gov tasks get` / `update` |
| `/governance/api/v2/tasks/{taskId}/resolve` | POST | 6 | `gov tasks resolve` |
| `/governance/api/v1/risk-rule-assessments` | POST | 7 | `gov risk-rules assess` |
| `/governance/api/v1/risk-rules` | POST GET | 7 | `gov risk-rules list` / `add` |
| `/governance/api/v1/risk-rules/{ruleId}` | GET PUT DELETE | 7 | `gov risk-rules get`/`replace`/`delete` |
| `/governance/api/v1/settings` | GET PATCH | 7 | `gov settings get` / `update` |
| `/governance/api/v1/settings/certification` | GET PATCH | 7 | `gov settings certification` / `certification-update` |
| `/governance/api/v1/settings/integrations` | GET POST | 7 | `gov settings integrations` / `integration-add` |
| `/governance/api/v1/settings/integrations/{integrationId}` | DELETE | 7 | `gov settings integration-delete` |
| `/governance/api/v2/security-access-reviews` | GET POST | 7 | `gov security-access-reviews list` / `add` |
| `/governance/api/v2/security-access-reviews/stats` | GET | 7 | `gov security-access-reviews stats` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}` | GET PATCH | 7 | `gov security-access-reviews get` / `update` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/accesses` | GET | 7 | `gov security-access-reviews accesses` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/accesses/{securityAccessReviewAccessId}/sub-accesses` | GET | 7 | `gov security-access-reviews sub-accesses` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/accesses/{securityAccessReviewTargetId}/actions` | POST | 7 | `gov security-access-reviews access-action` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/accesses/{securityAccessReviewTargetId}/anomalies` | GET | 7 | `gov security-access-reviews anomalies` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/accesses/{securityAccessReviewTargetId}/summary` | POST | 7 | `gov security-access-reviews access-summary` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/actions` | GET POST | 7 | `gov security-access-reviews actions` (GET) / `action` (POST) |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/comment` | POST | 7 | `gov security-access-reviews comment` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/history` | GET | 7 | `gov security-access-reviews history` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/principal` | GET | 7 | `gov security-access-reviews principal` |
| `/governance/api/v2/security-access-reviews/{securityAccessReviewId}/summary` | POST | 7 | `gov security-access-reviews summary` |

Total: 87 paths. The 28 `/governance/api/v*/my/**` end-user paths are intentionally out of scope (consistent with earlier releases skipping end-user flows); they are listed in `gov-spec-paths.json` so `knownPath()` still accepts them.
