# okta-cli Bun/TypeScript Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python `okta-cli` (18.1.2) with a drop-in-compatible TypeScript CLI on Bun, then add Platform-admin, Automation, Identity & Access, and user-profile command groups driven by Okta's published OpenAPI spec.

**Architecture:** One hand-rolled `OktaClient` over `fetch` (SSWS auth, 429 retry via `X-Rate-Limit-Reset`, `Link: rel="next"` pagination, `_links` stripping). Types for request/response bodies come from `openapi-typescript` output of the pinned Okta management spec (`components["schemas"]`); a generated `spec-paths.json` lets a unit test catch path typos. Commands are pure handlers `(client, opts, ...args) => result` registered on `commander`, wrapped by one `action()` that does output formatting and exit codes. New resource groups are declared with a `defineResource()` descriptor that emits `list/get/add/replace/delete/activate/deactivate`.

**Tech Stack:** Bun 1.3.5, TypeScript 5.9 (NOT 7 — `openapi-typescript` 7.13 crashes on TS 7), `commander@15`, `papaparse@5`, `yaml@2`, `read-excel-file@9`, `bun:sqlite` (embedded wordlist), `bun test`, `bun build --compile`.

**Decision recorded:** `openapi-fetch` was evaluated (typechecks fine) and rejected. Every command needs Link-header pagination, `_links` stripping, partial-name lookups and a `raw` escape hatch, all of which need an untyped path anyway; two call styles is more surface than one. Path typos are caught by the `spec-paths.json` test instead.

## Global Constraints

- Repo: `~/Developer/okta-cli` (fork of flypenguin/okta-cli), branch `rewrite/bun`, PR into `main` of `gldc/okta-cli`. Never push to `main`.
- Version: `19.0.0`. Python source is deleted; git history is the reference (`git show main:src/oktacli/cli.py`).
- Drop-in compatibility: every command, flag, default table column, message string and exit code listed in the "Compatibility surface" section below must be preserved. Known Python bugs listed there are fixed and recorded in `CHANGES.rst`.
- Exit codes: `ExitError` → 255 (Python `sys.exit(-1)`), `CommunicationError` → 255, `OktaApiError` → 253, anything else → 254.
- Config file location must equal Python `appdirs.user_config_dir("okta-cli") + "/config.json"`: macOS `~/Library/Application Support/okta-cli/config.json`; Linux `${XDG_CONFIG_HOME:-~/.config}/okta-cli/config.json`; Windows `%LOCALAPPDATA%\okta-cli\okta-cli\config.json`. `OKTA_CLI_CONFIG` env var overrides the path. `OKTA_URL` + `OKTA_TOKEN` env vars together bypass the file.
- `.tool-versions` pins `bun 1.3.5`. `package.json` pins `typescript` to `^5.9.0`.
- Pinned spec: `https://raw.githubusercontent.com/okta/okta-management-openapi-spec/master/dist/2026.08.4/management-oneOfInheritance.yaml` (the `-noExamples` variant has dangling `$ref`s to examples and fails generation).
- Tests: `bun test`. Every HTTP-touching test uses `tests/fixtures/server.ts` (a `Bun.serve` mock), never the network.
- Commit after each task with a conventional-commit message. Run `bun run check` (typecheck + tests) before every commit.
- Terse commit messages and PR body; concision over grammar.

## Compatibility surface (from 18.1.2, verified against `src/oktacli/cli.py`)

Global on every command: `-h/--help`. On commands marked (out) below, output options: `-j/--json`, `-y/--yaml`, `--csv`, `--csv-dialect <d>` (default `excel`), `--output-fields <csv>` (default per command), `--colwidth <n>`. On every API command: `-v/--verbose` counting (`-vvvvv`).

Output rules: handler returns string → print as-is; `-j` → JSON indent 2 sorted keys; `-y` → YAML; `--csv` → CSV of sorted dotted keys; else if the command has default fields and result non-empty → table; else JSON. Table: each cell left-padded to max column width, followed by two spaces; missing field → column width 1 plus stderr `WARNING: field X either never filled or non-existant.`; `--colwidth` truncates to `n` chars + `...`.

Error output: `ERROR: <msg>` (stderr, 255); `COMMUNICATION_ERROR: <msg>` (stderr, 255); `OKTA_API_ERROR: <code>: <summary>` then one `errorSummary: <text>` line per cause (stdout, 253); otherwise stack trace + `CRITICAL_ERROR` banner (stderr, 254).

| Group | Command | Args / flags | Default fields |
|---|---|---|---|
| config | new | `-n/--name -u/--url -t/--token` (prompt if missing; url must start `https://`) → `Profile 'X' added.` | |
| config | list | prints `name  url  ***last4  (CURRENT)` per line | |
| config | use-context | `<profile-name>` → `Default profile set to 'X'.` | |
| config | delete | `<profile-name>` → `Profile 'X' deleted.` + `New default profile: Y` or `No more profiles left.` | |
| config | file | prints path | |
| config | current-context | `Current profile set to 'X'.` or `No profile set.` (Python bug: printed nothing; fixed) | |
| pw | reset | `<login-or-id> -n/--no-email` → POST `/users/{id}/lifecycle/reset_password?sendEmail=` | |
| pw | expire | `<login-or-id> -t/--temp-password` → POST `/users/{id}/lifecycle/expire_password?tempPassword=` | |
| pw | set | `<login-or-id> -s/--set <pw> -g/--generate --expire/--no-expire (default expire) -l/--language en -m/--min-length 14` → POST `/users/{id}` `{credentials:{password:******** then expire → `PASSWORD_EXPIRED: <pw>` or `PASSWORD: ******** neither -s nor -g → `ERROR: Either use -s or -g!` | |
| groups | list (out) | `[partial_name] -f/--filter -q/--query -a/--all` (Python `-a` took a value by mistake; now a flag) — OKTA_GROUP only unless -a | `id,type,profile.name` |
| groups | add (out) | `-n/--name -d/--description` → POST `/groups` | `id,type,profile.name` |
| groups | apps (out) | `<name-or-id>` → GET `/groups/{id}/apps` sorted by label | `id,name,label` |
| groups | delete (out) | `<name-or-id>` → `group {id} deleted` | |
| groups | get (out) | `<name-or-id>` | `id,type,profile.name` |
| groups | adduser | `-g/--group -u/--user -f/--user-lookup-field login` → PUT `/groups/{gid}/users/{uid}` → `User {uid} ({login}) added to group {gid} ({name})` | |
| groups | removeuser | same flags → DELETE → `User {uid} ({login}) removed from group {gid} ({name})` | |
| groups | users (out) | `<id-or-unique>` → GET `/groups/{id}/users` sorted by login (lowercase) | `id,profile.login,profile.firstName,profile.lastName,profile.email` |
| groups | clear | `<name-or-id> -i/--id` → DELETE each user (Python used the raw arg instead of the resolved id in the path; fixed) → `All users removed from group {gid} ({name})` | |
| apps | add | `-n/--name <APP_TYPE> -m/--signonmode <MODE> -l/--label -s/--set k=v...` prefixes `sa.`→`settings.app.`, `v.`→`visibility.`, `f.`→`features.`, `c.`→`credentials.`; bookmark default `sa.requestIntegration=false`; signOnMode defaulted from name | |
| apps | activate / deactivate / delete | `<label-or-id>` → `application {id} ({label}) activated|deactivated|deleted` | |
| apps | list (out) | `[partial_name] -f/--filter -q/--query` sorted by label (lowercase) | `id,label` |
| apps | users (out) | `<app>` → GET `/apps/{id}/users` sorted by credentials.userName | `status,id,credentials.userName,` |
| apps | get (out) | `[partial_name]` | `id,name,label` |
| apps | getuser (out) | `-a/--app -u/--user -f/--user-lookup-field` → GET `/apps/{aid}/users/{uid}` | `id,credentials.userName,scope,status,syncState` |
| apps | adduser (out) | `-a -u -f -s k=v...` → POST `/apps/{aid}/users` `{id: uid, ...nested sets}` | `id,credentials.userName,scope,status,syncState` |
| apps | removeuser | `-a -u -f` → DELETE → `User {uid} ({login}) removed from app {aid} ({label})` | |
| apps | addgroup (out) | `-a -g` → PUT `/apps/{aid}/groups/{gid}` | none (json) |
| apps | removegroup | `-a -g` → DELETE → `App {aid} ({label}) removed from group {gid} ({name})` | |
| apps | groups (out) | `<app>` → GET `/apps/{id}/groups` sorted by id | none (json) |
| users | list (out) | `-m/--match FIELD=VALUE... -p/--partial -f/--filter -s/--search -q/--query -d/--deprovisioned`; `-d` ANDs `status eq "DEPROVISIONED"` into search; `-m` filters case-insensitively on `profile.FIELD` (regex fullmatch, or search with -p); sorted by login | `id,status,profile.login,profile.firstName,profile.lastName,profile.email` |
| users | get (out) | `<lookup_value> -f/--field login`; if value starts with `0` and is 20 chars try GET `/users/{id}` first; else search `profile.{field} eq "{value}"`; 0 → `No user found with {field}={value}`, >1 → `Criteria not unique, found N matches` | same as list |
| users | groups (out) | `<user> -f/--user-lookup-field` → GET `/users/{id}/groups` sorted by profile.name | `id,profile.name,profile.description` |
| users | apps (out) | `<user> -f` → GET `/users/{id}/appLinks` sorted by label | `appInstanceId,appName,label` |
| users | deactivate | `<login_or_id> -e/--send-email --no-confirmation`; prompt `DANGER!! Do you REALLY want to do this (maybe use 'suspend' instead)?\nThen enter '{x}': ` must echo the arg else `ERROR: Aborted.` → `User {x} deactivated.` | |
| users | activate (out) | `<login_or_id> -e/--send-email` → POST `/users/{id}/lifecycle/activate?sendEmail=true` (param only when flag) | none |
| users | reactivate (out) | same for `/lifecycle/reactivate` | none |
| users | unlock | → `User '{x}' unlocked.` | |
| users | delete | `<login_or_id> -e --no-confirmation`; prompt `DANGER!! Do you REALLY want to do this?\nThen enter '{x}': ` → `User {x} deleted.` | |
| users | suspend | → POST `/lifecycle/suspend`, prints response JSON | |
| users | update | `<user_id> -s/--set k=v... -S/--array-set k=a,b... -c/--context <prefix>` → POST `/users/{id}` nested body | |
| users | bulk-add | `<file> -s k=v... --activate/--no-activate (true) --provider/--no-provider (false) --nextlogin/--no-nextlogin (false) -g/--group GID... -i/--jump-to-index 0 -l/--limit 0 -w/--workers 25`; requires `profile.login` column; ignores columns without `.`; writes `okta-bulk-add-YYYYMMDD_HHMMSS-added.json` / `-errors.json`; summary `   N added  - file\n   N errors\nN total` | |
| users | bulk-update | `<file> -s -i -u/--jump-to-user -l -w`; `id` column preferred over `profile.login`; `okta-bulk-update-...-updated.json` / `-errors.json` | |
| users | add | `-s k=v... -p/--profile k=v... -g GID... --activate/--no-activate (true) --provider/--no-provider (false) --nextlogin/--no-nextlogin (false)` → POST `/users?activate=True|False&provider=True|False[&nextlogin=changePassword]`; only dotted keys kept; `-p` overrides `-s` | |
| features | list (out) | `[partial_name] -f/--partial-name-field name -m/--match k=v... -p/--partial (default true)` sorted by name | `id,status,stage.value,type,name` |
| features | get / enable / disable / dependents / dependencies (out) | `[partial_name] -f/--partial-name-field name --force` (`?mode=force` on enable/disable) | `id,status,stage.value,type,name` |
| eventhooks | list / get (out) | `[partial_name]` matched on `name` | `id,created,status,verificationStatus,name` |
| eventhooks | add (out) | `-u/--url -n/--name -e/--event a,b -e c` → POST `/eventHooks` `{name, events:{type:"EVENT_TYPE", items}, channel:{type:"HTTP", version:"1.0.0", config:{uri}}}` | same |
| eventhooks | update (out) | `<partial_name> -u -n -e` → PUT `/eventHooks/{id}` | same |
| eventhooks | activate / deactivate / verify (out) | `<partial_name>` → POST `/eventHooks/{id}/lifecycle/{activate|deactivate|verify}` (Python `activate` called deactivate; fixed) | same |
| eventhooks | delete | → `event hook {id} ({name}) deleted` | |
| (root) | dump | `-d/--dir --no-user-list --no-app-users --no-group-users`; dir default `okta-dump-YYYYMMDDHHMMSS`; writes `users.csv` (incl. DEPROVISIONED), `groups.csv`, `apps.csv`, `group_users.csv` (`group,user`), `app_users.csv` (`app,user`) | |
| (root) | raw (out) | `<api_endpoint> -X/--http-method get|post|put|delete|patch -q/--query k=v... -b/--body <json|FILE:path> --base-path` | none |
| (root) | version | prints `19.0.0`; also `--version` | |

---

## File structure

```
.tool-versions                     bun 1.3.5
package.json                       name okta-cli, version 19.0.0, bin okta-cli → src/main.ts, scripts
tsconfig.json
.gitignore                         node_modules/, dist/, okta-dump*, /*.json, /*.csv, .DS_Store
scripts/gen-types.ts               download pinned spec → src/okta/schema.d.ts + src/okta/spec-paths.json
src/main.ts                        process entry: buildProgram(defaultCtx()).parseAsync
src/version.ts                     VERSION = "19.0.0"
src/okta/errors.ts                 ExitError, CommunicationError, OktaApiError
src/okta/client.ts                 OktaClient (request/json/get/getAll), URL + Link helpers
src/okta/schema.d.ts               GENERATED, checked in (≈54k lines)
src/okta/spec-paths.json           GENERATED list of path templates, checked in
src/okta/types.ts                  `export type Schema<K> = components["schemas"][K]` convenience
src/config.ts                      configPath/loadConfig/saveConfig/resolveProfile/activeProfile
src/lib/dotted.ts                  flatToNested/nestedToFlat/dottedKeys/getDotted/parseAssignments/deepMerge
src/lib/output.ts                  toSortedJson/toCsv/toTable/formatResult
src/lib/body.ts                    parseBody(bodyArg, sets) for -b/-s style inputs
src/lib/filter.ts                  filterDicts (users list -m / features list -m)
src/lib/lookup.ts                  retrieve/getOne/selectors/getUser/getGroup/getApp
src/lib/files.ts                   csvReader/excelReader/fileReader
src/lib/concurrency.ts             mapConcurrent with stderr progress
src/lib/pwgen.ts                   generatePassword via embedded bun:sqlite wordlist
src/assets/wordlist.sqlite         moved from src/oktacli/wordlist.sqlite
src/cli/options.ts                 collect/count/addVerbose/addOutputOptions
src/cli/context.ts                 IO, Ctx, defaultCtx, action()
src/cli/program.ts                 buildProgram(ctx) wiring every command module
src/commands/config.ts             config group
src/commands/users.ts              users group (all subcommands incl. new ones)
src/commands/users-bulk.ts         bulk-add / bulk-update handlers
src/commands/pw.ts                 pw group
src/commands/groups.ts             groups group incl. `groups rules`, roles
src/commands/apps.ts               apps group
src/commands/features.ts           features group
src/commands/eventhooks.ts         eventhooks group
src/commands/misc.ts               dump, raw, version
src/commands/resource.ts           ResourceSpec + defineResource() + resourceGet()
src/commands/logs.ts               logs list
src/commands/tokens.ts             api tokens
src/commands/roles.ts              roles group
src/commands/org.ts                org group
src/commands/platform.ts           trusted-origins, domains, zones, log-streams descriptors
src/commands/inlinehooks.ts        inlinehooks + hook-keys
src/commands/schemas.ts            schemas group + linked-objects
src/commands/user-types.ts         user-types
src/commands/policies.ts           policies group
src/commands/authenticators.ts     authenticators + sessions
src/commands/idps.ts               idps group
tests/fixtures/server.ts           startServer(routes) Bun.serve mock with recorded calls
tests/fixtures/ctx.ts              testCtx(serverUrl) → { ctx, out, err }
tests/*.test.ts                    one file per src module / command group
testdata/*.csv                     kept from Python repo (used by files tests)
.github/workflows/ci.yml           bun install → bun run check
.github/workflows/release.yml      on tag v*: compile 4 targets, attach to GitHub release
Dockerfile                         oven/bun:1.3.5 image running the CLI
Makefile                           test / check / build / release helpers
README.md, CHANGES.rst, LICENSE
```

Deleted in Task 1: `src/oktacli/`, `tests/*.py`, `requirements*.{in,txt}`, `pyproject.toml`, `tox.ini`, `run.py`, `MANIFEST.in`, `.pre-commit-config.yaml`, `tools/`, old `Dockerfile`, old `Makefile`.

---

### Task 1: Scaffold Bun project, remove Python

**Files:**
- Create: `package.json`, `tsconfig.json`, `.tool-versions`, `.gitignore`, `src/version.ts`, `src/main.ts` (placeholder), `tests/smoke.test.ts`
- Move: `src/oktacli/wordlist.sqlite` → `src/assets/wordlist.sqlite`
- Delete: everything listed under "Deleted in Task 1"

**Interfaces:**
- Produces: `VERSION` const from `src/version.ts`; `bun run check` script (typecheck + tests).

- [ ] **Step 1: Delete the Python tree and move the wordlist**

```bash
cd ~/Developer/okta-cli
git mv src/oktacli/wordlist.sqlite src/wordlist.sqlite
git rm -rq src/oktacli tests requirements.in requirements.txt requirements-dev.in requirements-dev.txt pyproject.toml tox.ini run.py MANIFEST.in .pre-commit-config.yaml tools Dockerfile Makefile
mkdir -p src/assets && git mv src/wordlist.sqlite src/assets/wordlist.sqlite
```

- [ ] **Step 2: Write project files**

`.tool-versions`:
```
bun 1.3.5
```

`package.json`:
```json
{
  "name": "okta-cli",
  "version": "19.0.0",
  "description": "An Okta command line interface for scripting and quickly performing routine tasks",
  "license": "MIT",
  "type": "module",
  "bin": { "okta-cli": "src/main.ts" },
  "scripts": {
    "start": "bun src/main.ts",
    "typecheck": "tsc -p .",
    "test": "bun test",
    "check": "bun run typecheck && bun test",
    "gen:types": "bun scripts/gen-types.ts",
    "build": "bun build --compile src/main.ts --outfile dist/okta-cli"
  },
  "dependencies": {
    "commander": "^15.0.0",
    "papaparse": "^5.7.0",
    "read-excel-file": "^9.3.10",
    "yaml": "^2.9.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/papaparse": "^5.5.2",
    "openapi-typescript": "^7.13.0",
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src", "tests", "scripts"]
}
```

`.gitignore`:
```
node_modules/
dist/
okta-dump*
/*.json
!/package.json
!/tsconfig.json
/*.csv
.DS_Store
.idea/
.vscode/
```

`src/version.ts`:
```ts
export const VERSION = "19.0.0";
```

`src/main.ts` (placeholder, replaced in Task 6):
```ts
import { VERSION } from "./version";
console.log(VERSION);
```

- [ ] **Step 3: Write the smoke test**

`tests/smoke.test.ts`:
```ts
import { expect, test } from "bun:test";
import { VERSION } from "../src/version";

test("version is 19.0.0", () => {
  expect(VERSION).toBe("19.0.0");
});
```

- [ ] **Step 4: Install and verify**

Run: `bun install && bun run check`
Expected: typecheck clean, `1 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold bun project, remove python source"
```

---

### Task 2: Dotted-key helpers

**Files:**
- Create: `src/lib/dotted.ts`, `tests/dotted.test.ts`

**Interfaces:**
- Produces:
  - `flatToNested(flat: Record<string, unknown>, defaults?: Record<string, unknown>): Record<string, unknown>`
  - `nestedToFlat(nested: Record<string, unknown>, parentKey?: string, sep?: string): Record<string, unknown>`
  - `dottedKeys(obj: Record<string, unknown>, prePath?: string): string[]`
  - `getDotted(obj: unknown, path: string): unknown`
  - `parseAssignments(items: string[]): Record<string, string>` — split each on first `=`; missing `=` throws `ExitError`
  - `deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown>`
  - `isPlainObject(v: unknown): v is Record<string, unknown>`

- [ ] **Step 1: Write failing tests** (ported from Python `tests/test_helpers.py`)

`tests/dotted.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { deepMerge, dottedKeys, flatToNested, getDotted, nestedToFlat, parseAssignments } from "../src/lib/dotted";

describe("dotted", () => {
  test("flatToNested with defaults", () => {
    const defaults = { one: "two", "three.four": "five", "six.seven": "eight" };
    const flat = { one: "two", "three.four": "six" };
    expect(flatToNested(flat, defaults)).toEqual({ one: "two", three: { four: "six" }, six: { seven: "eight" } });
  });
  test("nestedToFlat", () => {
    const input = { a: 1, c: { a: 2, b: { x: 5, y: 10 } }, d: [1, 2, 3] };
    expect(nestedToFlat(input)).toEqual({ a: 1, "c.a": 2, "c.b.x": 5, "c.b.y": 10, d: [1, 2, 3] });
  });
  test("dottedKeys", () => {
    const keys = dottedKeys({ hi: { ho: { silver: "horse", letsgo: "now" }, howareyou: "thanksfine" }, schmee: "meeh" });
    expect(keys.sort()).toEqual(["hi.ho.letsgo", "hi.ho.silver", "hi.howareyou", "schmee"]);
  });
  test("getDotted", () => {
    expect(getDotted({ profile: { login: "a@b" } }, "profile.login")).toBe("a@b");
    expect(getDotted({ profile: {} }, "profile.login")).toBeUndefined();
    expect(getDotted(null, "x")).toBeUndefined();
  });
  test("parseAssignments splits on first =", () => {
    expect(parseAssignments(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(() => parseAssignments(["nope"])).toThrow("nope");
  });
  test("deepMerge", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: 1 }, { a: { c: 3 }, e: 4 })).toEqual({ a: { b: 1, c: 3 }, d: 1, e: 4 });
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test tests/dotted.test.ts`
Expected: fails with module not found.

- [ ] **Step 3: Implement**

`src/okta/errors.ts` (created here because `parseAssignments` needs it; full content, no later changes):
```ts
export class ExitError extends Error {}

export class CommunicationError extends Error {}

export interface OktaErrorBody {
  errorCode?: string;
  errorSummary?: string;
  errorLink?: string;
  errorId?: string;
  errorCauses?: { errorSummary: string }[];
}

export class OktaApiError extends Error {
  constructor(public readonly body: OktaErrorBody, public readonly status: number) {
    super(body.errorSummary ?? `HTTP ${status}`);
  }
  get errorCode(): string {
    return this.body.errorCode ?? "UNKNOWN";
  }
  get errorCauses(): { errorSummary: string }[] {
    return this.body.errorCauses ?? [];
  }
}
```

`src/lib/dotted.ts`:
```ts
import { ExitError } from "../okta/errors";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function setDotted(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function flatToNested(flat: Record<string, unknown>, defaults: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defaults)) setDotted(out, k, v);
  for (const [k, v] of Object.entries(flat)) setDotted(out, k, v);
  return out;
}

export function nestedToFlat(nested: Record<string, unknown>, parentKey = "", sep = "."): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(nested)) {
    const key = parentKey ? `${parentKey}${sep}${k}` : k;
    if (isPlainObject(v)) Object.assign(out, nestedToFlat(v, key, sep));
    else out[key] = v;
  }
  return out;
}

export function dottedKeys(obj: Record<string, unknown>, prePath = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v)) out.push(...dottedKeys(v, `${prePath}${k}.`));
    else out.push(`${prePath}${k}`);
  }
  return out;
}

export function getDotted(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function parseAssignments(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const idx = item.indexOf("=");
    if (idx < 0) throw new ExitError(`Expected FIELD=value, got '${item}'`);
    out[item.slice(0, idx)] = item.slice(idx + 1);
  }
  return out;
}

export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `bun test tests/dotted.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dotted.ts src/okta/errors.ts tests/dotted.test.ts
git commit -m "feat: dotted-key helpers and error types"
```

---

### Task 3: Okta HTTP client and test fixture server

**Files:**
- Create: `src/okta/client.ts`, `tests/fixtures/server.ts`, `tests/client.test.ts`

**Interfaces:**
- Consumes: `ExitError`, `CommunicationError`, `OktaApiError` from `src/okta/errors.ts`.
- Produces:
  - `type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"`
  - `type Query = Record<string, string | number | boolean | undefined>`
  - `interface RequestOptions { query?: Query; body?: unknown; basePath?: string }` (basePath default `/api/v1`; a `path` starting with `http` is used verbatim)
  - `interface ClientOptions { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; verbosity?: number }`
  - `class OktaClient { constructor(url: string, token: string, opts?: ClientOptions); readonly url: string; request(method, path, opts?): Promise<Response>; json<T = any>(method, path, opts?): Promise<T>; get<T = any>(path, query?): Promise<T>; getAll<T = any>(path, opts?: RequestOptions & { max?: number; listKey?: string }): Promise<T[]> }`
  - `stripLinks<T>(v: T): T` — removes `_links` from an object or from each item of an array (shallow, as Python did)
  - `parseNextLink(header: string | null): string | undefined`
  - Fixture: `interface Route { method: Method; path: string | RegExp; status?: number; body?: unknown; headers?: Record<string, string>; handler?: (req: Request, url: URL, bodyJson: unknown) => Response | Promise<Response> }`, `interface Call { method: string; path: string; query: Record<string, string>; body: unknown }`, `startServer(routes: Route[]): { url: string; calls: Call[]; add(route: Route): void; stop(): void }`. Unmatched request → 500 with body `{"errorSummary":"no route for METHOD /path"}`. Route match is first-wins; string paths match `url.pathname` exactly.

Behaviour to implement (mirrors Python `Okta.call_okta_raw`/`call_okta`):
- Headers: `Content-Type: application/json`, `Accept: application/json`, `Authorization: SSWS <token>`.
- Body JSON-encoded for POST/PUT/PATCH when `body !== undefined`.
- On 429: read `X-Rate-Limit-Reset` (epoch seconds), sleep `max(1, reset - now)` seconds, retry; give up after 10 retries with `CommunicationError("rate limited: gave up after 10 retries")`.
- 4xx: parse body as JSON (fallback `{errorSummary: text}`) → throw `OktaApiError(body, status)`.
- 5xx: throw `CommunicationError(`HTTP ${status} ${statusText} for ${method} ${url}`)`.
- Network error (fetch rejects): throw `CommunicationError(err.message)`.
- `json()`: 204 or empty body → `undefined`; else parse and `stripLinks`.
- `getAll()`: first page via `request`; if `listKey`, take `page[listKey]`; loop: stop when no `next` link, when `next` equals previous URL, when a page is empty, or when `max` reached (then slice to `max`).
- Logging: verbosity ≥1 → `> METHOD url`; ≥2 → `< status`; ≥3 → request body and response headers.

- [ ] **Step 1: Write the fixture server**

`tests/fixtures/server.ts`:
```ts
export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export interface Route {
  method: Method;
  path: string | RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  handler?: (req: Request, url: URL, bodyJson: unknown) => Response | Promise<Response>;
}
export interface Call { method: string; path: string; query: Record<string, string>; body: unknown }

export function startServer(routes: Route[]) {
  const table = [...routes];
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let bodyJson: unknown = undefined;
      if (text) { try { bodyJson = JSON.parse(text); } catch { bodyJson = text; } }
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: bodyJson });
      const route = table.find((r) => r.method === req.method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
      if (!route) return Response.json({ errorSummary: `no route for ${req.method} ${url.pathname}` }, { status: 500 });
      if (route.handler) return route.handler(req, url, bodyJson);
      const status = route.status ?? (route.body === undefined ? 204 : 200);
      const headers = { ...(route.headers ?? {}) };
      if (route.body === undefined) return new Response(null, { status, headers });
      return Response.json(route.body, { status, headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    add(route: Route) { table.unshift(route); },
    stop() { server.stop(true); },
  };
}
```

- [ ] **Step 2: Write failing client tests**

`tests/client.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { OktaClient, parseNextLink, stripLinks } from "../src/okta/client";
import { CommunicationError, OktaApiError } from "../src/okta/errors";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());
const noSleep = async () => {};

describe("OktaClient", () => {
  test("sends SSWS auth and json headers, builds /api/v1 urls with query", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/users", body: [{ id: "u1", _links: { self: 1 } }] }]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    let seenAuth = "";
    srv.add({ method: "GET", path: "/api/v1/users", handler: (req) => { seenAuth = req.headers.get("authorization") ?? ""; return Response.json([{ id: "u1", _links: {} }]); } });
    const rv = await c.get("/users", { limit: 2, search: 'status eq "ACTIVE"' });
    expect(seenAuth).toBe("SSWS tok");
    expect(srv.calls[0]!.query).toEqual({ limit: "2", search: 'status eq "ACTIVE"' });
    expect(rv).toEqual([{ id: "u1" }]);
  });

  test("getAll follows Link next, strips _links, stops on empty page", async () => {
    srv = startServer([]);
    srv.add({ method: "GET", path: "/api/v1/groups", handler: (_req, url) => {
      const after = url.searchParams.get("after");
      if (!after) return Response.json([{ id: "g1", _links: {} }], { headers: { Link: `<${srv.url}/api/v1/groups?after=x>; rel="next", <${srv.url}/api/v1/groups>; rel="self"` } });
      if (after === "x") return Response.json([{ id: "g2" }], { headers: { Link: `<${srv.url}/api/v1/groups?after=y>; rel="next"` } });
      return Response.json([]);
    } });
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    expect(await c.getAll("/groups")).toEqual([{ id: "g1" }, { id: "g2" }]);
    expect(srv.calls.length).toBe(3);
  });

  test("getAll honours max and listKey", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/domains", body: { domains: [{ id: 1 }, { id: 2 }, { id: 3 }] } }]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    expect(await c.getAll("/domains", { listKey: "domains", max: 2 })).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("retries on 429 using X-Rate-Limit-Reset", async () => {
    let hits = 0;
    const slept: number[] = [];
    srv = startServer([{ method: "GET", path: "/api/v1/x", handler: () => {
      hits++;
      if (hits === 1) return new Response("", { status: 429, headers: { "X-Rate-Limit-Reset": String(Math.floor(Date.now() / 1000) + 3) } });
      return Response.json({ ok: true });
    } }]);
    const c = new OktaClient(srv.url, "tok", { sleep: async (ms) => { slept.push(ms); } });
    expect(await c.get("/x")).toEqual({ ok: true });
    expect(hits).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
  });

  test("4xx → OktaApiError with body; 5xx → CommunicationError; 204 → undefined", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/bad", status: 404, body: { errorCode: "E0000007", errorSummary: "Not found", errorCauses: [{ errorSummary: "c1" }] } },
      { method: "GET", path: "/api/v1/boom", status: 503, body: {} },
      { method: "PUT", path: "/api/v1/groups/g/users/u" },
    ]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    const err = await c.get("/users/bad").catch((e) => e);
    expect(err).toBeInstanceOf(OktaApiError);
    expect(err.errorCode).toBe("E0000007");
    expect(err.errorCauses).toEqual([{ errorSummary: "c1" }]);
    expect(err.status).toBe(404);
    await expect(c.get("/boom")).rejects.toBeInstanceOf(CommunicationError);
    expect(await c.json("PUT", "/groups/g/users/u")).toBeUndefined();
  });

  test("POST sends JSON body; basePath override; absolute url passthrough", async () => {
    srv = startServer([{ method: "POST", path: "/oauth2/v1/clients", body: { id: "c" } }, { method: "GET", path: "/abs", body: { abs: true } }]);
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    await c.json("POST", "/clients", { basePath: "/oauth2/v1", body: { a: 1 } });
    expect(srv.calls[0]!.body).toEqual({ a: 1 });
    expect(await c.get(`${srv.url}/abs`)).toEqual({ abs: true });
  });

  test("network failure → CommunicationError", async () => {
    const c = new OktaClient("http://127.0.0.1:9", "tok", { sleep: noSleep });
    await expect(c.get("/users")).rejects.toBeInstanceOf(CommunicationError);
  });
});

describe("helpers", () => {
  test("parseNextLink", () => {
    expect(parseNextLink('<https://a/x?after=1>; rel="next", <https://a/x>; rel="self"')).toBe("https://a/x?after=1");
    expect(parseNextLink('<https://a/x>; rel="self"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
  test("stripLinks", () => {
    expect(stripLinks([{ a: 1, _links: {} }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(stripLinks({ a: 1, _links: {} })).toEqual({ a: 1 });
    expect(stripLinks("str")).toBe("str");
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `bun test tests/client.test.ts`
Expected: module not found.

- [ ] **Step 4: Implement the client**

`src/okta/client.ts`:
```ts
import { CommunicationError, OktaApiError, type OktaErrorBody } from "./errors";

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type Query = Record<string, string | number | boolean | undefined>;
export interface RequestOptions { query?: Query; body?: unknown; basePath?: string }
export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  verbosity?: number;
}

const MAX_RETRIES = 10;

export function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const m = part.trim().match(/^<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return undefined;
}

export function stripLinks<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripLinks) as T;
  if (typeof v === "object" && v !== null) {
    const { _links, ...rest } = v as Record<string, unknown>;
    return rest as T;
  }
  return v;
}

export class OktaClient {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly verbosity: number;

  constructor(url: string, token: string, opts: ClientOptions = {}) {
    this.url = url.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", Accept: "application/json", Authorization: `SSWS ${token}` };
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
    this.verbosity = opts.verbosity ?? 0;
  }

  buildUrl(path: string, query?: Query, basePath = "/api/v1"): string {
    let full: URL;
    if (/^https?:\/\//.test(path)) full = new URL(path);
    else {
      const base = basePath.replace(/^\/+|\/+$/g, "");
      const p = path.replace(/^\/+/, "");
      full = new URL(`${this.url}/${[base, p].filter(Boolean).join("/")}`);
    }
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) full.searchParams.set(k, String(v));
    return full.toString();
  }

  async request(method: Method, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, opts.query, opts.basePath);
    const init: RequestInit = { method, headers: this.headers };
    if (opts.body !== undefined && method !== "GET") init.body = JSON.stringify(opts.body);
    if (this.verbosity >= 1) this.log(`> ${method} ${url}`);
    if (this.verbosity >= 3 && init.body) this.log(`> ${init.body}`);
    for (let attempt = 0; ; attempt++) {
      let rsp: Response;
      try {
        rsp = await this.fetchImpl(url, init);
      } catch (e) {
        throw new CommunicationError((e as Error).message);
      }
      if (this.verbosity >= 2) this.log(`< ${rsp.status}`);
      if (this.verbosity >= 3) this.log(`< ${JSON.stringify(Object.fromEntries(rsp.headers))}`);
      if (rsp.status === 429) {
        if (attempt >= MAX_RETRIES) throw new CommunicationError(`rate limited: gave up after ${MAX_RETRIES} retries`);
        const reset = Number(rsp.headers.get("X-Rate-Limit-Reset") ?? 0);
        const delaySec = Math.max(1, Math.floor(reset - Date.now() / 1000));
        await this.sleep(delaySec * 1000);
        continue;
      }
      if (rsp.status >= 500) throw new CommunicationError(`HTTP ${rsp.status} ${rsp.statusText} for ${method} ${url}`);
      if (rsp.status >= 400) {
        const text = await rsp.text();
        let body: OktaErrorBody;
        try { body = JSON.parse(text); } catch { body = { errorSummary: text || rsp.statusText }; }
        throw new OktaApiError(body, rsp.status);
      }
      return rsp;
    }
  }

  async json<T = any>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const rsp = await this.request(method, path, opts);
    const text = await rsp.text();
    if (rsp.status === 204 || text.length === 0) return undefined as T;
    return stripLinks(JSON.parse(text)) as T;
  }

  get<T = any>(path: string, query?: Query): Promise<T> {
    return this.json<T>("GET", path, { query });
  }

  async getAll<T = any>(path: string, opts: RequestOptions & { max?: number; listKey?: string } = {}): Promise<T[]> {
    const out: T[] = [];
    let rsp = await this.request("GET", path, opts);
    let lastUrl: string | undefined;
    for (;;) {
      const raw = await rsp.json();
      const page = (opts.listKey ? (raw as Record<string, unknown>)[opts.listKey] : raw) as T[] | undefined;
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page.map(stripLinks));
      if (opts.max !== undefined && out.length >= opts.max) break;
      const next = parseNextLink(rsp.headers.get("link"));
      if (!next || next === lastUrl) break;
      lastUrl = next;
      rsp = await this.request("GET", next);
    }
    return opts.max !== undefined ? out.slice(0, opts.max) : out;
  }
}
```

- [ ] **Step 5: Run, expect pass**

Run: `bun test tests/client.test.ts`
Expected: 9 pass.

- [ ] **Step 6: Commit**

```bash
git add src/okta/client.ts tests/fixtures/server.ts tests/client.test.ts
git commit -m "feat: okta http client with retry, pagination, fixture server"
```

---

### Task 4: Config file handling

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `ExitError`.
- Produces:
  - `interface Profile { url: string; token: string }`
  - `interface Config { profiles: Record<string, Profile>; default?: string }`
  - `configPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string`
  - `loadConfig(path?: string): Promise<Config>` — missing file → `ExitError("okta-cli was not configured. Please run with 'config new' command.")`; exactly one profile → `default` set to it (Python `_check_config`)
  - `saveConfig(cfg: Config, path?: string): Promise<void>` — mkdir -p, writes compact JSON
  - `resolveProfile(cfg: Config): Profile` — no `default` → `ExitError("Default context not configured. Please execute 'okta-cli config use-context CONTEXT'")`; unknown default → `ExitError("Default context 'X' does not exist. Either add it or run 'use-context' command to configure a different one.")`; url not `https://` → `ExitError("ERROR: configured Okta URL does not start with 'https://'. Please fix this.")`
  - `activeProfile(env?: NodeJS.ProcessEnv): Promise<Profile>` — if `env.OKTA_URL && env.OKTA_TOKEN` return them; else `resolveProfile(await loadConfig(configPath(env)))`

- [ ] **Step 1: Write failing tests**

`tests/config.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeProfile, configPath, loadConfig, resolveProfile, saveConfig } from "../src/config";
import { ExitError } from "../src/okta/errors";

describe("configPath", () => {
  test("matches python appdirs per platform", () => {
    expect(configPath({}, "darwin", "/Users/me")).toBe("/Users/me/Library/Application Support/okta-cli/config.json");
    expect(configPath({}, "linux", "/home/me")).toBe("/home/me/.config/okta-cli/config.json");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg/okta-cli/config.json");
    expect(configPath({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32", "C:\\Users\\me")).toBe(join("C:\\Users\\me\\AppData\\Local", "okta-cli", "okta-cli", "config.json"));
    expect(configPath({ OKTA_CLI_CONFIG: "/x/c.json" }, "darwin", "/Users/me")).toBe("/x/c.json");
  });
});

describe("load/save/resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "okta-cli-"));
  const file = join(dir, "sub", "config.json");

  test("missing file → ExitError", async () => {
    await expect(loadConfig(file)).rejects.toThrow("okta-cli was not configured");
  });
  test("round trip and single-profile default", async () => {
    await saveConfig({ profiles: { a: { url: "https://a.okta.com", token: "t" } } }, file);
    const cfg = await loadConfig(file);
    expect(cfg.default).toBe("a");
    expect(resolveProfile(cfg)).toEqual({ url: "https://a.okta.com", token: "t" });
  });
  test("resolveProfile errors", () => {
    expect(() => resolveProfile({ profiles: { a: { url: "https://a", token: "t" }, b: { url: "https://b", token: "t" } } })).toThrow("Default context not configured");
    expect(() => resolveProfile({ profiles: { a: { url: "https://a", token: "t" } }, default: "zz" })).toThrow("Default context 'zz' does not exist");
    expect(() => resolveProfile({ profiles: { a: { url: "http://a", token: "t" } }, default: "a" })).toThrow(ExitError);
  });
  test("env override", async () => {
    expect(await activeProfile({ OKTA_URL: "https://e.okta.com", OKTA_TOKEN: "et" })).toEqual({ url: "https://e.okta.com", token: "et" });
    expect(await activeProfile({ OKTA_CLI_CONFIG: file })).toEqual({ url: "https://a.okta.com", token: "t" });
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test tests/config.test.ts`

- [ ] **Step 3: Implement**

`src/config.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ExitError } from "./okta/errors";

export interface Profile { url: string; token: string }
export interface Config { profiles: Record<string, Profile>; default?: string }

export function configPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.OKTA_CLI_CONFIG) return env.OKTA_CLI_CONFIG;
  if (platform === "darwin") return join(home, "Library", "Application Support", "okta-cli", "config.json");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "okta-cli", "okta-cli", "config.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "okta-cli", "config.json");
}

export async function loadConfig(path: string = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ExitError("okta-cli was not configured. Please run with 'config new' command.");
  const cfg = (await file.json()) as Config;
  cfg.profiles ??= {};
  const names = Object.keys(cfg.profiles);
  if (names.length === 1) cfg.default = names[0];
  return cfg;
}

export async function saveConfig(cfg: Config, path: string = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(cfg));
}

export function resolveProfile(cfg: Config): Profile {
  if (!cfg.default) throw new ExitError("Default context not configured. Please execute 'okta-cli config use-context CONTEXT'");
  const profile = cfg.profiles[cfg.default];
  if (!profile) throw new ExitError(`Default context '${cfg.default}' does not exist. Either add it or run 'use-context' command to configure a different one.`);
  if (!profile.url.startsWith("https://")) throw new ExitError("ERROR: configured Okta URL does not start with 'https://'. Please fix this.");
  return profile;
}

export async function activeProfile(env: NodeJS.ProcessEnv = process.env): Promise<Profile> {
  if (env.OKTA_URL && env.OKTA_TOKEN) return { url: env.OKTA_URL, token: env.OKTA_TOKEN };
  return resolveProfile(await loadConfig(configPath(env)));
}
```

- [ ] **Step 4: Run, expect pass** — `bun test tests/config.test.ts` → 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config file compatible with python appdirs layout"
```

---

### Task 5: Output formatting (json / yaml / csv / table)

**Files:**
- Create: `src/lib/output.ts`, `tests/output.test.ts`

**Interfaces:**
- Consumes: `dottedKeys`, `nestedToFlat`, `getDotted`, `isPlainObject` from `src/lib/dotted.ts`.
- Produces:
  - `interface OutputOptions { json?: boolean; yaml?: boolean; csv?: boolean; csvDialect?: string; outputFields?: string | null; colwidth?: number }`
  - `toSortedJson(value: unknown): string` — indent 2, keys sorted recursively
  - `toYaml(value: unknown): string`
  - `toCsv(rows: unknown, dialect?: string): string` — rows object or array; columns = sorted union of dotted keys; `excel` → `,` + `\r\n`; `excel-tab` → `\t` + `\r\n`; `unix` → `,` + `\n`; arrays/objects cells JSON-stringified; header row always written
  - `toTable(rows: unknown, fields: string | null | undefined, maxLen: number | undefined, warn: (msg: string) => void): string`
  - `formatResult(rv: unknown, opts: OutputOptions, warn: (msg: string) => void): string | undefined` — implements the "Output rules" in the compatibility section; `undefined` in → `undefined` out; string in → string out

- [ ] **Step 1: Write failing tests**

`tests/output.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { formatResult, toCsv, toSortedJson, toTable } from "../src/lib/output";

const rows = [
  { id: "1", profile: { login: "bob", firstName: "Bob" }, status: "ACTIVE" },
  { id: "22", profile: { login: "alice" }, status: "STAGED" },
];

describe("output", () => {
  test("toSortedJson sorts keys recursively", () => {
    expect(toSortedJson({ b: 1, a: { d: 1, c: [3, { z: 1, y: 2 }] } })).toBe('{\n  "a": {\n    "c": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ],\n    "d": 1\n  },\n  "b": 1\n}');
  });
  test("toCsv flattens dotted keys sorted, excel dialect", () => {
    expect(toCsv(rows)).toBe("id,profile.firstName,profile.login,status\r\n1,Bob,bob,ACTIVE\r\n22,,alice,STAGED\r\n");
    expect(toCsv(rows[0], "unix")).toBe("id,profile.firstName,profile.login,status\n1,Bob,bob,ACTIVE\n");
    expect(toCsv([{ a: [1, 2] }])).toBe('a\r\n"[1,2]"\r\n');
  });
  test("toTable pads columns and warns on missing field", () => {
    const warnings: string[] = [];
    const out = toTable(rows, "id,profile.login,nope", undefined, (m) => warnings.push(m));
    expect(out).toBe("1   bob     \n22  alice   \n");
    expect(warnings).toEqual(["WARNING: field nope either never filled or non-existant."]);
  });
  test("toTable default fields = top-level keys of first row, colwidth truncates", () => {
    expect(toTable([{ a: "abcdefgh", b: "x" }], undefined, 4, () => {})).toBe("abcd...  x  \n");
  });
  test("formatResult dispatch", () => {
    const warn = () => {};
    expect(formatResult("plain", {}, warn)).toBe("plain");
    expect(formatResult(undefined, {}, warn)).toBeUndefined();
    expect(formatResult({ b: 1, a: 2 }, { json: true }, warn)).toBe('{\n  "a": 2,\n  "b": 1\n}');
    expect(formatResult({ a: 2 }, { yaml: true }, warn)).toBe("a: 2\n");
    expect(formatResult(rows, { csv: true, csvDialect: "unix" }, warn)).toStartWith("id,profile.firstName");
    expect(formatResult(rows, { outputFields: "id" }, warn)).toBe("1   \n22  \n");
    expect(formatResult([], { outputFields: "id" }, warn)).toBe("[]");
    expect(formatResult({ a: 1 }, {}, warn)).toBe('{\n  "a": 1\n}');
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/output.test.ts`

- [ ] **Step 3: Implement**

`src/lib/output.ts`:
```ts
import Papa from "papaparse";
import { stringify as yamlStringify } from "yaml";
import { dottedKeys, getDotted, isPlainObject, nestedToFlat } from "./dotted";

export interface OutputOptions {
  json?: boolean;
  yaml?: boolean;
  csv?: boolean;
  csvDialect?: string;
  outputFields?: string | null;
  colwidth?: number;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export function toSortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

export function toYaml(value: unknown): string {
  return yamlStringify(value, { indent: 2 });
}

function asRows(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isPlainObject);
  return isPlainObject(v) ? [v] : [];
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function toCsv(rowsIn: unknown, dialect = "excel"): string {
  const rows = asRows(rowsIn);
  const fields = [...new Set(rows.flatMap((r) => dottedKeys(r)))].sort();
  const data = rows.map((r) => { const flat = nestedToFlat(r); return fields.map((f) => cell(flat[f])); });
  return Papa.unparse({ fields, data }, {
    delimiter: dialect === "excel-tab" ? "\t" : ",",
    newline: dialect === "unix" ? "\n" : "\r\n",
  }) + (dialect === "unix" ? "\n" : "\r\n");
}

export function toTable(rowsIn: unknown, fieldsSpec: string | null | undefined, maxLen: number | undefined, warn: (msg: string) => void): string {
  const rows = asRows(rowsIn);
  if (rows.length === 0) return "";
  const fields = fieldsSpec ? fieldsSpec.split(",") : Object.keys(rows[0]!);
  const widths = fields.map((f) => {
    const present = rows.filter((r) => getDotted(r, f) !== undefined).map((r) => cell(getDotted(r, f)).length);
    if (present.length === 0) { warn(`WARNING: field ${f} either never filled or non-existant.`); return 1; }
    const w = Math.max(...present);
    return maxLen !== undefined ? Math.min(maxLen, w) : w;
  });
  let out = "";
  for (const r of rows) {
    fields.forEach((f, i) => {
      let v = cell(getDotted(r, f));
      if (maxLen !== undefined && v.length > maxLen) v = v.slice(0, maxLen) + "...";
      out += v.padEnd(widths[i]!) + "  ";
    });
    out += "\n";
  }
  return out;
}

export function formatResult(rv: unknown, opts: OutputOptions, warn: (msg: string) => void): string | undefined {
  if (rv === undefined) return undefined;
  if (typeof rv === "string") return rv;
  if (opts.json) return toSortedJson(rv);
  if (opts.yaml) return toYaml(rv);
  if (opts.csv) return toCsv(rv, opts.csvDialect ?? "excel");
  const nonEmpty = Array.isArray(rv) ? rv.length > 0 : isPlainObject(rv) && Object.keys(rv).length > 0;
  if (opts.outputFields && nonEmpty) return toTable(rv, opts.outputFields, opts.colwidth, warn);
  return toSortedJson(rv);
}
```

- [ ] **Step 4: Run, expect pass** — `bun test tests/output.test.ts` → 6 pass. If the `toTable` trailing-newline expectation differs from the fixture, fix the implementation, not the test: the Python original printed one line per row ending in `\n`; `formatResult` output is written with `io.out(text)` (no extra newline) when it ends with `\n`, else `text + "\n"` (Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/output.ts tests/output.test.ts
git commit -m "feat: json/yaml/csv/table output formatting"
```

---

### Task 6: CLI framework — options, context, action wrapper, program, main

**Files:**
- Create: `src/cli/options.ts`, `src/cli/context.ts`, `src/cli/program.ts`, `tests/fixtures/ctx.ts`, `tests/cli.test.ts`
- Modify: `src/main.ts` (replace placeholder)

**Interfaces:**
- Consumes: `OktaClient`, errors, `formatResult`, `activeProfile`, `VERSION`.
- Produces:
  - `collect(v: string, prev: string[]): string[]`, `count(_: string, prev: number): number`, `int(v: string): number`
  - `addVerbose(cmd: Command): Command` — adds `-v, --verbose` (count, default 0)
  - `addOutputOptions(cmd: Command, defaultFields: string | null): Command` — adds `-j, --json`, `-y, --yaml`, `--csv`, `--csv-dialect <dialect>` default `excel`, `--output-fields <fields>` default `defaultFields ?? undefined`, `--colwidth <n>` int
  - `interface IO { out(text: string): void; err(text: string): void; prompt(question: string): string | null; exit(code: number): never }`
  - `interface Ctx { io: IO; getClient(verbosity: number): Promise<OktaClient>; now(): Date; env: NodeJS.ProcessEnv }`
  - `defaultCtx(): Ctx` — `getClient` = `new OktaClient(p.url, p.token, { verbosity, log: (l) => io.err(l + "\n") })` from `activeProfile(env)`; `prompt` = global `prompt`; `exit` = `process.exit`
  - `type Handler = (client: OktaClient, opts: Record<string, any>, ...args: string[]) => Promise<unknown> | unknown`
  - `action(ctx: Ctx, handler: Handler, options?: { client?: boolean }): (...cmdArgs: unknown[]) => Promise<void>` — `client` default true; when false the handler receives `undefined` as client. Formats result with `formatResult(rv, opts, (m) => ctx.io.err(m + "\n"))` and writes `text` (plus `"\n"` unless it already ends with one). Error mapping per Global Constraints; `OktaApiError` lines go to `io.out`, everything else to `io.err`. `CRITICAL_ERROR` banner text:
    ```
    
    *****************************************************************************
    CRITICAL_ERROR: <error name>
    
    Please report at the issues page with details of what you did. Thank you!
    -> https://github.com/gldc/okta-cli/issues
    *****************************************************************************
    
    ```
  - `subgroup(parent: Command, name: string, description: string): Command` — `parent.command(name).description(description)` with `-h, --help` alias configured
  - `buildProgram(ctx: Ctx): Command` — root `okta-cli`, `.version(VERSION, "--version")`, `.helpOption("-h, --help")`, `.exitOverride()`, `configureOutput({ writeOut: ctx.io.out, writeErr: ctx.io.err })`, `showHelpAfterError()`, then calls each command module's `register(program, ctx)` (modules are added in later tasks; Task 6 wires only `version`).
  - `runCli(argv: string[], ctx: Ctx): Promise<number>` — `parseAsync(argv, { from: "user" })`; catches `CommanderError` → returns its `exitCode` (help/version exit 0); returns 0 otherwise. `main.ts` calls `process.exit(await runCli(process.argv.slice(2), defaultCtx()))`.
  - Test fixture `testCtx(serverUrl: string): { ctx: Ctx; out: string[]; err: string[]; exits: number[]; answers: string[] }` — `getClient` returns `new OktaClient(serverUrl, "tok", { sleep: async () => {}, verbosity, log: (l) => err.push(l) })`; `exit(code)` pushes to `exits` and throws a sentinel `class ExitSentinel extends Error` so control flow stops; `prompt` shifts from `answers`; `now()` returns `new Date("2026-01-02T03:04:05Z")`.
  - `runTest(argv: string[], ctx: Ctx): Promise<number>` in `tests/fixtures/ctx.ts` — calls `runCli`, swallowing `ExitSentinel` and returning the last pushed exit code.

- [ ] **Step 1: Write failing test**

`tests/cli.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { action, addOutputOptions, addVerbose } from "../src/cli/options";
import { buildProgram, runCli } from "../src/cli/program";
import { ExitError, OktaApiError } from "../src/okta/errors";
import { startServer } from "./fixtures/server";
import { runTest, testCtx } from "./fixtures/ctx";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

function programWith(ctx: ReturnType<typeof testCtx>["ctx"], handler: (...a: any[]) => unknown, fields: string | null = "id,name") {
  const p = buildProgram(ctx);
  const cmd = p.command("probe").argument("[arg]");
  addOutputOptions(addVerbose(cmd), fields).action(action(ctx, handler));
  return p;
}

describe("cli framework", () => {
  test("version", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runCli(["version"], t.ctx)).toBe(0);
    expect(t.out.join("")).toBe("19.0.0\n");
    expect(await runCli(["--version"], t.ctx)).toBe(0);
  });

  test("table output by default, json with -j, string passthrough", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    const p = programWith(t.ctx, async () => [{ id: "1", name: "a" }]);
    await p.parseAsync(["probe"], { from: "user" });
    expect(t.out.join("")).toBe("1  a  \n");
    t.out.length = 0;
    await p.parseAsync(["probe", "-j"], { from: "user" });
    expect(t.out.join("")).toBe('[\n  {\n    "id": "1",\n    "name": "a"\n  }\n]\n');
    const p2 = programWith(t.ctx, async () => "done");
    t.out.length = 0;
    await p2.parseAsync(["probe"], { from: "user" });
    expect(t.out.join("")).toBe("done\n");
  });

  test("handler receives client, opts, args", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/ping", body: { pong: true } }]);
    const t = testCtx(srv.url);
    const p = programWith(t.ctx, async (client, opts, arg) => ({ ...(await client.get("/ping")), arg, v: opts.verbose }), null);
    await p.parseAsync(["probe", "hello", "-vv"], { from: "user" });
    expect(JSON.parse(t.out.join(""))).toEqual({ pong: true, arg: "hello", v: 2 });
    expect(t.err.some((l) => l.startsWith("> GET"))).toBe(true);
  });

  test("error mapping and exit codes", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    await programWith(t.ctx, async () => { throw new ExitError("nope"); }).parseAsync(["probe"], { from: "user" }).catch(() => {});
    expect(t.err.join("")).toBe("ERROR: nope\n");
    expect(t.exits).toEqual([255]);
    const t2 = testCtx(srv.url);
    await programWith(t2.ctx, async () => { throw new OktaApiError({ errorCode: "E1", errorSummary: "bad", errorCauses: [{ errorSummary: "c" }] }, 400); }).parseAsync(["probe"], { from: "user" }).catch(() => {});
    expect(t2.out.join("")).toBe("OKTA_API_ERROR: E1: bad\nerrorSummary: c\n");
    expect(t2.exits).toEqual([253]);
    const t3 = testCtx(srv.url);
    await programWith(t3.ctx, async () => { throw new TypeError("boom"); }).parseAsync(["probe"], { from: "user" }).catch(() => {});
    expect(t3.err.join("")).toContain("CRITICAL_ERROR: TypeError");
    expect(t3.exits).toEqual([254]);
  });

  test("runTest returns exit code and unknown command exits non-zero", async () => {
    const t = testCtx("http://127.0.0.1:1");
    expect(await runTest(["nonexistent"], t.ctx)).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/cli.test.ts`

- [ ] **Step 3: Implement**

`src/cli/options.ts`:
```ts
import { Command } from "commander";
import { formatResult } from "../lib/output";
import type { OktaClient } from "../okta/client";
import { CommunicationError, ExitError, OktaApiError } from "../okta/errors";
import type { Ctx } from "./context";

export const collect = (v: string, prev: string[]): string[] => [...prev, v];
export const count = (_: string, prev: number): number => prev + 1;
export const int = (v: string): number => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ExitError(`Expected an integer, got '${v}'`);
  return n;
};

export function addVerbose(cmd: Command): Command {
  return cmd.option("-v, --verbose", "Increase verbosity (-vvvvv for full DEBUG logging)", count, 0);
}

export function addOutputOptions(cmd: Command, defaultFields: string | null): Command {
  cmd.option("-j, --json", "Print raw JSON output")
    .option("-y, --yaml", "Print raw YAML output")
    .option("--csv", "Print output as CSV format. Will ignore --output-fields parameter if set")
    .option("--csv-dialect <dialect>", "Use this CSV dialect with CSV output (excel, excel-tab, unix)", "excel")
    .option("--colwidth <n>", "Limit column width; default: unlimited", int);
  if (defaultFields) cmd.option("--output-fields <fields>", "Override default fields in table format", defaultFields);
  else cmd.option("--output-fields <fields>", "Fields to print in table format (default: JSON output)");
  return cmd;
}

export function subgroup(parent: Command, name: string, description: string): Command {
  return parent.command(name).description(description).helpOption("-h, --help");
}

export type Handler = (client: OktaClient, opts: Record<string, any>, ...args: string[]) => Promise<unknown> | unknown;

export function action(ctx: Ctx, handler: Handler, options: { client?: boolean } = {}) {
  return async (...cmdArgs: unknown[]): Promise<void> => {
    cmdArgs.pop(); // Command instance
    const opts = (cmdArgs.pop() ?? {}) as Record<string, any>;
    const args = cmdArgs as string[];
    try {
      const client = options.client === false ? (undefined as unknown as OktaClient) : await ctx.getClient(opts.verbose ?? 0);
      const rv = await handler(client, opts, ...args);
      const text = formatResult(rv, opts, (m) => ctx.io.err(m + "\n"));
      if (text !== undefined) ctx.io.out(text.endsWith("\n") ? text : text + "\n");
    } catch (e) {
      if (e instanceof ExitError) { ctx.io.err(`ERROR: ${e.message}\n`); ctx.io.exit(255); }
      if (e instanceof CommunicationError) { ctx.io.err(`COMMUNICATION_ERROR: ${e.message}\n`); ctx.io.exit(255); }
      if (e instanceof OktaApiError) {
        ctx.io.out(`OKTA_API_ERROR: ${e.errorCode}: ${e.message}\n`);
        for (const cause of e.errorCauses) for (const [k, v] of Object.entries(cause)) ctx.io.out(`${k}: ${v}\n`);
        ctx.io.exit(253);
      }
      const err = e as Error;
      ctx.io.err(`${err.stack ?? String(err)}\n`);
      ctx.io.err(`\n*****************************************************************************\nCRITICAL_ERROR: ${err.name ?? typeof e}\n\nPlease report at the issues page with details of what you did. Thank you!\n-> https://github.com/gldc/okta-cli/issues\n*****************************************************************************\n\n`);
      ctx.io.exit(254);
    }
  };
}
```

`src/cli/context.ts`:
```ts
import { activeProfile } from "../config";
import { OktaClient } from "../okta/client";

export interface IO {
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): string | null;
  exit(code: number): never;
}

export interface Ctx {
  io: IO;
  getClient(verbosity: number): Promise<OktaClient>;
  now(): Date;
  env: NodeJS.ProcessEnv;
}

export function defaultCtx(): Ctx {
  const io: IO = {
    out: (t) => { process.stdout.write(t); },
    err: (t) => { process.stderr.write(t); },
    prompt: (q) => prompt(q),
    exit: (code) => process.exit(code),
  };
  return {
    io,
    env: process.env,
    now: () => new Date(),
    async getClient(verbosity) {
      const p = await activeProfile(process.env);
      return new OktaClient(p.url, p.token, { verbosity, log: (l) => io.err(l + "\n") });
    },
  };
}
```

`src/cli/program.ts` (command module imports are added one per task; Task 6 ships only `version`):
```ts
import { Command, CommanderError } from "commander";
import { VERSION } from "../version";
import type { Ctx } from "./context";

export function buildProgram(ctx: Ctx): Command {
  const program = new Command("okta-cli")
    .description('Okta CLI helper.\n\nSee subcommands for help: "okta-cli users --help" etc.\n\nIf in doubt start with: "okta-cli config new --help"')
    .version(VERSION, "--version")
    .helpOption("-h, --help")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.io.out(s), writeErr: (s) => ctx.io.err(s) });
  program.command("version").description("Print version number and exit").action(() => ctx.io.out(VERSION + "\n"));
  // registerConfig(program, ctx);  ← Task 8
  // registerUsers(program, ctx);   ← Task 10
  // registerPw(program, ctx);      ← Task 12
  // registerGroups(program, ctx);  ← Task 9
  // registerApps(program, ctx);    ← Task 13
  // registerFeatures(program, ctx); registerEventhooks(program, ctx); ← Task 14
  // registerMisc(program, ctx);    ← Task 15
  return program;
}

export async function runCli(argv: string[], ctx: Ctx): Promise<number> {
  try {
    await buildProgram(ctx).parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
}
```

`src/main.ts`:
```ts
import { defaultCtx } from "./cli/context";
import { runCli } from "./cli/program";

process.exit(await runCli(process.argv.slice(2), defaultCtx()));
```

`tests/fixtures/ctx.ts`:
```ts
import type { Ctx } from "../../src/cli/context";
import { runCli } from "../../src/cli/program";
import { OktaClient } from "../../src/okta/client";

export class ExitSentinel extends Error { constructor(public code: number) { super(`exit ${code}`); } }

export function testCtx(serverUrl: string) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const answers: string[] = [];
  const ctx: Ctx = {
    env: {},
    now: () => new Date("2026-01-02T03:04:05Z"),
    io: {
      out: (t) => { out.push(t); },
      err: (t) => { err.push(t); },
      prompt: () => answers.shift() ?? null,
      exit: (code) => { exits.push(code); throw new ExitSentinel(code); },
    },
    async getClient(verbosity) {
      return new OktaClient(serverUrl, "tok", { sleep: async () => {}, verbosity, log: (l) => err.push(l + "\n") });
    },
  };
  return { ctx, out, err, exits, answers };
}

export async function runTest(argv: string[], ctx: Ctx): Promise<number> {
  try {
    return await runCli(argv, ctx);
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  }
}
```

- [ ] **Step 4: Run, expect pass** — `bun test tests/cli.test.ts` → 5 pass. Then `bun run check` → all green. Then `bun src/main.ts version` → `19.0.0`; `bun src/main.ts -h` shows help.

- [ ] **Step 5: Commit**

```bash
git add src/cli src/main.ts tests/fixtures/ctx.ts tests/cli.test.ts
git commit -m "feat: commander program, action wrapper, exit codes"
```

---

### Task 7: Lookup helpers and dict filtering

**Files:**
- Create: `src/lib/lookup.ts`, `src/lib/filter.ts`, `tests/lookup.test.ts`

**Interfaces:**
- Consumes: `OktaClient`, `OktaApiError`, `ExitError`, `getDotted`.
- Produces (`src/lib/lookup.ts`):
  - `type Selector = (item: any) => boolean`
  - `retrieve(client, thing: string, possibleId: string | undefined, opts?: { selector?: Selector; query?: Query }): Promise<any>` — if `possibleId` try `GET /{thing}/{possibleId}` and return the object on success (swallow `OktaApiError` only); else `getAll(/{thing}, {query})` filtered by selector
  - `getOne(client, thing, possibleId, opts?): Promise<any>` — like retrieve; if result is an array: length > 1 → `ExitError("Name for {thing} must be unique. (found N matches).")`, 0 → `ExitError("No matching {thing} found.")`, else first
  - `selectProfileField(field: string, value: string): Selector` — `profile[field]` lowercase includes value lowercase
  - `selectOktaGroup(value: string): Selector` — `type === "OKTA_GROUP"` and profile.name includes
  - `selectField(field: string, value: string): Selector` — `getDotted(item, field)` string lowercase includes
  - `getUser(client, user: string, lookupField = "login")` = `getOne(client, "users", user, { query: { search: `profile.${lookupField} eq "${user}"` } })`
  - `getGroup(client, group: string)` = `getOne(client, "groups", group, { selector: selectOktaGroup(group) })`
  - `getApp(client, app: string)` = `getOne(client, "apps", app, { selector: selectField("label", app) })`
- Produces (`src/lib/filter.ts`): `filterDicts<T>(items: T[], filters: Record<string, string>, partial: boolean): T[]` — each filter key is a dotted path; value compiled as a case-insensitive JS RegExp against the lowercased string value; `partial=false` → whole-string match (`^(?:re)$`), `partial=true` → search; missing key → excluded.

- [ ] **Step 1: Write failing tests**

`tests/lookup.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { filterDicts } from "../src/lib/filter";
import { getApp, getGroup, getOne, getUser, retrieve, selectOktaGroup } from "../src/lib/lookup";
import { OktaClient } from "../src/okta/client";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());
const client = () => new OktaClient(srv.url, "tok", { sleep: async () => {} });

const groups = [
  { id: "00g1", type: "OKTA_GROUP", profile: { name: "Engineering" } },
  { id: "00g2", type: "APP_GROUP", profile: { name: "Engineering-app" } },
  { id: "00g3", type: "OKTA_GROUP", profile: { name: "Sales" } },
];

describe("lookup", () => {
  test("retrieve by id first, falls back to filtered list", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/groups/00g3", body: groups[2] },
      { method: "GET", path: /^\/api\/v1\/groups\/.+/, status: 404, body: { errorSummary: "nf" } },
      { method: "GET", path: "/api/v1/groups", body: groups },
    ]);
    expect(await retrieve(client(), "groups", "00g3")).toEqual(groups[2]);
    expect(await retrieve(client(), "groups", "eng", { selector: selectOktaGroup("eng") })).toEqual([groups[0]]);
  });
  test("getOne uniqueness errors", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/groups\/.+/, status: 404, body: {} },
      { method: "GET", path: "/api/v1/groups", body: groups },
    ]);
    expect(await getGroup(client(), "sales")).toEqual(groups[2]);
    await expect(getOne(client(), "groups", "e", { selector: (g) => g.profile.name.includes("E") })).rejects.toThrow("Name for groups must be unique. (found 2 matches).");
    await expect(getGroup(client(), "zzz")).rejects.toThrow("No matching groups found.");
  });
  test("getUser searches by lookup field; getApp matches label", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/users\/.+/, status: 404, body: {} },
      { method: "GET", path: "/api/v1/users", body: [{ id: "u1", profile: { login: "a@x" } }] },
      { method: "GET", path: /^\/api\/v1\/apps\/.+/, status: 404, body: {} },
      { method: "GET", path: "/api/v1/apps", body: [{ id: "a1", label: "Slack" }, { id: "a2", label: "Zoom" }] },
    ]);
    expect(await getUser(client(), "a@x", "email")).toEqual({ id: "u1", profile: { login: "a@x" } });
    expect(srv.calls.find((c) => c.path === "/api/v1/users")!.query.search).toBe('profile.email eq "a@x"');
    expect(await getApp(client(), "sla")).toEqual({ id: "a1", label: "Slack" });
  });
});

describe("filterDicts", () => {
  const items = [{ profile: { firstName: "Hans", city: "Berlin" } }, { profile: { firstName: "Hansi" } }];
  test("full match vs partial, case-insensitive, missing key excluded", () => {
    expect(filterDicts(items, { "profile.firstName": "hans" }, false)).toEqual([items[0]]);
    expect(filterDicts(items, { "profile.firstName": "hans" }, true)).toEqual(items);
    expect(filterDicts(items, { "profile.city": "ber.*" }, false)).toEqual([items[0]]);
    expect(filterDicts(items, {}, false)).toEqual(items);
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/lookup.test.ts`

- [ ] **Step 3: Implement**

`src/lib/filter.ts`:
```ts
import { getDotted } from "./dotted";

export function filterDicts<T>(items: T[], filters: Record<string, string>, partial: boolean): T[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return items;
  const compiled = entries.map(([k, v]) => [k, new RegExp(partial ? v.toLowerCase() : `^(?:${v.toLowerCase()})$`)] as const);
  return items.filter((item) => compiled.every(([k, re]) => {
    const v = getDotted(item, k);
    return v !== undefined && v !== null && re.test(String(v).toLowerCase());
  }));
}
```

`src/lib/lookup.ts`:
```ts
import type { OktaClient, Query } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";
import { getDotted } from "./dotted";

export type Selector = (item: any) => boolean;

export const selectProfileField = (field: string, value: string): Selector => {
  const v = value.toLowerCase();
  return (x) => String(x?.profile?.[field] ?? "").toLowerCase().includes(v);
};
export const selectOktaGroup = (value: string): Selector => {
  const byName = selectProfileField("name", value);
  return (x) => x?.type === "OKTA_GROUP" && byName(x);
};
export const selectField = (field: string, value: string): Selector => {
  const v = value.toLowerCase();
  return (x) => String(getDotted(x, field) ?? "").toLowerCase().includes(v);
};

export async function retrieve(client: OktaClient, thing: string, possibleId: string | undefined, opts: { selector?: Selector; query?: Query } = {}): Promise<any> {
  if (possibleId !== undefined && possibleId !== null && possibleId !== "") {
    try {
      return await client.get(`/${thing}/${encodeURIComponent(possibleId)}`);
    } catch (e) {
      if (!(e instanceof OktaApiError)) throw e;
    }
  }
  const things = await client.getAll(`/${thing}`, { query: opts.query });
  return opts.selector ? things.filter(opts.selector) : things;
}

export async function getOne(client: OktaClient, thing: string, possibleId: string | undefined, opts: { selector?: Selector; query?: Query } = {}): Promise<any> {
  const things = await retrieve(client, thing, possibleId, opts);
  if (!Array.isArray(things)) return things;
  if (things.length > 1) throw new ExitError(`Name for ${thing} must be unique. (found ${things.length} matches).`);
  if (things.length === 0) throw new ExitError(`No matching ${thing} found.`);
  return things[0];
}

export const getUser = (client: OktaClient, user: string, lookupField = "login") =>
  getOne(client, "users", user, { query: { search: `profile.${lookupField} eq "${user}"` } });
export const getGroup = (client: OktaClient, group: string) => getOne(client, "groups", group, { selector: selectOktaGroup(group) });
export const getApp = (client: OktaClient, app: string) => getOne(client, "apps", app, { selector: selectField("label", app) });
```

- [ ] **Step 4: Run, expect pass** — `bun test tests/lookup.test.ts` → 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lookup.ts src/lib/filter.ts tests/lookup.test.ts
git commit -m "feat: id-or-name lookup helpers and regex dict filter"
```

---

### Task 8: `config` command group

**Files:**
- Create: `src/commands/config.ts`, `tests/commands-config.test.ts`
- Modify: `src/cli/program.ts` (uncomment/add `registerConfig(program, ctx)`)

**Interfaces:**
- Consumes: `loadConfig/saveConfig/configPath` (path from `configPath(ctx.env)`), `subgroup`, `action`, `ExitError`.
- Produces: `registerConfig(program: Command, ctx: Ctx): void`. Every module in `src/commands/*.ts` exports `register<Name>(program: Command, ctx: Ctx): void` with this exact shape.

Behaviour (all `client: false`):
- `new -n/--name <name> -u/--url <url> -t/--token <token>`: missing values are asked via `ctx.io.prompt("Name: ")`, `"Url: "`, `"Token: "`; url lowercased, must start with `https://` else `ExitError("url must start with 'https://'")`; creates config if missing; returns `Profile '<name>' added.`
- `list`: one line per profile: `${name}  ${url}  ***${token.slice(-4)}${current ? "  (CURRENT)" : ""}`
- `use-context <profile-name>`: unknown → `ExitError("Unknown profile name: '<x>'.")`; returns `Default profile set to '<x>'.`
- `delete <profile-name>`: unknown → same error; lines `Profile '<x>' deleted.`, then `New default profile: <y>` (first remaining) or `No more profiles left.` when the deleted one was default
- `file`: returns the path
- `current-context`: `Current profile set to '<x>'.` or `No profile set.`

- [ ] **Step 1: Write failing tests**

`tests/commands-config.test.ts`:
```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTest, testCtx } from "./fixtures/ctx";

describe("config commands", () => {
  let file: string;
  let t: ReturnType<typeof testCtx>;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "okta-cli-")), "config.json");
    t = testCtx("http://127.0.0.1:1");
    t.ctx.env = { OKTA_CLI_CONFIG: file };
  });

  test("new/list/use-context/current-context/delete/file", async () => {
    expect(await runTest(["config", "new", "-n", "p1", "-u", "https://a.okta.com", "-t", "abcd1234"], t.ctx)).toBe(0);
    expect(t.out.at(-1)).toBe("Profile 'p1' added.\n");
    t.answers.push("p2", "https://b.okta.com", "zzzz9999");
    await runTest(["config", "new"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p2' added.\n");
    t.out.length = 0;
    await runTest(["config", "list"], t.ctx);
    expect(t.out.join("")).toBe("p1  https://a.okta.com  ***1234\np2  https://b.okta.com  ***9999\n");
    await runTest(["config", "use-context", "p2"], t.ctx);
    expect(t.out.at(-1)).toBe("Default profile set to 'p2'.\n");
    await runTest(["config", "current-context"], t.ctx);
    expect(t.out.at(-1)).toBe("Current profile set to 'p2'.\n");
    t.out.length = 0;
    await runTest(["config", "list"], t.ctx);
    expect(t.out.join("")).toContain("***9999  (CURRENT)\n");
    await runTest(["config", "delete", "p2"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p2' deleted.\nNew default profile: p1\n");
    await runTest(["config", "delete", "p1"], t.ctx);
    expect(t.out.at(-1)).toBe("Profile 'p1' deleted.\nNo more profiles left.\n");
    await runTest(["config", "file"], t.ctx);
    expect(t.out.at(-1)).toBe(file + "\n");
  });

  test("errors", async () => {
    expect(await runTest(["config", "new", "-n", "x", "-u", "http://nope", "-t", "t"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("url must start with 'https://'");
    expect(await runTest(["config", "use-context", "nope"], t.ctx)).toBe(255);
    expect(t.err.join("")).toContain("okta-cli was not configured");
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/commands-config.test.ts`

- [ ] **Step 3: Implement**

`src/commands/config.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, subgroup } from "../cli/options";
import { type Config, configPath, loadConfig, saveConfig } from "../config";
import { ExitError } from "../okta/errors";

export function registerConfig(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "config", "Manage okta-cli configuration");
  const path = () => configPath(ctx.env);
  const ask = (value: string | undefined, label: string): string => {
    if (value) return value;
    const v = ctx.io.prompt(`${label}: `);
    if (!v) throw new ExitError(`${label} is required`);
    return v;
  };

  g.command("new").description("Create a new configuration profile")
    .option("-n, --name <name>", "Name of the configuration to add.")
    .option("-u, --url <url>", "The base URL of Okta, e.g. 'https://my.okta.com'.")
    .option("-t, --token <token>", "The API token to use")
    .action(action(ctx, async (_c, opts) => {
      const name = ask(opts.name, "Name");
      const url = ask(opts.url, "Url").toLowerCase();
      const token = ask(opts.token, "Token");
      if (!url.startsWith("https://")) throw new ExitError("url must start with 'https://'");
      let cfg: Config;
      try { cfg = await loadConfig(path()); } catch { cfg = { profiles: {} }; }
      cfg.profiles[name] = { url, token };
      await saveConfig(cfg, path());
      return `Profile '${name}' added.`;
    }, { client: false }));

  g.command("list").description("List all configuration profiles")
    .action(action(ctx, async () => {
      const cfg = await loadConfig(path());
      return Object.entries(cfg.profiles)
        .map(([name, p]) => `${name}  ${p.url}  ***${p.token.slice(-4)}${name === cfg.default ? "  (CURRENT)" : ""}`)
        .join("\n");
    }, { client: false }));

  g.command("use-context").description("Set a config profile as default profile").argument("<profile-name>")
    .action(action(ctx, async (_c, _o, name) => {
      const cfg = await loadConfig(path());
      if (!cfg.profiles[name]) throw new ExitError(`Unknown profile name: '${name}'.`);
      cfg.default = name;
      await saveConfig(cfg, path());
      return `Default profile set to '${name}'.`;
    }, { client: false }));

  g.command("delete").description("Delete a config profile").argument("<profile-name>")
    .action(action(ctx, async (_c, _o, name) => {
      const cfg = await loadConfig(path());
      if (!cfg.profiles[name]) throw new ExitError(`Unknown profile name: '${name}'.`);
      delete cfg.profiles[name];
      const lines = [`Profile '${name}' deleted.`];
      if (cfg.default === name) {
        const remaining = Object.keys(cfg.profiles);
        if (remaining.length) { cfg.default = remaining[0]; lines.push(`New default profile: ${remaining[0]}`); }
        else { delete cfg.default; lines.push("No more profiles left."); }
      }
      await saveConfig(cfg, path());
      return lines.join("\n");
    }, { client: false }));

  g.command("file").description("Print the locations of the configuration file")
    .action(action(ctx, () => path(), { client: false }));

  g.command("current-context").description("Print the current default profile")
    .action(action(ctx, async () => {
      const cfg = await loadConfig(path());
      return cfg.default ? `Current profile set to '${cfg.default}'.` : "No profile set.";
    }, { client: false }));
}
```

In `src/cli/program.ts` add `import { registerConfig } from "../commands/config";` and call `registerConfig(program, ctx);` after the `version` command.

- [ ] **Step 4: Run, expect pass** — `bun test tests/commands-config.test.ts` → 2 pass; `bun run check` green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/config.ts src/cli/program.ts tests/commands-config.test.ts
git commit -m "feat: config command group"
```

---

### Task 9: `groups` command group (18.1.2 surface)

**Files:**
- Create: `src/commands/groups.ts`, `tests/commands-groups.test.ts`, `tests/fixtures/data.ts`
- Modify: `src/cli/program.ts` (add `registerGroups`)

**Interfaces:**
- Consumes: `getGroup`, `getUser`, `retrieve`, `selectProfileField`, `addOutputOptions`, `addVerbose`, `action`, `subgroup`, `collect`.
- Produces: `registerGroups(program, ctx)`; exported handlers used by tests and by Task 23 (`groups rules`): `groupsList`, `groupsAddUser`, `groupsRemoveUser`, `groupsClear`, each `(client, opts, ...args)`.
- `tests/fixtures/data.ts` exports `users`, `groups`, `apps` arrays and `standardRoutes()` returning the `Route[]` below, reused by later command tests.

Standard fixture data:
```ts
import type { Route } from "./server";

export const users = [
  { id: "00u00000000000000001", status: "ACTIVE", profile: { login: "bob@x.com", email: "bob@x.com", firstName: "Bob", lastName: "B" } },
  { id: "00u00000000000000002", status: "ACTIVE", profile: { login: "alice@x.com", email: "alice@x.com", firstName: "Alice", lastName: "A" } },
];
export const groups = [
  { id: "00g1", type: "OKTA_GROUP", profile: { name: "Engineering", description: "eng" } },
  { id: "00g2", type: "APP_GROUP", profile: { name: "Engineering-app", description: null } },
  { id: "00g3", type: "OKTA_GROUP", profile: { name: "Sales", description: "s" } },
];
export const apps = [
  { id: "0oa1", name: "bookmark", label: "Zoom", status: "ACTIVE" },
  { id: "0oa2", name: "slack", label: "Slack", status: "ACTIVE" },
];

/** GET by id for known ids, 404 for unknown ids, list endpoints filtered by ?search= login when present. */
export function standardRoutes(): Route[] {
  const byId = (items: { id: string }[]) => (_req: Request, url: URL) => {
    const id = url.pathname.split("/").pop()!;
    const hit = items.find((i) => i.id === id);
    return hit ? Response.json(hit) : Response.json({ errorCode: "E0000007", errorSummary: `Not found: ${id}`, errorCauses: [] }, { status: 404 });
  };
  return [
    { method: "GET", path: /^\/api\/v1\/users\/[^/]+$/, handler: byId(users) },
    { method: "GET", path: /^\/api\/v1\/groups\/[^/]+$/, handler: byId(groups) },
    { method: "GET", path: /^\/api\/v1\/apps\/[^/]+$/, handler: byId(apps) },
    { method: "GET", path: "/api/v1/users", handler: (_r, url) => {
      const search = url.searchParams.get("search") ?? "";
      const m = search.match(/profile\.(\w+) eq "([^"]+)"/);
      return Response.json(m ? users.filter((u) => (u.profile as any)[m[1]!] === m[2]) : users);
    } },
    { method: "GET", path: "/api/v1/groups", body: groups },
    { method: "GET", path: "/api/v1/apps", body: apps },
  ];
}
```

- [ ] **Step 1: Write failing tests**

`tests/commands-groups.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { groups, standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("groups", () => {
  test("list excludes APP_GROUP unless -a, supports partial name", async () => {
    srv = startServer(standardRoutes());
    const t = testCtx(srv.url);
    await runTest(["groups", "list"], t.ctx);
    expect(t.out.join("")).toBe("00g1  OKTA_GROUP  Engineering  \n00g3  OKTA_GROUP  Sales        \n");
    t.out.length = 0;
    await runTest(["groups", "list", "-a", "eng", "--output-fields", "id"], t.ctx);
    expect(t.out.join("")).toBe("00g1  \n00g2  \n");
  });

  test("adduser resolves group by name and user by login", async () => {
    srv = startServer([{ method: "PUT", path: "/api/v1/groups/00g1/users/00u00000000000000001" }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    expect(await runTest(["groups", "adduser", "-g", "engineering", "-u", "bob@x.com"], t.ctx)).toBe(0);
    expect(t.out.join("")).toBe("User 00u00000000000000001 (bob@x.com) added to group 00g1 (Engineering)\n");
    expect(srv.calls.some((c) => c.method === "PUT" && c.path === "/api/v1/groups/00g1/users/00u00000000000000001")).toBe(true);
  });

  test("removeuser with -f email; users lists sorted by login; clear deletes each member", async () => {
    srv = startServer([
      { method: "DELETE", path: /^\/api\/v1\/groups\/00g1\/users\/.+/ },
      { method: "GET", path: "/api/v1/groups/00g1/users", body: [users[0], users[1]] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["groups", "removeuser", "-g", "00g1", "-u", "alice@x.com", "-f", "email"], t.ctx);
    expect(t.out.at(-1)).toBe("User 00u00000000000000002 (alice@x.com) removed from group 00g1 (Engineering)\n");
    t.out.length = 0;
    await runTest(["groups", "users", "00g1", "--output-fields", "profile.login"], t.ctx);
    expect(t.out.join("")).toBe("alice@x.com  \nbob@x.com    \n");
    await runTest(["groups", "clear", "Engineering"], t.ctx);
    expect(t.out.at(-1)).toBe("All users removed from group 00g1 (Engineering)\n");
    expect(srv.calls.filter((c) => c.method === "DELETE").map((c) => c.path).sort()).toEqual([
      "/api/v1/groups/00g1/users/00u00000000000000001", "/api/v1/groups/00g1/users/00u00000000000000001", "/api/v1/groups/00g1/users/00u00000000000000002",
    ].sort());
  });

  test("add posts profile; get; delete; apps sorted by label", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/groups", body: { id: "00g9", type: "OKTA_GROUP", profile: { name: "New", description: "d" } } },
      { method: "DELETE", path: "/api/v1/groups/00g3" },
      { method: "GET", path: "/api/v1/groups/00g1/apps", body: [{ id: "0oa2", name: "slack", label: "Slack" }, { id: "0oa1", name: "bookmark", label: "Aaa" }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["groups", "add", "-n", "New", "-d", "d"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ profile: { name: "New", description: "d" } });
    expect(t.out.at(-1)).toBe("00g9  OKTA_GROUP  New  \n");
    await runTest(["groups", "get", "sales", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(groups[2]);
    await runTest(["groups", "delete", "Sales"], t.ctx);
    expect(t.out.at(-1)).toBe("group 00g3 deleted\n");
    await runTest(["groups", "apps", "00g1", "--output-fields", "label"], t.ctx);
    expect(t.out.at(-1)).toBe("Aaa    \nSlack  \n");
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/commands-groups.test.ts`

- [ ] **Step 3: Implement**

`src/commands/groups.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, subgroup, type Handler } from "../cli/options";
import { getGroup, getUser, retrieve, selectProfileField } from "../lib/lookup";
import type { OktaClient } from "../okta/client";

const GROUP_FIELDS = "id,type,profile.name";
const USER_FIELDS = "id,profile.login,profile.firstName,profile.lastName,profile.email";

export const groupsList: Handler = async (client, opts, partialName?: string) => {
  const query: Record<string, string> = {};
  if (opts.filter) query.filter = opts.filter;
  if (opts.query) query.q = opts.query;
  const selector = partialName ? selectProfileField("name", partialName) : undefined;
  let rv: any[] = await retrieve(client, "groups", undefined, { selector, query });
  if (!opts.all) rv = rv.filter((g) => g.type === "OKTA_GROUP");
  return rv;
};

export const groupsAddUser: Handler = async (client, opts) => {
  const group = await getGroup(client, opts.group);
  const user = await getUser(client, opts.user, opts.userLookupField);
  await client.json("PUT", `/groups/${group.id}/users/${user.id}`);
  return `User ${user.id} (${user.profile.login}) added to group ${group.id} (${group.profile.name})`;
};

export const groupsRemoveUser: Handler = async (client, opts) => {
  const group = await getGroup(client, opts.group);
  const user = await getUser(client, opts.user, opts.userLookupField);
  await client.json("DELETE", `/groups/${group.id}/users/${user.id}`);
  return `User ${user.id} (${user.profile.login}) removed from group ${group.id} (${group.profile.name})`;
};

export const groupsClear = (ctx: Ctx): Handler => async (client: OktaClient, _opts, nameOrId: string) => {
  const group = await getGroup(client, nameOrId);
  const members: any[] = await client.getAll(`/groups/${group.id}/users`);
  members.sort((a, b) => String(a.profile.login).localeCompare(String(b.profile.login)));
  for (const u of members) {
    ctx.io.err(`Removing user ${u.profile.login} ... `);
    await client.json("DELETE", `/groups/${group.id}/users/${u.id}`);
    ctx.io.err("ok\n");
  }
  return `All users removed from group ${group.id} (${group.profile.name})`;
};

const userFlags = (cmd: Command) => cmd
  .requiredOption("-g, --group <GID-OR-UNIQUE>", "The group ID (or unique name part) of the group")
  .requiredOption("-u, --user <EXACT-MATCH>", "The user ID, or an exact match of the --user-lookup-field")
  .option("-f, --user-lookup-field <FIELDNAME>", "Matching is done against this profile field; default: 'login'.", "login");

export function registerGroups(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "groups", "Group operations");

  addOutputOptions(addVerbose(g.command("list").description("List all defined groups").argument("[partial_name]")
    .option("-f, --filter <expression>", "Okta filter expression")
    .option("-q, --query <query>", "Okta 'q' query (name starts with)")
    .option("-a, --all", "Include APP_GROUPs in list")), GROUP_FIELDS)
    .action(action(ctx, groupsList));

  addOutputOptions(addVerbose(g.command("add").description("Create a new group")
    .requiredOption("-n, --name <name>").option("-d, --description <description>")), GROUP_FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/groups", { body: { profile: { name: opts.name, description: opts.description ?? null } } })));

  addOutputOptions(addVerbose(g.command("apps").description("List all apps associated with a group").argument("<name-or-id>")), "id,name,label")
    .action(action(ctx, async (client, _o, nameOrId) => {
      const group = await getGroup(client, nameOrId);
      const rv: any[] = await client.getAll(`/groups/${group.id}/apps`);
      return rv.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }));

  addOutputOptions(addVerbose(g.command("delete").description("Delete a group (name substring match must be unique)").argument("<name-or-id>")), GROUP_FIELDS)
    .action(action(ctx, async (client, _o, nameOrId) => {
      const group = await getGroup(client, nameOrId);
      await client.json("DELETE", `/groups/${group.id}`);
      return `group ${group.id} deleted`;
    }));

  addOutputOptions(addVerbose(g.command("get").description("Print only one group").argument("<name-or-id>")), GROUP_FIELDS)
    .action(action(ctx, (client, _o, nameOrId) => getGroup(client, nameOrId)));

  addVerbose(userFlags(g.command("adduser").description("Adds a user to a group. Use -f to select users by any profile field."))).action(action(ctx, groupsAddUser));
  addVerbose(userFlags(g.command("removeuser").description("Removes a user from a group."))).action(action(ctx, groupsRemoveUser));

  addOutputOptions(addVerbose(g.command("users").description("List all users in a group").argument("<id-or-unique>")), USER_FIELDS)
    .action(action(ctx, async (client, _o, idOrUnique) => {
      const group = await getGroup(client, idOrUnique);
      const rv: any[] = await client.getAll(`/groups/${group.id}/users`);
      return rv.sort((a, b) => String(a.profile.login).toLowerCase().localeCompare(String(b.profile.login).toLowerCase()));
    }));

  addVerbose(g.command("clear").description("Remove all users from a group. This can take a while if the group is big.").argument("<name-or-id>")
    .option("-i, --id", "Use Okta group ID instead of the group name"))
    .action(action(ctx, groupsClear(ctx)));
}
```

Add `registerGroups(program, ctx)` to `src/cli/program.ts`.

- [ ] **Step 4: Run, expect pass** — `bun test tests/commands-groups.test.ts` → 4 pass; `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/groups.ts src/cli/program.ts tests/fixtures/data.ts tests/commands-groups.test.ts
git commit -m "feat: groups command group"
```

---

### Task 10: `users` command group (18.1.2 surface, without bulk)

**Files:**
- Create: `src/commands/users.ts`, `tests/commands-users.test.ts`
- Modify: `src/cli/program.ts` (add `registerUsers`)

**Interfaces:**
- Consumes: `getUser`, `retrieve`, `filterDicts`, `parseAssignments`, `flatToNested`, `collect`.
- Produces: `registerUsers(program, ctx)`; exported `addUser(client, params: AddUserParams): Promise<any>` where `interface AddUserParams { fields: Record<string, string>; overrideFields?: Record<string, string>; profileFields?: Record<string, string>; groupIds?: string[]; activate: boolean; provider: boolean; nextlogin: boolean }` (port of `internal_add_user`: merge fields ← overrideFields, drop keys without `.`, add `profile.`-prefixed profileFields, set `groupIds`, POST `/users?activate=True|False&provider=True|False[&nextlogin=changePassword]` with `flatToNested` body); exported `usersUpdateBody(sets: string[], arraySets: string[], context?: string): Record<string, unknown>`; exported `USER_FIELDS`. Task 11 adds bulk commands to this group via `registerUsersBulk(usersCmd, ctx)`; Task 25/27 add more subcommands, so `registerUsers` must `return` the group `Command`.
- Note Python quirk kept: `activate=True`/`False` are capitalised strings in the query.

- [ ] **Step 1: Write failing tests**

`tests/commands-users.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("users", () => {
  test("list sorted by login, -m filter, -d adds search", async () => {
    srv = startServer(standardRoutes());
    const t = testCtx(srv.url);
    await runTest(["users", "list", "--output-fields", "profile.login"], t.ctx);
    expect(t.out.join("")).toBe("alice@x.com  \nbob@x.com    \n");
    t.out.length = 0;
    await runTest(["users", "list", "-m", "firstName=bo", "-p", "--output-fields", "id"], t.ctx);
    expect(t.out.join("")).toBe("00u00000000000000001  \n");
    await runTest(["users", "list", "-d", "-s", 'profile.x eq "1"'], t.ctx);
    expect(srv.calls.at(-1)!.query.search).toBe('profile.x eq "1" and status eq "DEPROVISIONED"');
  });

  test("get by 20-char id, by login, by -f, uniqueness errors", async () => {
    srv = startServer(standardRoutes());
    const t = testCtx(srv.url);
    await runTest(["users", "get", "00u00000000000000002", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(users[1]);
    await runTest(["users", "get", "bob@x.com", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("00u00000000000000001  \n");
    expect(await runTest(["users", "get", "nobody@x.com"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: No user found with login=nobody@x.com\n");
  });

  test("groups/apps listing sorted", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/groups", body: [{ id: "g2", profile: { name: "Zeta" } }, { id: "g1", profile: { name: "Alpha" } }] },
      { method: "GET", path: "/api/v1/users/00u00000000000000001/appLinks", body: [{ appInstanceId: "a", appName: "n", label: "Zoom" }, { appInstanceId: "b", appName: "m", label: "Box" }] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "groups", "bob@x.com", "--output-fields", "profile.name"], t.ctx);
    expect(t.out.at(-1)).toBe("Alpha  \nZeta   \n");
    await runTest(["users", "apps", "bob@x.com", "--output-fields", "label"], t.ctx);
    expect(t.out.at(-1)).toBe("Box   \nZoom  \n");
  });

  test("lifecycle commands and confirmation prompts", async () => {
    srv = startServer([
      { method: "POST", path: /^\/api\/v1\/users\/[^/]+\/lifecycle\/(activate|reactivate|suspend)$/, body: { activationUrl: "x" } },
      { method: "POST", path: /^\/api\/v1\/users\/[^/]+\/lifecycle\/(deactivate|unlock)$/ },
      { method: "DELETE", path: /^\/api\/v1\/users\/[^/]+$/ },
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "activate", "bob@x.com", "-e"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ sendEmail: "true" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ activationUrl: "x" });
    await runTest(["users", "reactivate", "bob@x.com"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({});
    await runTest(["users", "unlock", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe("User 'bob@x.com' unlocked.\n");
    await runTest(["users", "suspend", "bob@x.com"], t.ctx);
    expect(srv.calls.at(-1)!.path).toEndWith("/lifecycle/suspend");
    t.answers.push("wrong");
    expect(await runTest(["users", "deactivate", "bob@x.com"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: Aborted.\n");
    t.answers.push("bob@x.com");
    await runTest(["users", "deactivate", "bob@x.com", "-e"], t.ctx);
    expect(t.out.at(-1)).toBe("User bob@x.com deactivated.\n");
    expect(srv.calls.at(-1)!.query).toEqual({ sendEmail: "true" });
    await runTest(["users", "delete", "bob@x.com", "--no-confirmation"], t.ctx);
    expect(t.out.at(-1)).toBe("User bob@x.com deleted.\n");
    expect(srv.calls.at(-1)!.method).toBe("DELETE");
  });

  test("update builds nested body with -s/-S/-c", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/users/012345", body: { ok: 1 } }]);
    const t = testCtx(srv.url);
    await runTest(["users", "update", "012345", "-s", "lastName=Doe", "-S", "tags=a, b", "-c", "profile"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ profile: { lastName: "Doe", tags: ["a", "b"] } });
    await runTest(["users", "update", "012345", "-s", "credentials.password.value=S3cret!"], t.ctx);
    expect(srv.calls[1]!.body).toEqual({ credentials: { password: { value: "S3cret!" } } });
  });

  test("add merges -s/-p/-g and query flags", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/users", body: { id: "new" } }]);
    const t = testCtx(srv.url);
    await runTest(["users", "add", "-s", "profile.login=x@y", "-s", "toplevel=ignored", "-p", "firstName=X", "-g", "00g1", "-g", "00g2", "--no-activate", "--nextlogin"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ activate: "False", provider: "False", nextlogin: "changePassword" });
    expect(srv.calls[0]!.body).toEqual({ profile: { login: "x@y", firstName: "X" }, groupIds: ["00g1", "00g2"] });
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/commands-users.test.ts`

- [ ] **Step 3: Implement**

`src/commands/users.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { flatToNested, parseAssignments } from "../lib/dotted";
import { filterDicts } from "../lib/filter";
import { getUser, retrieve } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";

export const USER_FIELDS = "id,status,profile.login,profile.firstName,profile.lastName,profile.email";

export interface AddUserParams {
  fields: Record<string, string>;
  overrideFields?: Record<string, string>;
  profileFields?: Record<string, string>;
  groupIds?: string[];
  activate: boolean;
  provider: boolean;
  nextlogin: boolean;
}

export async function addUser(client: OktaClient, p: AddUserParams): Promise<any> {
  const merged: Record<string, unknown> = { ...p.fields, ...(p.overrideFields ?? {}) };
  const dotted: Record<string, unknown> = Object.fromEntries(Object.entries(merged).filter(([k]) => k.includes(".")));
  for (const [k, v] of Object.entries(p.profileFields ?? {})) dotted[`profile.${k}`] = v;
  if (p.groupIds && p.groupIds.length) dotted.groupIds = p.groupIds;
  const query: Record<string, string> = { activate: p.activate ? "True" : "False", provider: p.provider ? "True" : "False" };
  if (p.nextlogin) query.nextlogin = "changePassword";
  return client.json("POST", "/users", { query, body: flatToNested(dotted) });
}

export function usersUpdateBody(sets: string[], arraySets: string[], context?: string): Record<string, unknown> {
  const fields: Record<string, unknown> = parseAssignments(sets);
  for (const [k, v] of Object.entries(parseAssignments(arraySets))) fields[k] = v.split(",").map((s) => s.trim());
  const prefixed = context ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${context}.${k}`, v])) : fields;
  return flatToNested(prefixed);
}

const lookupFieldOpt = (cmd: Command) => cmd.option("-f, --user-lookup-field <FIELDNAME>", "Users are matched against the ID or this profile field; default: 'login'.", "login");
const sendEmailQuery = (flag: boolean | undefined) => (flag ? { sendEmail: "true" } : {});

export function registerUsers(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "users", "Add, update (etc.) users");

  addOutputOptions(addVerbose(g.command("list").description("Lists users (all or using various filters). Does not contain deprovisioned users unless -d.")
    .option("-m, --match <FIELD=VALUE>", "Filter for profile field values (slow, case-insensitive)", collect, [])
    .option("-p, --partial", "Accept partial matches for match queries.")
    .option("-f, --filter <expr>", "Add Okta filter query")
    .option("-s, --search <expr>", "Add Okta search query")
    .option("-q, --query <q>", "Add Okta query string (fast, case-sensitive, multiple fields)")
    .option("-d, --deprovisioned", "Return only deprovisioned users")), USER_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const query: Record<string, string> = {};
      let search: string = opts.search ?? "";
      if (opts.deprovisioned) search = [search, 'status eq "DEPROVISIONED"'].filter(Boolean).join(" and ");
      if (search) query.search = search;
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      let rv: any[] = await retrieve(client, "users", undefined, { query });
      const filters = Object.fromEntries(Object.entries(parseAssignments(opts.match)).map(([k, v]) => [`profile.${k}`, v]));
      rv = filterDicts(rv, filters, Boolean(opts.partial));
      return rv.sort((a, b) => String(a.profile.login).localeCompare(String(b.profile.login)));
    }));

  addOutputOptions(addVerbose(g.command("get").description("Get one user uniquely using any profile field or ID").argument("<lookup_value>")
    .option("-f, --field <field>", "Look users up using this profile field (default: 'login')", "login")), USER_FIELDS)
    .action(action(ctx, async (client, opts, value) => {
      let rv: any[] | undefined;
      if (value.startsWith("0") && value.length === 20) {
        try { rv = [await client.get(`/users/${value}`)]; } catch (e) { if (!(e instanceof OktaApiError)) throw e; }
      }
      if (!rv) rv = await client.getAll("/users", { query: { search: `profile.${opts.field} eq "${value}"`, limit: 1000 } });
      if (rv.length === 0) throw new ExitError(`No user found with ${opts.field}=${value}`);
      if (rv.length > 1) throw new ExitError(`Criteria not unique, found ${rv.length} matches`);
      return rv[0];
    }));

  addOutputOptions(addVerbose(lookupFieldOpt(g.command("groups").description("List all groups belonging to a user").argument("<user>"))), "id,profile.name,profile.description")
    .action(action(ctx, async (client, opts, user) => {
      const u = await getUser(client, user, opts.userLookupField);
      const rv: any[] = await client.getAll(`/users/${u.id}/groups`);
      return rv.sort((a, b) => String(a.profile.name).localeCompare(String(b.profile.name)));
    }));

  addOutputOptions(addVerbose(lookupFieldOpt(g.command("apps").description("List all apps associated with a user").argument("<user>"))), "appInstanceId,appName,label")
    .action(action(ctx, async (client, opts, user) => {
      const u = await getUser(client, user, opts.userLookupField);
      const rv: any[] = await client.getAll(`/users/${u.id}/appLinks`);
      return rv.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }));

  const confirm = (loginOrId: string, question: string, skip: boolean) => {
    if (skip) return;
    if (ctx.io.prompt(question) !== loginOrId) throw new ExitError("Aborted.");
  };

  addVerbose(g.command("deactivate").description("Deactivate a user (DESTRUCTIVE OPERATION)").argument("<login_or_id>")
    .option("-e, --send-email", "Send email if set").option("--no-confirmation", "Don't ask - DANGER!!"))
    .action(action(ctx, async (client, opts, id) => {
      confirm(id, `DANGER!! Do you REALLY want to do this (maybe use 'suspend' instead)?\nThen enter '${id}': `, opts.confirmation === false);
      await client.json("POST", `/users/${id}/lifecycle/deactivate`, { query: sendEmailQuery(opts.sendEmail) });
      return `User ${id} deactivated.`;
    }));

  addOutputOptions(addVerbose(g.command("activate").description("Activate a user").argument("<login_or_id>").option("-e, --send-email", "Send email if set")), null)
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/activate`, { query: sendEmailQuery(opts.sendEmail) })));

  addOutputOptions(addVerbose(g.command("reactivate").description("Reactivate a user").argument("<login_or_id>").option("-e, --send-email", "Send email if set")), null)
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/reactivate`, { query: sendEmailQuery(opts.sendEmail) })));

  addVerbose(g.command("unlock").description("Unlock a locked user").argument("<login_or_id>"))
    .action(action(ctx, async (client, _o, id) => { await client.json("POST", `/users/${id}/lifecycle/unlock`); return `User '${id}' unlocked.`; }));

  addVerbose(g.command("delete").description("Delete a user (DESTRUCTIVE OPERATION)").argument("<login_or_id>")
    .option("-e, --send-email", "Send email if set").option("--no-confirmation", "Don't ask - DANGER!!"))
    .action(action(ctx, async (client, opts, id) => {
      confirm(id, `DANGER!! Do you REALLY want to do this?\nThen enter '${id}': `, opts.confirmation === false);
      await client.json("DELETE", `/users/${id}`, { query: sendEmailQuery(opts.sendEmail) });
      return `User ${id} deleted.`;
    }));

  addVerbose(g.command("suspend").description("Suspend a user").argument("<login_or_id>"))
    .action(action(ctx, (client, _o, id) => client.json("POST", `/users/${id}/lifecycle/suspend`)));

  addVerbose(g.command("update").description("Update a user object (POST partial update). Examples: -s profile.email=me@x.com | -S profile.multi=a,b | -c credentials.recovery_question -s question=Q -s answer=A").argument("<user_id>")
    .option("-s, --set <FIELD=value>", "set a field", collect, [])
    .option("-S, --array-set <FIELD=a,b>", "set an array field", collect, [])
    .option("-c, --context <prefix>", "Set a context (profile, credentials) to save typing"))
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}`, { body: usersUpdateBody(opts.set, opts.arraySet, opts.context) })));

  addVerbose(g.command("add").description("Add a user to Okta. '-p login=x' equals '-s profile.login=x' (-p wins).")
    .option("-s, --set <FIELD=value>", "set any user object field", collect, [])
    .option("-p, --profile <FIELD=value>", "same as '-s profile.FIELD=value'", collect, [])
    .option("-g, --group <GROUP_ID>", "groups the user should be added to on creation", collect, [])
    .option("--activate", "Set 'activation' flag, default: True").option("--no-activate")
    .option("--provider", "Set 'provider' flag, default: False").option("--no-provider")
    .option("--nextlogin", "User must change password, default: False").option("--no-nextlogin"))
    .action(action(ctx, (client, opts) => addUser(client, {
      fields: parseAssignments(opts.set), profileFields: parseAssignments(opts.profile), groupIds: opts.group,
      activate: opts.activate ?? true, provider: opts.provider ?? false, nextlogin: opts.nextlogin ?? false,
    })));

  return g;
}
```

Add `registerUsers(program, ctx)` to `src/cli/program.ts`.

- [ ] **Step 4: Run, expect pass** — `bun test tests/commands-users.test.ts` → 6 pass; `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/users.ts src/cli/program.ts tests/commands-users.test.ts
git commit -m "feat: users command group"
```

---

### Task 11: CSV/XLSX readers, concurrency, `users bulk-add` / `bulk-update`

**Files:**
- Create: `src/lib/files.ts`, `src/lib/concurrency.ts`, `src/commands/users-bulk.ts`, `tests/files.test.ts`, `tests/commands-users-bulk.test.ts`
- Modify: `src/cli/program.ts` (`registerUsersBulk(usersCmd, ctx)` using the `Command` returned by `registerUsers`)

**Interfaces:**
- Produces (`src/lib/files.ts`):
  - `csvReader(filename: string): Promise<Record<string, string>[]>` — papaparse `{ header: true, skipEmptyLines: "greedy", delimiter: "" (auto-detect) }`; drop rows whose every value is empty; trailing empty header column (from the "one column with trailing comma" trick) is dropped
  - `excelReader(filename: string): Promise<Record<string, string>[]>` — `read-excel-file/node`, first row headers, cells `String(v ?? "")`, skip all-empty rows
  - `fileReader(filename: string, opts?: { jumpToUser?: string; jumpToIndex?: number; limit?: number }): Promise<Record<string, string>[]>` — `.xlsx` → excelReader else csvReader; `jumpToUser` skips until a row whose `profile.login` or `id` equals it (that row included); else skips `jumpToIndex` rows; `limit > 0` caps
- Produces (`src/lib/concurrency.ts`): `mapConcurrent<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>, onProgress?: (done: number, total: number) => void): Promise<R[]>` — results in input order; `fn` errors propagate (callers catch inside `fn`)
- Produces (`src/commands/users-bulk.ts`): `registerUsersBulk(users: Command, ctx: Ctx): void`; `writeBulkResults(ctx, prefix: "okta-bulk-add" | "okta-bulk-update", buckets: Record<string, unknown[]>): Promise<string>` — for each bucket with items writes `${prefix}-${YYYYMMDD_HHMMSS from ctx.now()}-${name}.json` (sorted JSON) in cwd and appends `${count.padStart(4)} ${name.padEnd(6)} - ${file}\n`; empty bucket → `${count.padStart(5)} ${name.padEnd(6)}\n`; returns text + `${total} total`
- Error tuple format in result files: `[index, message, errorObject|null]` where `index = rowIndex + jumpToIndex`.
- Progress: `ctx.io.err(`\r${done}/${total}`)` and a final `\n`.

- [ ] **Step 1: Write failing tests**

`tests/files.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "../src/lib/concurrency";
import { csvReader, fileReader } from "../src/lib/files";

describe("files", () => {
  test("csvReader reads testdata with header", async () => {
    const rows = await csvReader("testdata/mock_users_one.csv");
    expect(rows.length).toBe(1);
    expect(rows[0]!["profile.login"]).toBeString();
  });
  test("csvReader auto-detects delimiter and drops trailing empty column", async () => {
    const f = `${import.meta.dir}/tmp-semicolon.csv`;
    await Bun.write(f, "profile.login;profile.firstName\na@x;A\n\n");
    expect(await csvReader(f)).toEqual([{ "profile.login": "a@x", "profile.firstName": "A" }]);
    await Bun.write(f, "profile.login,\na@x,\n");
    expect(await csvReader(f)).toEqual([{ "profile.login": "a@x" }]);
  });
  test("fileReader jump/limit", async () => {
    const all = await fileReader("testdata/mock_users_0010.csv");
    expect(all.length).toBe(10);
    expect(await fileReader("testdata/mock_users_0010.csv", { jumpToIndex: 8 })).toEqual(all.slice(8));
    expect(await fileReader("testdata/mock_users_0010.csv", { limit: 3 })).toEqual(all.slice(0, 3));
    expect(await fileReader("testdata/mock_users_0010.csv", { jumpToUser: all[4]!["profile.login"] })).toEqual(all.slice(4));
  });
});

describe("mapConcurrent", () => {
  test("keeps order, limits parallelism, reports progress", async () => {
    let active = 0, maxActive = 0;
    const progress: number[] = [];
    const rv = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5 * (6 - n)));
      active--; return n * 10;
    }, (done) => progress.push(done));
    expect(rv).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });
});
```

`tests/commands-users-bulk.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => {
  srv?.stop();
  for (const f of readdirSync(".")) if (f.startsWith("okta-bulk-")) rmSync(f);
});

describe("users bulk", () => {
  test("bulk-add posts one user per row, writes result files, summary", async () => {
    let n = 0;
    srv = startServer([{ method: "POST", path: "/api/v1/users", handler: (_r, _u, body: any) => {
      n++;
      return n === 2 ? Response.json({ errorCode: "E0000001", errorSummary: "dup", errorCauses: [] }, { status: 400 }) : Response.json({ id: `u${n}`, profile: body.profile });
    } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "bulk-add", "testdata/mock_users_0010.csv", "-l", "3", "-w", "1", "-s", "profile.site=HQ", "-g", "00g1", "--no-activate"], t.ctx)).toBe(0);
    expect(srv.calls.length).toBe(3);
    expect(srv.calls[0]!.query.activate).toBe("False");
    expect((srv.calls[0]!.body as any).profile.site).toBe("HQ");
    expect((srv.calls[0]!.body as any).groupIds).toEqual(["00g1"]);
    const out = t.out.join("");
    expect(out).toContain("   2 added  - okta-bulk-add-20260102_030405-added.json");
    expect(out).toContain("   1 errors - okta-bulk-add-20260102_030405-errors.json");
    expect(out).toEndWith("3 total\n");
    const errors = await Bun.file("okta-bulk-add-20260102_030405-errors.json").json();
    expect(errors[0][0]).toBe(1);
    expect(errors[0][2].errorCode).toBe("E0000001");
  });

  test("bulk-update prefers id column, applies -s defaults, jump-to-index offsets error index", async () => {
    const f = `${import.meta.dir}/tmp-upd.csv`;
    await Bun.write(f, "id,profile.login,profile.title,ignored\n00u1,a@x,Eng,zz\n,b@x,Ops,zz\n,,Nope,zz\n");
    srv = startServer([{ method: "POST", path: /^\/api\/v1\/users\/.+/, body: { ok: true } }]);
    const t = testCtx(srv.url);
    expect(await runTest(["users", "bulk-update", f, "-s", "profile.dept=X", "-w", "2", "-i", "0"], t.ctx)).toBe(0);
    const paths = srv.calls.map((c) => c.path).sort();
    expect(paths).toEqual(["/api/v1/users/00u1", "/api/v1/users/b@x"]);
    expect(srv.calls.find((c) => c.path.endsWith("00u1"))!.body).toEqual({ profile: { title: "Eng", dept: "X" } });
    expect(t.out.join("")).toContain("   2 updated");
    const errors = await Bun.file("okta-bulk-update-20260102_030405-errors.json").json();
    expect(errors).toEqual([[2, "missing id or profile.login column", null]]);
  });
});
```

- [ ] **Step 2: Run, expect failure** — `bun test tests/files.test.ts tests/commands-users-bulk.test.ts`

- [ ] **Step 3: Implement**

`src/lib/files.ts`:
```ts
import Papa from "papaparse";
import readXlsxFile from "read-excel-file/node";

type Row = Record<string, string>;

const nonEmpty = (r: Row) => Object.values(r).some((v) => v !== undefined && v !== null && String(v).trim() !== "");

export async function csvReader(filename: string): Promise<Row[]> {
  const text = await Bun.file(filename).text();
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: "greedy", delimiter: "", transformHeader: (h) => h.trim() });
  return parsed.data.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (k !== "") out[k] = v ?? "";
    return out;
  }).filter(nonEmpty);
}

export async function excelReader(filename: string): Promise<Row[]> {
  const rows = await readXlsxFile(filename);
  const [header, ...body] = rows;
  const keys = (header ?? []).map((c) => String(c ?? ""));
  return body.map((cells) => Object.fromEntries(keys.map((k, i) => [k, cells[i] === null || cells[i] === undefined ? "" : String(cells[i])])) as Row).filter(nonEmpty);
}

export async function fileReader(filename: string, opts: { jumpToUser?: string; jumpToIndex?: number; limit?: number } = {}): Promise<Row[]> {
  let rows = filename.toLowerCase().endsWith(".xlsx") ? await excelReader(filename) : await csvReader(filename);
  if (opts.jumpToUser) {
    const idx = rows.findIndex((r) => r["profile.login"] === opts.jumpToUser || r.id === opts.jumpToUser);
    rows = idx >= 0 ? rows.slice(idx) : [];
  } else if (opts.jumpToIndex) rows = rows.slice(opts.jumpToIndex);
  if (opts.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);
  return rows;
}
```

`src/lib/concurrency.ts`:
```ts
export async function mapConcurrent<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>, onProgress?: (done: number, total: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
      done++;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, worker));
  return results;
}
```

`src/commands/users-bulk.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addVerbose, collect, int } from "../cli/options";
import { mapConcurrent } from "../lib/concurrency";
import { flatToNested, parseAssignments } from "../lib/dotted";
import { fileReader } from "../lib/files";
import { toSortedJson } from "../lib/output";
import { OktaApiError } from "../okta/errors";
import { addUser } from "./users";

type ErrTuple = [number, string, unknown];

export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function writeBulkResults(ctx: Ctx, prefix: string, buckets: Record<string, unknown[]>): Promise<string> {
  const ts = timestamp(ctx.now());
  let rv = "";
  let total = 0;
  for (const [name, results] of Object.entries(buckets)) {
    total += results.length;
    if (results.length) {
      const file = `${prefix}-${ts}-${name}.json`;
      await Bun.write(file, toSortedJson(results));
      rv += `${String(results.length).padStart(4)} ${name.padEnd(6)} - ${file}\n`;
    } else rv += `${String(results.length).padStart(5)} ${name.padEnd(6)}\n`;
  }
  return rv + `${total} total`;
}

const toErr = (idx: number, e: unknown): ErrTuple =>
  e instanceof OktaApiError ? [idx, e.message, e.body] : [idx, e instanceof Error ? e.message : String(e), null];

const progress = (ctx: Ctx) => (done: number, total: number) => ctx.io.err(`\r${done}/${total}${done === total ? "\n" : ""}`);

export function registerUsersBulk(users: Command, ctx: Ctx): void {
  addVerbose(users.command("bulk-add").description("Bulk-ADD users from a CSV or Excel (.xlsx) file. Needs a 'profile.login' column; columns without a dot are ignored.").argument("<file>")
    .option("-s, --set <FIELD=value>", "set any user object field", collect, [])
    .option("--activate", "Set 'activation' flag, default: True").option("--no-activate")
    .option("--provider", "Set 'provider' flag, default: False").option("--no-provider")
    .option("--nextlogin", "User must change password, default: False").option("--no-nextlogin")
    .option("-g, --group <GROUP_ID>", "groups the user should be added to on creation", collect, [])
    .option("-i, --jump-to-index <IDX>", "Start with index IDX (0-based) and skip previous entries", int, 0)
    .option("-l, --limit <NUM>", "Stop after NUM updates", int, 0)
    .option("-w, --workers <NUM>", "use this many parallel requests, default: 25", int, 25))
    .action(action(ctx, async (client, opts, file) => {
      ctx.io.out("Bulk adding users might take a while. Please be patient.\n");
      const rows = await fileReader(file, { jumpToIndex: opts.jumpToIndex, limit: opts.limit });
      const added: unknown[] = [];
      const errors: ErrTuple[] = [];
      const overrides = parseAssignments(opts.set);
      await mapConcurrent(rows, opts.workers, async (row, i) => {
        const idx = i + opts.jumpToIndex;
        if (!(row["profile.login"] ?? "").trim()) { errors.push([idx, "missing profile.login column", null]); return; }
        try {
          added.push(await addUser(client, { fields: row, overrideFields: overrides, groupIds: opts.group, activate: opts.activate ?? true, provider: opts.provider ?? false, nextlogin: opts.nextlogin ?? false }));
        } catch (e) { errors.push(toErr(idx, e)); }
      }, progress(ctx));
      errors.sort((a, b) => a[0] - b[0]);
      return writeBulkResults(ctx, "okta-bulk-add", { added, errors });
    }));

  addVerbose(users.command("bulk-update").description("Bulk-update users from a CSV or Excel (.xlsx) file. Needs an 'id' or 'profile.login' column; columns without a dot are ignored.").argument("<file>")
    .option("-s, --set <FIELD=value>", "set any user object field", collect, [])
    .option("-i, --jump-to-index <IDX>", "Start with index IDX (0-based) and skip previous entries", int, 0)
    .option("-u, --jump-to-user <USER_ID>", "Same as --jump-to-index, but starts from a specific user ID / login")
    .option("-l, --limit <NUM>", "Stop after NUM updates", int, 0)
    .option("-w, --workers <NUM>", "use this many parallel requests, default: 25", int, 25))
    .action(action(ctx, async (client, opts, file) => {
      ctx.io.out("Bulk update might take a while. Please be patient.\n");
      const rows = await fileReader(file, { jumpToUser: opts.jumpToUser, jumpToIndex: opts.jumpToIndex, limit: opts.limit });
      const updated: unknown[] = [];
      const errors: ErrTuple[] = [];
      const defaults = parseAssignments(opts.set);
      await mapConcurrent(rows, opts.workers, async (row, i) => {
        const idx = i + opts.jumpToIndex;
        const { id, "profile.login": login, ...rest } = row;
        const userId = (id ?? "").trim() || (login ?? "").trim();
        if (!userId) { errors.push([idx, "missing id or profile.login column", null]); return; }
        const dotted = Object.fromEntries(Object.entries(rest).filter(([k]) => k.includes(".")));
        try { updated.push(await client.json("POST", `/users/${userId}`, { body: flatToNested(dotted, defaults) })); }
        catch (e) { errors.push(toErr(idx, e)); }
      }, progress(ctx));
      errors.sort((a, b) => a[0] - b[0]);
      return writeBulkResults(ctx, "okta-bulk-update", { updated, errors });
    }));
}
```

In `src/cli/program.ts`: `const usersCmd = registerUsers(program, ctx); registerUsersBulk(usersCmd, ctx);`

- [ ] **Step 4: Run, expect pass** — `bun test tests/files.test.ts tests/commands-users-bulk.test.ts` → 6 pass; `bun run check`. Delete `tests/tmp-*.csv` leftovers (add `tests/tmp-*` to `.gitignore`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/files.ts src/lib/concurrency.ts src/commands/users-bulk.ts src/cli/program.ts tests/files.test.ts tests/commands-users-bulk.test.ts .gitignore
git commit -m "feat: csv/xlsx readers and users bulk-add/bulk-update"
```

---

### Task 12: `pw` command group with embedded wordlist

**Files:**
- Create: `src/lib/pwgen.ts`, `src/commands/pw.ts`, `tests/pwgen.test.ts`, `tests/commands-pw.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Produces: `generatePassword(numWords: number, lang?: string): string[]` (random words from `src/assets/wordlist.sqlite` table `word(lang, word)`; langs `en`, `de`); `buildPassphrase(words: string[], minLength: number): string` — join first 3.. words with spaces until `length >= minLength` (Python loop: `for i in range(3, num_words): pw = " ".join(words[:i]); if len(pw) >= min: break` — note the last iteration uses `num_words-1` words; replicate exactly, including returning the last candidate when none reaches minLength); `registerPw(program, ctx)`.
- Embedding: `import db from "../assets/wordlist.sqlite" with { type: "sqlite", embed: "true" };` — verified to work under `bun run` and `bun build --compile` (65 MB binary, 40 ms start). Add a `declare module "*.sqlite" { const db: import("bun:sqlite").Database; export default db; }` in `src/types/sqlite.d.ts`.

- [ ] **Step 1: Write failing tests**

`tests/pwgen.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildPassphrase, generatePassword } from "../src/lib/pwgen";

describe("pwgen", () => {
  test("generatePassword returns n words for en and de", () => {
    expect(generatePassword(4, "en").length).toBe(4);
    expect(generatePassword(2, "de").every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(generatePassword(3, "xx")).toEqual([]);
  });
  test("buildPassphrase grows until minLength like python loop", () => {
    expect(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 8)).toBe("aa bb cc");
    expect(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 12)).toBe("aa bb cc dd ee");
    expect(buildPassphrase(["aa", "bb", "cc", "dd"], 99)).toBe("aa bb cc");
  });
});
```

`tests/commands-pw.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("pw", () => {
  test("reset / expire query params", async () => {
    srv = startServer([{ method: "POST", path: /lifecycle\/(reset_password|expire_password)$/, body: { ok: 1 } }]);
    const t = testCtx(srv.url);
    await runTest(["pw", "reset", "bob@x.com"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ sendEmail: "true" });
    await runTest(["pw", "reset", "bob@x.com", "-n"], t.ctx);
    expect(srv.calls[1]!.query).toEqual({ sendEmail: "false" });
    await runTest(["pw", "expire", "bob@x.com", "-t"], t.ctx);
    expect(srv.calls[2]!.query).toEqual({ tempPassword: "true" });
  });
  test("set -s expires by default, --no-expire skips, -g generates", async () => {
    srv = startServer([{ method: "POST", path: /^\/api\/v1\/users\/[^/]+$/, body: {} }, { method: "POST", path: /expire_password$/, body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["pw", "set", "bob@x.com", "-s", "Hunter2!"], t.ctx);
    expect(srv.calls.map((c) => c.path)).toEqual(["/api/v1/users/bob@x.com", "/api/v1/users/bob@x.com/lifecycle/expire_password"]);
    expect(srv.calls[0]!.body).toEqual({ credentials: { password: { value: "Hunter2!" } } });
    expect(t.out.at(-1)).toBe("PASSWORD_EXPIRED: Hunter2!\n");
    srv.calls.length = 0;
    await runTest(["pw", "set", "bob@x.com", "-s", "Hunter2!", "--no-expire"], t.ctx);
    expect(srv.calls.length).toBe(1);
    expect(t.out.at(-1)).toBe("PASSWORD: ********\n");
    await runTest(["pw", "set", "bob@x.com", "-g", "-m", "20"], t.ctx);
    const pw = (srv.calls.at(-2)!.body as any).credentials.password.value as string;
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(pw.split(" ").length).toBeGreaterThanOrEqual(3);
    expect(await runTest(["pw", "set", "bob@x.com"], t.ctx)).toBe(255);
    expect(t.err.at(-1)).toBe("ERROR: Either use -s or -g!\n");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

`src/types/sqlite.d.ts`:
```ts
declare module "*.sqlite" {
  const db: import("bun:sqlite").Database;
  export default db;
}
```

`src/lib/pwgen.ts`:
```ts
import db from "../assets/wordlist.sqlite" with { type: "sqlite", embed: "true" };

export function generatePassword(numWords: number, lang = "en"): string[] {
  const rows = db.query("SELECT word FROM word WHERE lang = ? ORDER BY random() LIMIT ?").all(lang, numWords) as { word: string }[];
  return rows.map((r) => r.word.trim());
}

export function buildPassphrase(words: string[], minLength: number): string {
  let pw = "";
  for (let i = 3; i < words.length; i++) {
    pw = words.slice(0, i).join(" ");
    if (pw.length >= minLength) break;
  }
  return pw;
}
```

`src/commands/pw.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addVerbose, int, subgroup } from "../cli/options";
import { buildPassphrase, generatePassword } from "../lib/pwgen";
import { ExitError } from "../okta/errors";

export function registerPw(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "pw", "Manage passwords");

  addVerbose(g.command("reset").description("Reset the password of a user").argument("<login-or-id>").option("-n, --no-email", "Do not send the reset email"))
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/reset_password`, { query: { sendEmail: opts.email === false ? "false" : "true" } })));

  addVerbose(g.command("expire").description("Expire the password of a user").argument("<login-or-id>").option("-t, --temp-password", "Set a temporary password"))
    .action(action(ctx, (client, opts, id) => client.json("POST", `/users/${id}/lifecycle/expire_password`, { query: { tempPassword: ******** ? "true" : "false" } })));

  addVerbose(g.command("set").description("Set a user's password").argument("<login-or-id>")
    .option("-s, --set <password>", "set password to this")
    .option("-g, --generate", "generate a random password")
    .option("--expire", "expire password (default: yes)").option("--no-expire")
    .option("-l, --language <lang>", "use a word list from this language (en, de)", "en")
    .option("-m, --min-length <n>", "minimal password length", int, 14))
    .action(action(ctx, async (client, opts, id) => {
      let password: ******** | undefined = opts.set;
      if (opts.generate) {
        const numWords = Math.max(3, Math.floor(opts.minLength / 5 + 3));
        password = ******** opts.language), opts.minLength);
      } else if (!password) throw new ExitError("Either use -s or -g!");
      await client.json("POST", `/users/${id}`, { body: { credentials: { password: { value: password } } } });
      const expire = opts.expire ?? true;
      if (expire) await client.json("POST", `/users/${id}/lifecycle/expire_password`, { query: { tempPassword: "false" } });
      return `PASSWORD${expire ? "_EXPIRED" : ""}: ${password}`;
    }));
}
```

Add `registerPw(program, ctx)` to program.

- [ ] **Step 4: Run, expect pass** — both test files; `bun run check`; also `bun run build && ./dist/okta-cli version` prints `19.0.0` (proves the sqlite embed compiles).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pwgen.ts src/types/sqlite.d.ts src/commands/pw.ts src/cli/program.ts tests/pwgen.test.ts tests/commands-pw.test.ts
git commit -m "feat: pw command group with embedded wordlist"
```

---

### Task 13: `apps` command group

**Files:**
- Create: `src/commands/apps.ts`, `tests/commands-apps.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `getApp`, `getUser`, `getGroup`, `retrieve`, `selectField`, `parseAssignments`, `flatToNested`.
- Produces: `registerApps(program, ctx): Command`; exported `buildAppBody(name: string | undefined, signonmode: string | undefined, label: string | undefined, sets: string[]): Record<string, unknown>` and constants `APP_TYPES`, `SIGNON_TYPES`, `SIGNON_DEFAULTS`, `APP_DEFAULTS`, `PREF_SHORTCUTS` (values exactly as in the compatibility table).

- [ ] **Step 1: Write failing tests**

`tests/commands-apps.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { buildAppBody } from "../src/commands/apps";
import { apps, standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

describe("apps", () => {
  test("buildAppBody applies shortcuts, defaults, signOnMode", () => {
    expect(buildAppBody("bookmark", undefined, "My", ["sa.url=http://x", "v.hide.web=true"])).toEqual({
      name: "bookmark", label: "My", signOnMode: "BOOKMARK",
      settings: { app: { requestIntegration: "false", url: "http://x" } }, visibility: { hide: { web: "true" } },
    });
    expect(buildAppBody(undefined, "SAML_2_0", undefined, [])).toEqual({ signOnMode: "SAML_2_0" });
  });
  test("list sorted by label with partial filter; get; users sorted", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/apps/0oa2/users", body: [{ id: "u2", credentials: { userName: "z" } }, { id: "u1", credentials: { userName: "a" } }] }, ...standardRoutes()]);
    const t = testCtx(srv.url);
    await runTest(["apps", "list"], t.ctx);
    expect(t.out.at(-1)).toBe("0oa2  Slack  \n0oa1  Zoom   \n");
    await runTest(["apps", "list", "zoo", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("0oa1  \n");
    await runTest(["apps", "get", "slack", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(apps[1]);
    await runTest(["apps", "users", "Slack", "--output-fields", "credentials.userName"], t.ctx);
    expect(t.out.at(-1)).toBe("a  \nz  \n");
  });
  test("adduser/removeuser/addgroup/removegroup/lifecycle/delete", async () => {
    srv = startServer([
      { method: "POST", path: "/api/v1/apps/0oa2/users", body: { id: "00u00000000000000001", scope: "USER", status: "ACTIVE", credentials: { userName: "bob@x.com" } } },
      { method: "DELETE", path: /^\/api\/v1\/apps\/0oa2\/(users|groups)\/.+/ },
      { method: "PUT", path: "/api/v1/apps/0oa2/groups/00g1", body: { id: "00g1", priority: 0 } },
      { method: "POST", path: /^\/api\/v1\/apps\/0oa2\/lifecycle\/(activate|deactivate)$/ },
      { method: "DELETE", path: "/api/v1/apps/0oa2" },
      { method: "POST", path: "/api/v1/apps", body: { id: "0oa9", label: "New" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["apps", "adduser", "-a", "slack", "-u", "bob@x.com", "-s", "credentials.userName=bob@x.com"], t.ctx);
    expect(srv.calls.find((c) => c.method === "POST")!.body).toEqual({ id: "00u00000000000000001", credentials: { userName: "bob@x.com" } });
    expect(t.out.at(-1)).toBe("00u00000000000000001  bob@x.com  USER  ACTIVE    \n");
    await runTest(["apps", "removeuser", "-a", "slack", "-u", "bob@x.com"], t.ctx);
    expect(t.out.at(-1)).toBe("User 00u00000000000000001 (bob@x.com) removed from app 0oa2 (Slack)\n");
    await runTest(["apps", "addgroup", "-a", "slack", "-g", "engineering"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ id: "00g1", priority: 0 });
    await runTest(["apps", "removegroup", "-a", "slack", "-g", "engineering"], t.ctx);
    expect(t.out.at(-1)).toBe("App 0oa2 (Slack) removed from group 00g1 (Engineering)\n");
    await runTest(["apps", "activate", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("application 0oa2 (Slack) activated\n");
    await runTest(["apps", "deactivate", "0oa2"], t.ctx);
    expect(t.out.at(-1)).toBe("application 0oa2 (Slack) deactivated\n");
    await runTest(["apps", "delete", "slack"], t.ctx);
    expect(t.out.at(-1)).toBe("application 0oa2 (Slack) deleted\n");
    await runTest(["apps", "add", "-n", "bookmark", "-l", "New", "-s", "sa.url=http://x"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "bookmark", label: "New", signOnMode: "BOOKMARK", settings: { app: { requestIntegration: "false", url: "http://x" } } });
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

`src/commands/apps.ts`:
```ts
import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { flatToNested, parseAssignments } from "../lib/dotted";
import { getApp, getGroup, getUser, retrieve, selectField } from "../lib/lookup";

export const APP_TYPES = ["bookmark", "template_basic_auth", "template_swa", "template_swa3field", "template_sps", "oidc_client", "template_wsfed"];
export const SIGNON_TYPES = ["BOOKMARK", "BASIC_AUTH", "BROWSER_PLUGIN", "SECURE_PASSWORD_STORE", "SAML_2_0", "WS_FEDERATION", "AUTO_LOGIN", "OPENID_CONNECT", "Custom"];
export const SIGNON_DEFAULTS: Record<string, string> = {
  bookmark: "BOOKMARK", template_basic_auth: "BASIC_AUTH", template_swa: "BROWSER_PLUGIN", template_swa3field: "BROWSER_PLUGIN",
  template_sps: "SECURE_PASSWORD_STORE", oidc_client: "OPENID_CONNECT", template_wsfed: "WS_FEDERATION",
};
export const APP_DEFAULTS: Record<string, [string, string][]> = { bookmark: [["sa.requestIntegration", "false"]] };
export const PREF_SHORTCUTS: [string, string][] = [["sa", "settings.app"], ["v", "visibility"], ["f", "features"], ["c", "credentials"]];

const unshorten = (key: string): string => {
  for (const [short, long] of PREF_SHORTCUTS) if (key.startsWith(`${short}.`)) return `${long}.${key.slice(short.length + 1)}`;
  return key;
};

export function buildAppBody(name: string | undefined, signonmode: string | undefined, label: string | undefined, sets: string[]): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [k, v] of [...(name ? APP_DEFAULTS[name] ?? [] : []), ...Object.entries(parseAssignments(sets))]) flat[unshorten(k)] = v;
  if (name && SIGNON_DEFAULTS[name]) signonmode = SIGNON_DEFAULTS[name];
  if (name !== undefined) flat.name = name;
  if (label !== undefined) flat.label = label;
  if (signonmode !== undefined) flat.signOnMode = signonmode;
  return flatToNested(flat);
}

const APPUSER_FIELDS = "id,credentials.userName,scope,status,syncState";
const appUserOpts = (cmd: Command) => cmd
  .requiredOption("-a, --app <label-or-id>").requiredOption("-u, --user <id-or-fieldvalue>")
  .option("-f, --user-lookup-field <FIELDNAME>", "Users are matched against the ID or this profile field; default: 'login'.", "login");
const appGroupOpts = (cmd: Command) => cmd.requiredOption("-a, --app <label-or-id>").requiredOption("-g, --group <name-or-id>");

export function registerApps(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "apps", "Application operations");

  addVerbose(g.command("add").description("Add a new application. EXAMPLE: okta-cli apps add -n bookmark -l my_bookmark -s sa.url=http://my.url")
    .addOption(new Option("-n, --name <type>", "The application name - Okta-internal field, NOT the label").choices(APP_TYPES))
    .addOption(new Option("-m, --signonmode <mode>", "Sign on mode of the app").choices(SIGNON_TYPES))
    .option("-l, --label <label>", "The application label")
    .option("-s, --set <k=v>", "Set app parameter; prefix shortcuts sa=settings.app, v=visibility, f=features, c=credentials", collect, []))
    .action(action(ctx, (client, opts) => client.json("POST", "/apps", { body: buildAppBody(opts.name, opts.signonmode, opts.label, opts.set) })));

  for (const verb of ["activate", "deactivate"] as const) {
    addVerbose(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} an application`).argument("<label-or-id>"))
      .action(action(ctx, async (client, _o, labelOrId) => {
        const app = await getApp(client, labelOrId);
        await client.json("POST", `/apps/${app.id}/lifecycle/${verb}`);
        return `application ${app.id} (${app.label}) ${verb}d`;
      }));
  }

  addVerbose(g.command("delete").description("Delete an application (deactivate first)").argument("<label-or-id>"))
    .action(action(ctx, async (client, _o, labelOrId) => {
      const app = await getApp(client, labelOrId);
      await client.json("DELETE", `/apps/${app.id}`);
      return `application ${app.id} (${app.label}) deleted`;
    }));

  addOutputOptions(addVerbose(g.command("list").description("List all defined applications; optional argument filters by label substring ('-q' = starts-with, fast)").argument("[partial_name]")
    .option("-f, --filter <EXPRESSION>").option("-q, --query <q>")), "id,label")
    .action(action(ctx, async (client, opts, partial?: string) => {
      const query: Record<string, string> = {};
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      const rv = await retrieve(client, "apps", partial, { selector: partial ? selectField("label", partial) : undefined, query });
      const list: any[] = Array.isArray(rv) ? rv : [rv];
      return list.sort((a, b) => String(a.label).toLowerCase().localeCompare(String(b.label).toLowerCase()));
    }));

  addOutputOptions(addVerbose(g.command("users").description("List all users for an application").argument("<app>")), "status,id,credentials.userName,")
    .action(action(ctx, async (client, _o, appArg) => {
      const app = await getApp(client, appArg);
      const rv: any[] = await client.getAll(`/apps/${app.id}/users`);
      return rv.sort((a, b) => String(a.credentials?.userName).localeCompare(String(b.credentials?.userName)));
    }));

  addOutputOptions(addVerbose(g.command("get").description("Retrieves information about one specific application").argument("[partial_name]")), "id,name,label")
    .action(action(ctx, (client, _o, partial) => getApp(client, partial)));

  addOutputOptions(addVerbose(appUserOpts(g.command("getuser").description("Retrieves one assigned user of an application"))), APPUSER_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const user = await getUser(client, opts.user, opts.userLookupField);
      return client.get(`/apps/${app.id}/users/${user.id}`);
    }));

  addOutputOptions(addVerbose(appUserOpts(g.command("adduser").description("Add a user to an application")).option("-s, --set <k=v>", "app user fields", collect, [])), APPUSER_FIELDS)
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const user = await getUser(client, opts.user, opts.userLookupField);
      const body = flatToNested({ ...parseAssignments(opts.set), id: user.id });
      return client.json("POST", `/apps/${app.id}/users`, { body });
    }));

  addVerbose(appUserOpts(g.command("removeuser").description("Removes a user from an application")))
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const user = await getUser(client, opts.user, opts.userLookupField);
      await client.json("DELETE", `/apps/${app.id}/users/${user.id}`);
      return `User ${user.id} (${user.profile.login}) removed from app ${app.id} (${app.label})`;
    }));

  addOutputOptions(addVerbose(appGroupOpts(g.command("addgroup").description("Assigns a group to this app"))), null)
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const group = await getGroup(client, opts.group);
      return client.json("PUT", `/apps/${app.id}/groups/${group.id}`);
    }));

  addVerbose(appGroupOpts(g.command("removegroup").description("Removes a group association from an app")))
    .action(action(ctx, async (client, opts) => {
      const app = await getApp(client, opts.app);
      const group = await getGroup(client, opts.group);
      await client.json("DELETE", `/apps/${app.id}/groups/${group.id}`);
      return `App ${app.id} (${app.label}) removed from group ${group.id} (${group.profile.name})`;
    }));

  addOutputOptions(addVerbose(g.command("groups").description("List the groups associated to an app").argument("<app>")), null)
    .action(action(ctx, async (client, _o, appArg) => {
      const app = await getApp(client, appArg);
      const rv: any[] = await client.getAll(`/apps/${app.id}/groups`);
      return rv.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    }));

  return g;
}
```

Add `registerApps(program, ctx)` to program.

- [ ] **Step 4: Run, expect pass** — `bun test tests/commands-apps.test.ts` → 3 pass; `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/apps.ts src/cli/program.ts tests/commands-apps.test.ts
git commit -m "feat: apps command group"
```

---

### Task 14: `features` and `eventhooks` command groups

**Files:**
- Create: `src/commands/features.ts`, `src/commands/eventhooks.ts`, `tests/commands-features-eventhooks.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `retrieve`, `getOne`, `selectField`, `filterDicts`, `parseAssignments`, `collect`.
- Produces: `registerFeatures(program, ctx)`, `registerEventhooks(program, ctx): Command` (returned so Task 21 can reuse nothing — inlinehooks get their own module — but keep the return for symmetry); exported `eventHookBody(url: string, name: string, events: string[]): Record<string, unknown>` (flattens comma-separated `events`).

- [ ] **Step 1: Write failing tests**

`tests/commands-features-eventhooks.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { eventHookBody } from "../src/commands/eventhooks";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const features = [
  { id: "f2", name: "Recent Activity", status: "DISABLED", stage: { value: "EA" }, type: "self-service" },
  { id: "f1", name: "Admin Console", status: "ENABLED", stage: { value: "GA" }, type: "self-service" },
];
const hooks = [{ id: "eh1", name: "audit-forwarder", status: "ACTIVE", verificationStatus: "VERIFIED", created: "2025-01-01T00:00:00.000Z" }];
const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };

describe("features", () => {
  test("list sorted by name with -m; get; enable --force; dependents", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/features\/[^/]+$/, status: 404, body: notFound },
      { method: "GET", path: "/api/v1/features", body: features },
      { method: "POST", path: "/api/v1/features/f2/enable", body: { ...features[0], status: "ENABLED" } },
      { method: "GET", path: "/api/v1/features/f2/dependents", body: [features[1]] },
    ]);
    const t = testCtx(srv.url);
    await runTest(["features", "list", "--output-fields", "name"], t.ctx);
    expect(t.out.at(-1)).toBe("Admin Console    \nRecent Activity  \n");
    await runTest(["features", "list", "-m", "status=enab", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("f1  \n");
    await runTest(["features", "get", "recent", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("f2");
    await runTest(["features", "enable", "Recent Activity", "--force", "--output-fields", "status"], t.ctx);
    expect(srv.calls.at(-1)!.query).toEqual({ mode: "force" });
    expect(t.out.at(-1)).toBe("ENABLED  \n");
    await runTest(["features", "dependents", "recent", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("f1  \n");
  });
});

describe("eventhooks", () => {
  test("eventHookBody", () => {
    expect(eventHookBody("https://h", "n", ["user.lifecycle.create,user.lifecycle.delete", "group.user_membership.add"])).toEqual({
      name: "n", events: { type: "EVENT_TYPE", items: ["user.lifecycle.create", "user.lifecycle.delete", "group.user_membership.add"] },
      channel: { type: "HTTP", version: "1.0.0", config: { uri: "https://h" } },
    });
  });
  test("list/get/add/update/activate/verify/deactivate/delete", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/eventHooks\/[^/]+$/, status: 404, body: notFound },
      { method: "GET", path: "/api/v1/eventHooks", body: hooks },
      { method: "POST", path: "/api/v1/eventHooks", body: hooks[0] },
      { method: "PUT", path: "/api/v1/eventHooks/eh1", body: hooks[0] },
      { method: "POST", path: /^\/api\/v1\/eventHooks\/eh1\/lifecycle\/(activate|deactivate|verify)$/, body: hooks[0] },
      { method: "DELETE", path: "/api/v1/eventHooks/eh1" },
    ]);
    const t = testCtx(srv.url);
    await runTest(["eventhooks", "list", "audit", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("eh1  \n");
    await runTest(["eventhooks", "add", "-u", "https://h", "-n", "x", "-e", "a,b", "-j"], t.ctx);
    expect((srv.calls.at(-1)!.body as any).events.items).toEqual(["a", "b"]);
    await runTest(["eventhooks", "update", "audit", "-u", "https://h2", "-n", "y", "-e", "c"], t.ctx);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    for (const verb of ["activate", "verify", "deactivate"]) {
      await runTest(["eventhooks", verb, "audit"], t.ctx);
      expect(srv.calls.at(-1)!.path).toBe(`/api/v1/eventHooks/eh1/lifecycle/${verb}`);
    }
    await runTest(["eventhooks", "delete", "audit"], t.ctx);
    expect(t.out.at(-1)).toBe("event hook eh1 (audit-forwarder) deleted\n");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

`src/commands/features.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { parseAssignments } from "../lib/dotted";
import { filterDicts } from "../lib/filter";
import { getOne, retrieve, selectField } from "../lib/lookup";

const FIELDS = "id,status,stage.value,type,name";
const byName = (a: any, b: any) => String(a.name).localeCompare(String(b.name));
const nameOpt = (cmd: Command) => cmd.argument("[partial_name]").option("-f, --partial-name-field <field>", "match the argument against this field", "name");
const getFeature = (client: any, opts: any, partial: string | undefined) => getOne(client, "features", partial, { selector: selectField(opts.partialNameField, partial ?? "") });

export function registerFeatures(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "features", "Feature operations");

  addOutputOptions(addVerbose(nameOpt(g.command("list").description("Lists tenant features"))
    .option("-m, --match <k=v>", "regex filters on fields", collect, [])
    .option("-p, --partial", "Accept partial matches for match queries (default: true)", true)
    .option("--no-partial")), FIELDS)
    .action(action(ctx, async (client, opts, partial?: string) => {
      const rv: any[] = await retrieve(client, "features", undefined, { selector: partial ? selectField(opts.partialNameField, partial) : undefined });
      return filterDicts(rv, parseAssignments(opts.match), opts.partial ?? true).sort(byName);
    }));

  addOutputOptions(addVerbose(nameOpt(g.command("get").description("Retrieves information about one specific feature"))), FIELDS)
    .action(action(ctx, (client, opts, partial) => getFeature(client, opts, partial)));

  for (const mode of ["enable", "disable"] as const) {
    addOutputOptions(addVerbose(nameOpt(g.command(mode).description(`${mode[0]!.toUpperCase()}${mode.slice(1)} a feature`)).option("--force", "force mode")), FIELDS)
      .action(action(ctx, async (client, opts, partial) => {
        const f = await getFeature(client, opts, partial);
        return client.json("POST", `/features/${f.id}/${mode}`, { query: opts.force ? { mode: "force" } : {} });
      }));
  }
  for (const rel of ["dependents", "dependencies"] as const) {
    addOutputOptions(addVerbose(nameOpt(g.command(rel).description(rel === "dependents" ? "List features depending on this one" : "List dependencies of this feature")).option("--force", "(ignored, kept for compatibility)")), FIELDS)
      .action(action(ctx, async (client, opts, partial) => {
        const f = await getFeature(client, opts, partial);
        const rv: any[] = await client.getAll(`/features/${f.id}/${rel}`);
        return rv.sort(byName);
      }));
  }
}
```

`src/commands/eventhooks.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { getOne, retrieve, selectField } from "../lib/lookup";

const FIELDS = "id,created,status,verificationStatus,name";

export function eventHookBody(url: string, name: string, events: string[]): Record<string, unknown> {
  return {
    name,
    events: { type: "EVENT_TYPE", items: events.flatMap((e) => e.split(",")).map((s) => s.trim()).filter(Boolean) },
    channel: { type: "HTTP", version: "1.0.0", config: { uri: url } },
  };
}

const hookOpts = (cmd: Command) => cmd
  .requiredOption("-u, --url <url>", "The URL where the events will be sent to by Okta")
  .requiredOption("-n, --name <name>", "A short name (description) of the event hook")
  .requiredOption("-e, --event <events>", "Event types (comma separated or multiple -e)", collect, []);
const getHook = (client: any, partial: string) => getOne(client, "eventHooks", partial, { selector: selectField("name", partial) });

export function registerEventhooks(program: Command, ctx: Ctx): Command {
  const g = subgroup(program, "eventhooks", "Event hook operations");

  addOutputOptions(addVerbose(g.command("list").description("Lists event hooks").argument("[partial_name]")), FIELDS)
    .action(action(ctx, (client, _o, partial?: string) => retrieve(client, "eventHooks", undefined, { selector: partial ? selectField("name", partial) : undefined })));

  addOutputOptions(addVerbose(g.command("get").description("Retrieves one event hook").argument("<partial_name>")), FIELDS)
    .action(action(ctx, (client, _o, partial) => getHook(client, partial)));

  addOutputOptions(addVerbose(hookOpts(g.command("add").description("Creates a new event hook"))), FIELDS)
    .action(action(ctx, (client, opts) => client.json("POST", "/eventHooks", { body: eventHookBody(opts.url, opts.name, opts.event) })));

  addOutputOptions(addVerbose(hookOpts(g.command("update").description("Updates an event hook").argument("<partial_name>"))), FIELDS)
    .action(action(ctx, async (client, opts, partial) => {
      const existing = await getHook(client, partial);
      return client.json("PUT", `/eventHooks/${existing.id}`, { body: eventHookBody(opts.url, opts.name, opts.event) });
    }));

  for (const verb of ["activate", "deactivate", "verify"] as const) {
    addOutputOptions(addVerbose(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)}s an event hook`).argument("<partial_name>")), FIELDS)
      .action(action(ctx, async (client, _o, partial) => {
        const existing = await getHook(client, partial);
        return client.json("POST", `/eventHooks/${existing.id}/lifecycle/${verb}`);
      }));
  }

  addVerbose(g.command("delete").description("Deletes an event hook").argument("<partial_name>"))
    .action(action(ctx, async (client, _o, partial) => {
      const existing = await getHook(client, partial);
      await client.json("DELETE", `/eventHooks/${existing.id}`);
      return `event hook ${existing.id} (${existing.name}) deleted`;
    }));
  return g;
}
```

Register both in program.

- [ ] **Step 4: Run, expect pass** — 3 pass; `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/features.ts src/commands/eventhooks.ts src/cli/program.ts tests/commands-features-eventhooks.test.ts
git commit -m "feat: features and eventhooks command groups"
```

---

### Task 15: `dump` and `raw` root commands

**Files:**
- Create: `src/commands/misc.ts`, `src/lib/body.ts`, `tests/commands-misc.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Produces (`src/lib/body.ts`): `parseBody(body: string | undefined, sets?: string[]): unknown` — `undefined` and no sets → `undefined`; `FILE:<path>` reads and JSON-parses the file; otherwise `JSON.parse(body)`; `-s k=v` assignments are `flatToNested` and `deepMerge`d over the parsed body (or become the body). Invalid JSON → `ExitError("Body is not valid JSON: <msg>")`.
- Produces (`src/commands/misc.ts`): `registerMisc(program, ctx)`; `dump` writes into `opts.dir ?? okta-dump-${YYYYMMDDHHMMSS from ctx.now()}` the files `users.csv` (active list + `status eq "DEPROVISIONED"` list, via `toCsv`), `groups.csv`, `apps.csv`, `group_users.csv` (header `group,user`), `app_users.csv` (header `app,user`), with per-object `/users?limit=1000` fetched via `mapConcurrent(..., 25, ...)`. Progress lines to `ctx.io.out` exactly: `Please be patient, this can take several minutes.`, `Saving user list ... done.`, `Skipping list of users.`, `Saving group list ... done.`, `Saving group users ... done.` / `Skipping list of group users.`, `Saving app list ... done.`, `Saving app users ... done.` / `Skipping list of app users.`.
- `raw <api_endpoint> -X/--http-method <m> -q/--query k=v... -b/--body <json|FILE:path> --base-path <p>` (output options, default fields none) → `client.getAll` when method is GET and the first page is an array, else `client.json`. Simplest correct rule: for GET call `client.request`, parse; if array and Link next present continue via `getAll` semantics — implement as: `method === "GET" ? await client.getAll(...)` **only if** the response is an array; do this with a small helper `getAuto(client, path, opts)` that does one `request`, inspects the JSON, and if it is an array follows pagination like `getAll`. Put `getAuto` in `src/okta/client.ts` as a method `getAuto<T = any>(path, opts?): Promise<T>` (add a test for it in `tests/client.test.ts`: object passthrough, array with next link concatenated).

- [ ] **Step 1: Write failing tests**

Add to `tests/client.test.ts`:
```ts
  test("getAuto returns objects as-is and paginates arrays", async () => {
    srv = startServer([]);
    srv.add({ method: "GET", path: "/api/v1/org", body: { id: "o", _links: {} } });
    srv.add({ method: "GET", path: "/api/v1/things", handler: (_r, url) => url.searchParams.get("after")
      ? Response.json([{ id: 2 }])
      : Response.json([{ id: 1 }], { headers: { Link: `<${srv.url}/api/v1/things?after=1>; rel="next"` } }) });
    const c = new OktaClient(srv.url, "tok", { sleep: noSleep });
    expect(await c.getAuto("/org")).toEqual({ id: "o" });
    expect(await c.getAuto("/things")).toEqual([{ id: 1 }, { id: 2 }]);
  });
```

`tests/commands-misc.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { parseBody } from "../src/lib/body";
import { apps, groups, standardRoutes, users } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => { srv?.stop(); if (existsSync("okta-dump-20260102030405")) rmSync("okta-dump-20260102030405", { recursive: true }); });

describe("parseBody", () => {
  test("json, FILE:, sets merge", async () => {
    expect(parseBody(undefined)).toBeUndefined();
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody('{"a":{"b":1}}', ["a.c=2", "d=x"])).toEqual({ a: { b: 1, c: "2" }, d: "x" });
    expect(parseBody(undefined, ["profile.name=n"])).toEqual({ profile: { name: "n" } });
    const f = `${import.meta.dir}/tmp-body.json`;
    await Bun.write(f, '{"z":true}');
    expect(parseBody(`FILE:${f}`)).toEqual({ z: true });
    expect(() => parseBody("{nope")).toThrow("Body is not valid JSON");
  });
});

describe("raw", () => {
  test("GET with query, POST with body, base path", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/users", body: users }, { method: "POST", path: "/oauth2/v1/clients", body: { id: "c1" } }]);
    const t = testCtx(srv.url);
    await runTest(["raw", "/users", "-q", "limit=1", "-q", 'search=status eq "ACTIVE"', "--output-fields", "id"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ limit: "1", search: 'status eq "ACTIVE"' });
    expect(t.out.at(-1)).toBe("00u00000000000000001  \n00u00000000000000002  \n");
    await runTest(["raw", "clients", "-X", "post", "-b", '{"client_name":"x"}', "--base-path", "oauth2/v1"], t.ctx);
    expect(srv.calls[1]!.body).toEqual({ client_name: "x" });
    expect(JSON.parse(t.out.at(-1)!)).toEqual({ id: "c1" });
  });
});

describe("dump", () => {
  test("writes five csv files", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/groups\/[^/]+\/users$/, body: [users[0]] },
      { method: "GET", path: /^\/api\/v1\/apps\/[^/]+\/users$/, body: [users[1]] },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    expect(await runTest(["dump"], t.ctx)).toBe(0);
    const dir = "okta-dump-20260102030405";
    expect(readFileSync(`${dir}/users.csv`, "utf8").split("\r\n").length).toBe(2 + users.length * 2);
    expect(readFileSync(`${dir}/groups.csv`, "utf8")).toStartWith("id,profile.description,profile.name,type\r\n");
    expect(readFileSync(`${dir}/apps.csv`, "utf8").split("\r\n").length).toBe(apps.length + 2);
    expect(readFileSync(`${dir}/group_users.csv`, "utf8")).toBe(`group,user\r\n${groups.map((g) => `${g.id},${users[0]!.id}`).join("\r\n")}\r\n`);
    expect(readFileSync(`${dir}/app_users.csv`, "utf8")).toBe(`app,user\r\n${apps.map((a) => `${a.id},${users[1]!.id}`).join("\r\n")}\r\n`);
    expect(t.out.join("")).toContain("Saving group users ... done.");
    const t2 = testCtx(srv.url);
    await runTest(["dump", "--no-user-list", "--no-app-users", "--no-group-users", "-d", "okta-dump-20260102030405"], t2.ctx);
    expect(t2.out.join("")).toContain("Skipping list of users.");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

Add to `OktaClient`:
```ts
  async getAuto<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    const rsp = await this.request("GET", path, opts);
    const text = await rsp.text();
    if (!text) return undefined as T;
    const first = JSON.parse(text);
    if (!Array.isArray(first)) return stripLinks(first) as T;
    const out: unknown[] = first.map(stripLinks);
    let next = parseNextLink(rsp.headers.get("link"));
    let last: string | undefined;
    while (next && next !== last && out.length) {
      last = next;
      const r = await this.request("GET", next);
      const page = (await r.json()) as unknown[];
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page.map(stripLinks));
      next = parseNextLink(r.headers.get("link"));
    }
    return out as T;
  }
```

`src/lib/body.ts`:
```ts
import { ExitError } from "../okta/errors";
import { deepMerge, flatToNested, isPlainObject, parseAssignments } from "./dotted";
import { readFileSync } from "node:fs";

export function parseBody(body: string | undefined, sets: string[] = []): unknown {
  let parsed: unknown = undefined;
  if (body !== undefined) {
    const text = body.startsWith("FILE:") ? readFileSync(body.slice(5), "utf8") : body;
    try { parsed = JSON.parse(text); } catch (e) { throw new ExitError(`Body is not valid JSON: ${(e as Error).message}`); }
  }
  if (sets.length === 0) return parsed;
  const fromSets = flatToNested(parseAssignments(sets));
  return isPlainObject(parsed) ? deepMerge(parsed, fromSets) : fromSets;
}
```

`src/commands/misc.ts`:
```ts
import { Option, type Command } from "commander";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect } from "../cli/options";
import { parseBody } from "../lib/body";
import { mapConcurrent } from "../lib/concurrency";
import { parseAssignments } from "../lib/dotted";
import { toCsv } from "../lib/output";
import type { Method, OktaClient } from "../okta/client";

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function registerMisc(program: Command, ctx: Ctx): void {
  addVerbose(program.command("dump").description("Dump basically everything into CSV files for further processing (includes DEPROVISIONED users)")
    .option("-d, --dir <dir>", "Save in this directory")
    .option("--no-user-list").option("--no-app-users").option("--no-group-users"))
    .action(action(ctx, async (client: OktaClient, opts) => {
      const dir: string = opts.dir ?? `okta-dump-${stamp(ctx.now())}`;
      mkdirSync(dir, { recursive: true });
      const save = (file: string, text: string) => Bun.write(join(dir, file), text);
      ctx.io.out("Please be patient, this can take several minutes.\n");
      if (opts.userList === false) ctx.io.out("Skipping list of users.\n");
      else {
        ctx.io.out("Saving user list ... ");
        const list = [...(await client.getAll("/users", { query: { limit: 1000 } })), ...(await client.getAll("/users", { query: { limit: 1000, search: 'status eq "DEPROVISIONED"' } }))];
        await save("users.csv", toCsv(list));
        ctx.io.out("done.\n");
      }
      for (const [what, skip] of [["group", opts.groupUsers === false], ["app", opts.appUsers === false]] as const) {
        ctx.io.out(`Saving ${what} list ... `);
        const items: any[] = await client.getAll(`/${what}s`);
        await save(`${what}s.csv`, toCsv(items));
        ctx.io.out("done.\n");
        if (skip) { ctx.io.out(`Skipping list of ${what} users.\n`); continue; }
        ctx.io.out(`Saving ${what} users ... `);
        const pairs = await mapConcurrent(items, 25, async (it) => (await client.getAll(`/${what}s/${it.id}/users`, { query: { limit: 1000 } })).map((u: any) => `${it.id},${u.id}`));
        await save(`${what}_users.csv`, [`${what},user`, ...pairs.flat()].join("\r\n") + "\r\n");
        ctx.io.out("done.\n");
      }
      return undefined;
    }));

  addOutputOptions(addVerbose(program.command("raw").description("Perform a request against the specified API endpoint").argument("<api_endpoint>")
    .addOption(new Option("-X, --http-method <method>", "HTTP method; default: get").choices(["get", "post", "put", "delete", "patch"]).default("get"))
    .option("-q, --query <field=value>", "Set a query field in the URL", collect, [])
    .option("-b, --body <json>", "Message body; use FILE:<filename> to read from file")
    .option("--base-path <path>", "Different base path than the default (/api/v1)")), null)
    .action(action(ctx, (client, opts, endpoint) => {
      const method = String(opts.httpMethod).toUpperCase() as Method;
      const query = parseAssignments(opts.query);
      const basePath = opts.basePath ? (opts.basePath.startsWith("/") ? opts.basePath : `/${opts.basePath}`) : undefined;
      const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
      return method === "GET" ? client.getAuto(path, { query, basePath }) : client.json(method, path, { query, body: parseBody(opts.body), basePath });
    }));
}
```

Register in program.

- [ ] **Step 4: Run, expect pass** — `bun run check` green (client test count now 10).

- [ ] **Step 5: Commit**

```bash
git add src/commands/misc.ts src/lib/body.ts src/okta/client.ts src/cli/program.ts tests/commands-misc.test.ts tests/client.test.ts
git commit -m "feat: dump and raw commands, body parsing"
```

---

### Task 16: Generate Okta types and path list from the pinned spec

**Files:**
- Create: `scripts/gen-types.ts`, `src/okta/types.ts`, `src/okta/schema.d.ts` (generated), `src/okta/spec-paths.json` (generated), `tests/spec-paths.test.ts`

**Interfaces:**
- Produces: `SPEC_VERSION = "2026.08.4"` and `SPEC_URL` in `scripts/gen-types.ts`; `src/okta/schema.d.ts` exporting `paths`, `components`, `operations`; `src/okta/spec-paths.json` = sorted array of every key of `paths` (e.g. `"/api/v1/users/{id}"`); `src/okta/types.ts`:
  ```ts
  import type { components } from "./schema";
  export type Schema<K extends keyof components["schemas"]> = components["schemas"][K];
  ```
- Produces (test helper, `tests/spec-paths.test.ts` exports nothing; `src/okta/spec-paths.ts` exports `knownPath(path: string): boolean` — true when `/api/v1${path}` (or `path` itself when it already starts with `/api/`) matches a template where `{x}` segments match any non-empty non-slash string). Tasks 17+ use `knownPath` in tests to assert every `ResourceSpec.path` and every hard-coded command path exists.

- [ ] **Step 1: Write the generator**

`scripts/gen-types.ts`:
```ts
import openapiTS, { astToString } from "openapi-typescript";
import { parse } from "yaml";

export const SPEC_VERSION = "2026.08.4";
export const SPEC_URL = `https://raw.githubusercontent.com/okta/okta-management-openapi-spec/master/dist/${SPEC_VERSION}/management-oneOfInheritance.yaml`;

const rsp = await fetch(SPEC_URL);
if (!rsp.ok) throw new Error(`fetch ${SPEC_URL}: ${rsp.status}`);
const text = await rsp.text();
const spec = parse(text) as { paths: Record<string, unknown>; info: { version: string } };

const ast = await openapiTS(text, { });
await Bun.write("src/okta/schema.d.ts", `// GENERATED by scripts/gen-types.ts from Okta management spec ${spec.info.version}. Do not edit.\n${astToString(ast)}`);
await Bun.write("src/okta/spec-paths.json", JSON.stringify(Object.keys(spec.paths).sort(), null, 1) + "\n");
console.log(`spec ${spec.info.version}: ${Object.keys(spec.paths).length} paths`);
```
Note: `openapiTS` accepts the YAML/JSON string directly in 7.x; if it rejects a string, pass `new URL(SPEC_URL)` instead.

`src/okta/spec-paths.ts`:
```ts
import specPaths from "./spec-paths.json";

const templates = (specPaths as string[]).map((p) => new RegExp("^" + p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "$"));

export function knownPath(path: string): boolean {
  const full = path.startsWith("/api/") || path.startsWith("/oauth2/") || path.startsWith("/.well-known/") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  return templates.some((re) => re.test(full));
}
```

- [ ] **Step 2: Run the generator**

Run: `bun run gen:types`
Expected: `spec 2026.08.4: 485 paths`; `src/okta/schema.d.ts` ≈ 2.3 MB. `bunx tsc -p .` stays green (the file is `skipLibCheck`-exempt because it is a `.d.ts` in `src`; if tsc chokes on time, add `"exclude": []` — measured 2 s on this machine).

- [ ] **Step 3: Write the tests**

`tests/spec-paths.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { knownPath } from "../src/okta/spec-paths";
import type { Schema } from "../src/okta/types";

describe("spec paths", () => {
  test("known and unknown", () => {
    expect(knownPath("/users")).toBe(true);
    expect(knownPath("/users/abc/lifecycle/deactivate")).toBe(true);
    expect(knownPath("/api/v1/groups/00g1/users/00u1")).toBe(true);
    expect(knownPath("/eventHooks")).toBe(true);
    expect(knownPath("/nope/at/all")).toBe(false);
  });
  test("schema types are usable", () => {
    const u: Schema<"User"> = { id: "x", profile: { login: "a@b" } } as Schema<"User">;
    expect(u.id).toBe("x");
  });
});
```

- [ ] **Step 4: Run, expect pass** — `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-types.ts src/okta/types.ts src/okta/schema.d.ts src/okta/spec-paths.json src/okta/spec-paths.ts tests/spec-paths.test.ts
git commit -m "feat: generate okta types and path list from pinned spec 2026.08.4"
```

---

### Task 17: Generic resource command builder

**Files:**
- Create: `src/commands/resource.ts`, `tests/resource.test.ts`

**Interfaces:**
- Consumes: `retrieve`, `getOne`, `selectField`, `parseBody`, `knownPath` (tests only).
- Produces:
  ```ts
  export interface ListOption { flags: string; param: string; description: string; required?: boolean; choices?: string[] }
  export interface ResourceSpec {
    name: string;            // CLI group name, e.g. "zones"
    description: string;
    path: string;            // API path under /api/v1, e.g. "/zones"
    singular: string;        // for messages, e.g. "network zone"
    nameField: string;       // dotted field for partial matching, e.g. "name"
    defaultFields: string;   // table columns
    lifecycle?: boolean;     // adds activate/deactivate → POST {path}/{id}/lifecycle/{verb}
    deletable?: boolean;     // default true
    replaceable?: boolean;   // default true → adds `replace <name-or-id> -b/-s` (PUT)
    creatable?: boolean;     // default true → adds `add -b/-s` (POST)
    listKey?: string;        // unwrap {key: [...]} list responses
    listOptions?: ListOption[]; // extra query flags for list/get/delete/activate/deactivate lookups
    sortBy?: string;         // dotted field to sort list output by (case-insensitive); default nameField
  }
  export function defineResource(parent: Command, ctx: Ctx, spec: ResourceSpec): Command
  export function resourceGet(client: OktaClient, spec: ResourceSpec, nameOrId: string, query?: Query): Promise<any>
  export function resourceList(client: OktaClient, spec: ResourceSpec, partial: string | undefined, query?: Query): Promise<any[]>
  export function lookupQuery(spec: ResourceSpec, opts: Record<string, any>): Query  // picks listOptions params out of opts
  ```
- Generated subcommands: `list [partial_name] -f/--filter <expr> -q/--query <q> [listOptions]` (out); `get <name-or-id> [listOptions]` (out); `add -b/--body <json> -s/--set k=v...` (out, POST `path`); `replace <name-or-id> -b -s [listOptions]` (out, PUT `path/{id}`; when `-s` given without `-b`, the existing object is fetched and merged, since Okta PUTs are full replacements); `delete <name-or-id> [listOptions]` → `"${singular} ${id} (${name}) deleted"`; `activate`/`deactivate <name-or-id> [listOptions]` (out, POST lifecycle; when the API returns 204 the message `"${singular} ${id} (${name}) ${verb}d"` is returned instead).
- Lookup semantic identical to `getOne`: id first, then partial case-insensitive match on `nameField`; uses `listKey`. `resourceGet` on `getAll` with `listKey` unwraps.

- [ ] **Step 1: Write failing tests**

`tests/resource.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { defineResource, type ResourceSpec } from "../src/commands/resource";
import { buildProgram } from "../src/cli/program";
import { knownPath } from "../src/okta/spec-paths";
import { ExitSentinel, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const spec: ResourceSpec = { name: "zones", description: "Network zones", path: "/zones", singular: "network zone", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "zone type" }] };
const zones = [{ id: "z2", status: "ACTIVE", type: "IP", name: "Office" }, { id: "z1", status: "ACTIVE", type: "DYNAMIC", name: "Blocked" }];
const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };

async function run(argv: string[], t: ReturnType<typeof testCtx>) {
  const p = buildProgram(t.ctx);
  defineResource(p, t.ctx, spec);
  try { await p.parseAsync(argv, { from: "user" }); return 0; } catch (e) { if (e instanceof ExitSentinel) return e.code; throw e; }
}

describe("defineResource", () => {
  test("spec path is a real okta path", () => expect(knownPath(spec.path)).toBe(true));

  test("list sorted with partial + extra query; get by id / name", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/zones\/[^/]+$/, handler: (_r, url) => url.pathname.endsWith("/z1") ? Response.json(zones[1]) : Response.json(notFound, { status: 404 }) },
      { method: "GET", path: "/api/v1/zones", body: zones },
    ]);
    const t = testCtx(srv.url);
    await run(["zones", "list", "-t", "IP"], t);
    expect(srv.calls[0]!.query).toEqual({ type: "IP" });
    expect(t.out.at(-1)).toBe("z1  ACTIVE  DYNAMIC  Blocked  \nz2  ACTIVE  IP       Office   \n");
    await run(["zones", "list", "off", "--output-fields", "id"], t);
    expect(t.out.at(-1)).toBe("z2  \n");
    await run(["zones", "get", "z1", "-j"], t);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("z1");
    await run(["zones", "get", "office", "--output-fields", "id"], t);
    expect(t.out.at(-1)).toBe("z2  \n");
    expect(await run(["zones", "get", "zzz"], t)).toBe(255);
  });

  test("add / replace merge / delete / activate / deactivate", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/zones/z2", body: zones[0] },
      { method: "GET", path: "/api/v1/zones", body: zones },
      { method: "POST", path: "/api/v1/zones", body: { id: "z9", name: "New" } },
      { method: "PUT", path: "/api/v1/zones/z2", body: { ...zones[0], name: "Renamed" } },
      { method: "DELETE", path: "/api/v1/zones/z2" },
      { method: "POST", path: "/api/v1/zones/z2/lifecycle/activate", body: { ...zones[0] } },
      { method: "POST", path: "/api/v1/zones/z2/lifecycle/deactivate" },
    ]);
    const t = testCtx(srv.url);
    await run(["zones", "add", "-b", '{"type":"IP"}', "-s", "name=New", "-j"], t);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "IP", name: "New" });
    await run(["zones", "replace", "z2", "-s", "name=Renamed"], t);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.body).toEqual({ ...zones[0], name: "Renamed" });
    await run(["zones", "delete", "office"], t);
    expect(t.out.at(-1)).toBe("network zone z2 (Office) deleted\n");
    await run(["zones", "activate", "z2", "--output-fields", "id"], t);
    expect(t.out.at(-1)).toBe("z2  \n");
    await run(["zones", "deactivate", "z2"], t);
    expect(t.out.at(-1)).toBe("network zone z2 (Office) deactivated\n");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

`src/commands/resource.ts`:
```ts
import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import { getDotted, isPlainObject, deepMerge } from "../lib/dotted";
import { selectField } from "../lib/lookup";
import type { OktaClient, Query } from "../okta/client";
import { ExitError, OktaApiError } from "../okta/errors";

export interface ListOption { flags: string; param: string; description: string; required?: boolean; choices?: string[] }
export interface ResourceSpec {
  name: string; description: string; path: string; singular: string; nameField: string; defaultFields: string;
  lifecycle?: boolean; deletable?: boolean; replaceable?: boolean; creatable?: boolean; listKey?: string; listOptions?: ListOption[]; sortBy?: string;
}

const optKey = (flags: string) => {
  const long = flags.split(",").map((s) => s.trim()).find((s) => s.startsWith("--"))!;
  return long.replace(/^--/, "").split(" ")[0]!.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
};

export function lookupQuery(spec: ResourceSpec, opts: Record<string, any>): Query {
  const q: Query = {};
  for (const lo of spec.listOptions ?? []) { const v = opts[optKey(lo.flags)]; if (v !== undefined) q[lo.param] = v; }
  return q;
}

function addListOptions(cmd: Command, spec: ResourceSpec): Command {
  for (const lo of spec.listOptions ?? []) {
    const o = new Option(lo.flags, lo.description);
    if (lo.choices) o.choices(lo.choices);
    if (lo.required) o.makeOptionMandatory();
    cmd.addOption(o);
  }
  return cmd;
}

const nameOf = (spec: ResourceSpec, item: any) => String(getDotted(item, spec.nameField) ?? "");

export async function resourceList(client: OktaClient, spec: ResourceSpec, partial: string | undefined, query: Query = {}): Promise<any[]> {
  let items: any[] = await client.getAll(spec.path, { query, listKey: spec.listKey });
  if (partial) items = items.filter(selectField(spec.nameField, partial));
  const key = spec.sortBy ?? spec.nameField;
  return items.sort((a, b) => String(getDotted(a, key) ?? "").toLowerCase().localeCompare(String(getDotted(b, key) ?? "").toLowerCase()));
}

export async function resourceGet(client: OktaClient, spec: ResourceSpec, nameOrId: string, query: Query = {}): Promise<any> {
  try { return await client.get(`${spec.path}/${encodeURIComponent(nameOrId)}`); }
  catch (e) { if (!(e instanceof OktaApiError)) throw e; }
  const matches = await resourceList(client, spec, nameOrId, query);
  if (matches.length > 1) throw new ExitError(`Name for ${spec.singular} must be unique. (found ${matches.length} matches).`);
  if (matches.length === 0) throw new ExitError(`No matching ${spec.singular} found.`);
  return matches[0];
}

export function defineResource(parent: Command, ctx: Ctx, spec: ResourceSpec): Command {
  const g = subgroup(parent, spec.name, spec.description);
  const out = (cmd: Command) => addOutputOptions(addVerbose(addListOptions(cmd, spec)), spec.defaultFields);

  out(g.command("list").description(`List ${spec.singular}s (optional argument: substring of ${spec.nameField})`).argument("[partial_name]")
    .option("-f, --filter <expr>", "Okta filter expression").option("-q, --query <q>", "Okta 'q' query"))
    .action(action(ctx, (client, opts, partial?: string) => {
      const query = lookupQuery(spec, opts);
      if (opts.filter) query.filter = opts.filter;
      if (opts.query) query.q = opts.query;
      return resourceList(client, spec, partial, query);
    }));

  out(g.command("get").description(`Get one ${spec.singular} by id or unique ${spec.nameField} substring`).argument("<name-or-id>"))
    .action(action(ctx, (client, opts, nameOrId) => resourceGet(client, spec, nameOrId, lookupQuery(spec, opts))));

  if (spec.creatable !== false) {
    out(g.command("add").description(`Create a ${spec.singular} from a JSON body (-b) and/or dotted assignments (-s)`)
      .option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []))
      .action(action(ctx, (client, opts) => {
        const body = parseBody(opts.body, opts.set);
        if (body === undefined) throw new ExitError("Provide -b and/or -s");
        return client.json("POST", spec.path, { body });
      }));
  }

  if (spec.replaceable !== false) {
    out(g.command("replace").description(`Replace (PUT) a ${spec.singular}; with only -s the current object is fetched and merged`).argument("<name-or-id>")
      .option("-b, --body <json>", "JSON body; FILE:<path> reads a file").option("-s, --set <k=v>", "set a (dotted) field", collect, []))
      .action(action(ctx, async (client, opts, nameOrId) => {
        const existing = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
        let body = parseBody(opts.body, opts.set);
        if (body === undefined) throw new ExitError("Provide -b and/or -s");
        if (!opts.body && isPlainObject(body)) body = deepMerge(existing, body);
        return client.json("PUT", `${spec.path}/${existing.id}`, { body });
      }));
  }

  if (spec.deletable !== false) {
    addVerbose(addListOptions(g.command("delete").description(`Delete a ${spec.singular}`).argument("<name-or-id>"), spec))
      .action(action(ctx, async (client, opts, nameOrId) => {
        const item = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
        await client.json("DELETE", `${spec.path}/${item.id}`);
        return `${spec.singular} ${item.id} (${nameOf(spec, item)}) deleted`;
      }));
  }

  if (spec.lifecycle) {
    for (const verb of ["activate", "deactivate"] as const) {
      out(g.command(verb).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} a ${spec.singular}`).argument("<name-or-id>"))
        .action(action(ctx, async (client, opts, nameOrId) => {
          const item = await resourceGet(client, spec, nameOrId, lookupQuery(spec, opts));
          const rv = await client.json("POST", `${spec.path}/${item.id}/lifecycle/${verb}`);
          return rv ?? `${spec.singular} ${item.id} (${nameOf(spec, item)}) ${verb}d`;
        }));
    }
  }
  return g;
}
```

- [ ] **Step 4: Run, expect pass** — `bun test tests/resource.test.ts` → 3 pass; `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/resource.ts tests/resource.test.ts
git commit -m "feat: generic resource command builder"
```

---

### Task 18: Platform admin — `logs`, `tokens`, `org`

**Files:**
- Create: `src/commands/logs.ts`, `src/commands/tokens.ts`, `src/commands/org.ts`, `tests/commands-platform-admin.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Consumes: `defineResource`, `getUser`, `parseBody`, `knownPath` (tests).
- Produces: `registerLogs`, `registerTokens`, `registerOrg` (each `(program, ctx)`).

Commands:
- `logs list --since <iso> --until <iso> -f/--filter <expr> -q/--query <q> --sort-order ASCENDING|DESCENDING (default ASCENDING) -l/--limit <n> (page size, default 1000, max 1000) --max <n> (total cap, default 1000; 0 = unlimited)` (out, fields `published,eventType,outcome.result,actor.alternateId,client.ipAddress,displayMessage`). GET `/logs` with `since, until, filter, q, sortOrder, limit`; pagination via `getAll` with `max` (the `/logs` endpoint always returns a `next` link, so the empty-page stop in `getAll` is what terminates).
- `tokens` via `defineResource`: `{ name: "tokens", description: "API token operations", path: "/api-tokens", singular: "API token", nameField: "name", defaultFields: "id,name,userId,created,expiresAt,tokenWindow", creatable: false, replaceable: false, deletable: false }` plus `revoke <name-or-id>` (DELETE `/api-tokens/{id}` → `API token {id} ({name}) revoked`) and `revoke-current` (DELETE `/api-tokens/current` → `current API token revoked`).
- `org get` (out, fields `id,companyName,subdomain,status,website`) GET `/org`; `org update -s k=v... [-b json]` (out, same fields) POST `/org`; `org contacts` (out, fields `contactType`) GET `/org/contacts`; `org contact <type>` (out, fields `userId`) GET `/org/contacts/{type}`; `org set-contact <type> -u/--user <user> [-f field]` PUT `/org/contacts/{type}` `{userId}` → returns response; `org support` (out, fields `support,expiration`) GET `/org/privacy/oktaSupport`; `org support-grant`, `org support-extend`, `org support-revoke` (out, same fields) POST `/org/privacy/oktaSupport/{grant|extend|revoke}`.

- [ ] **Step 1: Write failing tests**

`tests/commands-platform-admin.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("paths exist in spec", () => {
  for (const p of ["/logs", "/api-tokens", "/api-tokens/current", "/api-tokens/x", "/org", "/org/contacts", "/org/contacts/BILLING", "/org/privacy/oktaSupport", "/org/privacy/oktaSupport/grant", "/org/privacy/oktaSupport/extend", "/org/privacy/oktaSupport/revoke"]) expect(knownPath(p), p).toBe(true);
});

describe("logs", () => {
  test("list passes params and stops on empty page / max", async () => {
    let page = 0;
    srv = startServer([{ method: "GET", path: "/api/v1/logs", handler: (_r, url) => {
      page++;
      const body = page <= 2 ? [{ uuid: `e${page}`, published: "p", eventType: "user.session.start", outcome: { result: "SUCCESS" }, actor: { alternateId: "a" }, client: { ipAddress: "1.1.1.1" }, displayMessage: "m" }] : [];
      return Response.json(body, { headers: { Link: `<${url.origin}/api/v1/logs?after=${page}>; rel="next"` } });
    } }]);
    const t = testCtx(srv.url);
    await runTest(["logs", "list", "--since", "2026-01-01T00:00:00Z", "-f", 'eventType eq "user.session.start"', "--sort-order", "DESCENDING", "-l", "50", "--output-fields", "uuid"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ since: "2026-01-01T00:00:00Z", filter: 'eventType eq "user.session.start"', sortOrder: "DESCENDING", limit: "50" });
    expect(t.out.at(-1)).toBe("e1  \ne2  \n");
    expect(srv.calls.length).toBe(3);
    page = 0; srv.calls.length = 0;
    await runTest(["logs", "list", "--max", "1", "--output-fields", "uuid"], t.ctx);
    expect(t.out.at(-1)).toBe("e1  \n");
    expect(srv.calls.length).toBe(1);
  });
});

describe("tokens", () => {
  test("list/get/revoke/revoke-current", async () => {
    const toks = [{ id: "t1", name: "ci", userId: "u", created: "c", expiresAt: "e", tokenWindow: "P30D" }];
    srv = startServer([
      { method: "GET", path: "/api/v1/api-tokens", body: toks },
      { method: "GET", path: "/api/v1/api-tokens/t1", body: toks[0] },
      { method: "GET", path: /^\/api\/v1\/api-tokens\/.+/, status: 404, body: { errorSummary: "nf" } },
      { method: "DELETE", path: /^\/api\/v1\/api-tokens\/.+/ },
    ]);
    const t = testCtx(srv.url);
    await runTest(["tokens", "list", "--output-fields", "id,name"], t.ctx);
    expect(t.out.at(-1)).toBe("t1  ci  \n");
    await runTest(["tokens", "revoke", "ci"], t.ctx);
    expect(t.out.at(-1)).toBe("API token t1 (ci) revoked\n");
    await runTest(["tokens", "revoke-current"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/api-tokens/current");
    expect(t.out.at(-1)).toBe("current API token revoked\n");
  });
});

describe("org", () => {
  test("get/update/contacts/set-contact/support", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/org", body: { id: "o", companyName: "Acme", subdomain: "acme", status: "ACTIVE", website: "w" } },
      { method: "POST", path: "/api/v1/org", body: { id: "o", companyName: "Acme2" } },
      { method: "GET", path: "/api/v1/org/contacts", body: [{ contactType: "BILLING" }, { contactType: "TECHNICAL" }] },
      { method: "GET", path: "/api/v1/org/contacts/BILLING", body: { userId: "00u00000000000000001" } },
      { method: "PUT", path: "/api/v1/org/contacts/TECHNICAL", body: { userId: "00u00000000000000002" } },
      { method: "GET", path: "/api/v1/org/privacy/oktaSupport", body: { support: "DISABLED", expiration: null } },
      { method: "POST", path: /^\/api\/v1\/org\/privacy\/oktaSupport\/(grant|extend|revoke)$/, body: { support: "ENABLED", expiration: "x" } },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["org", "get", "--output-fields", "companyName"], t.ctx);
    expect(t.out.at(-1)).toBe("Acme  \n");
    await runTest(["org", "update", "-s", "companyName=Acme2", "-s", "website=https://acme.example"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ companyName: "Acme2", website: "https://acme.example" });
    await runTest(["org", "contacts"], t.ctx);
    expect(t.out.at(-1)).toBe("BILLING    \nTECHNICAL  \n");
    await runTest(["org", "contact", "BILLING", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!).userId).toBe("00u00000000000000001");
    await runTest(["org", "set-contact", "TECHNICAL", "-u", "alice@x.com", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ userId: "00u00000000000000002" });
    await runTest(["org", "support"], t.ctx);
    expect(t.out.at(-1)).toBe("DISABLED    \n");
    await runTest(["org", "support-grant", "--output-fields", "support"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/org/privacy/oktaSupport/grant");
    expect(t.out.at(-1)).toBe("ENABLED  \n");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

`src/commands/logs.ts`:
```ts
import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, int, subgroup } from "../cli/options";

export const LOG_FIELDS = "published,eventType,outcome.result,actor.alternateId,client.ipAddress,displayMessage";

export function registerLogs(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "logs", "System log operations");
  addOutputOptions(addVerbose(g.command("list").description("Query the System Log (GET /logs)")
    .option("--since <iso8601>", "Events after this timestamp")
    .option("--until <iso8601>", "Events before this timestamp")
    .option("-f, --filter <expr>", 'SCIM filter, e.g. eventType eq "user.session.start"')
    .option("-q, --query <q>", "Keyword search")
    .addOption(new Option("--sort-order <order>", "sort order").choices(["ASCENDING", "DESCENDING"]).default("ASCENDING"))
    .option("-l, --limit <n>", "page size (max 1000)", int, 1000)
    .option("--max <n>", "stop after this many events in total (0 = unlimited)", int, 1000)), LOG_FIELDS)
    .action(action(ctx, (client, opts) => client.getAll("/logs", {
      query: { since: opts.since, until: opts.until, filter: opts.filter, q: opts.query, sortOrder: opts.sortOrder, limit: Math.min(1000, opts.limit) },
      max: opts.max > 0 ? opts.max : undefined,
    })));
}
```

`src/commands/tokens.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addVerbose } from "../cli/options";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const TOKENS: ResourceSpec = { name: "tokens", description: "API token operations", path: "/api-tokens", singular: "API token", nameField: "name",
  defaultFields: "id,name,userId,created,expiresAt,tokenWindow", creatable: false, replaceable: false, deletable: false };

export function registerTokens(program: Command, ctx: Ctx): void {
  const g = defineResource(program, ctx, TOKENS);
  addVerbose(g.command("revoke").description("Revoke an API token").argument("<name-or-id>"))
    .action(action(ctx, async (client, _o, nameOrId) => {
      const tok = await resourceGet(client, TOKENS, nameOrId);
      await client.json("DELETE", `/api-tokens/${tok.id}`);
      return `API token ${tok.id} (${tok.name}) revoked`;
    }));
  addVerbose(g.command("revoke-current").description("Revoke the API token used for this request"))
    .action(action(ctx, async (client) => { await client.json("DELETE", "/api-tokens/current"); return "current API token revoked"; }));
}
```

`src/commands/org.ts`:
```ts
import type { Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect, subgroup } from "../cli/options";
import { parseBody } from "../lib/body";
import { getUser } from "../lib/lookup";
import { ExitError } from "../okta/errors";

const ORG_FIELDS = "id,companyName,subdomain,status,website";
const SUPPORT_FIELDS = "support,expiration";

export function registerOrg(program: Command, ctx: Ctx): void {
  const g = subgroup(program, "org", "Org settings");
  addOutputOptions(addVerbose(g.command("get").description("Show org settings")), ORG_FIELDS).action(action(ctx, (client) => client.get("/org")));
  addOutputOptions(addVerbose(g.command("update").description("Partially update org settings (POST /org)")
    .option("-b, --body <json>", "JSON body").option("-s, --set <k=v>", "set a field", collect, [])), ORG_FIELDS)
    .action(action(ctx, (client, opts) => {
      const body = parseBody(opts.body, opts.set);
      if (body === undefined) throw new ExitError("Provide -b and/or -s");
      return client.json("POST", "/org", { body });
    }));
  addOutputOptions(addVerbose(g.command("contacts").description("List org contact types")), "contactType").action(action(ctx, (client) => client.getAll("/org/contacts")));
  addOutputOptions(addVerbose(g.command("contact").description("Show the user for a contact type (BILLING, TECHNICAL)").argument("<type>")), "userId")
    .action(action(ctx, (client, _o, type) => client.get(`/org/contacts/${type}`)));
  addOutputOptions(addVerbose(g.command("set-contact").description("Set the user for a contact type").argument("<type>")
    .requiredOption("-u, --user <user>", "user id or lookup value").option("-f, --user-lookup-field <field>", "profile field to match", "login")), "userId")
    .action(action(ctx, async (client, opts, type) => {
      const u = await getUser(client, opts.user, opts.userLookupField);
      return client.json("PUT", `/org/contacts/${type}`, { body: { userId: u.id } });
    }));
  addOutputOptions(addVerbose(g.command("support").description("Show Okta Support access setting")), SUPPORT_FIELDS).action(action(ctx, (client) => client.get("/org/privacy/oktaSupport")));
  for (const verb of ["grant", "extend", "revoke"] as const) {
    addOutputOptions(addVerbose(g.command(`support-${verb}`).description(`${verb[0]!.toUpperCase()}${verb.slice(1)} Okta Support access`)), SUPPORT_FIELDS)
      .action(action(ctx, (client) => client.json("POST", `/org/privacy/oktaSupport/${verb}`)));
  }
}
```

Register the three in program.

- [ ] **Step 4: Run, expect pass** — `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/logs.ts src/commands/tokens.ts src/commands/org.ts src/cli/program.ts tests/commands-platform-admin.test.ts
git commit -m "feat: logs, tokens, org commands"
```

---

### Task 19: Platform admin — `roles` and role assignments on users/groups

**Files:**
- Create: `src/commands/roles.ts`, `tests/commands-roles.test.ts`
- Modify: `src/cli/program.ts` (pass the `users` and `groups` group commands into `registerRoles(program, ctx, { users, groups })`; make `registerGroups` return its `Command` like `registerUsers` does)

**Interfaces:**
- Produces: `registerRoles(program: Command, ctx: Ctx, groups: { users: Command; groups: Command }): void`; `roleAssignmentBody(opts: { type: string; role?: string; resourceSet?: string }): Record<string, unknown>` → `{ type }` for standard roles; `{ type: "CUSTOM", role, "resource-set": resourceSet }` when `type === "CUSTOM"` (both required else `ExitError("CUSTOM roles need --role and --resource-set")`).

Commands:
- `roles list [partial]` via `defineResource` `{ name: "roles", description: "Admin roles (custom roles, resource sets, assignees)", path: "/iam/roles", singular: "custom role", nameField: "label", defaultFields: "id,label,description", lifecycle: false }` (Okta returns `{ roles: [...] }` → `listKey: "roles"`; `add`/`replace`/`delete` come free).
- `roles assignees` (out, fields `id,orgId,status,created,lastUpdated`) GET `/iam/assignees/users`, listKey `value`.
- `roles resource-sets [partial]` (out, fields `id,label,description`) GET `/iam/resource-sets`, listKey `resource-sets`.
- `users roles <user> [-f]` (out, fields `id,type,label,status,assignmentType,resource-set`) GET `/users/{id}/roles`.
- `users assign-role <user> -t/--type <ROLE_TYPE> [--role <id-or-label>] [--resource-set <id>] [-f]` (out, same fields) POST `/users/{id}/roles`.
- `users unassign-role <user> <assignment-id> [-f]` DELETE → `role assignment {rid} removed from user {uid} ({login})`.
- `groups roles <group>`, `groups assign-role <group> -t ...`, `groups unassign-role <group> <assignment-id>` — same against `/groups/{id}/roles`, message `... removed from group {gid} ({name})`.
- ROLE_TYPE choices: `SUPER_ADMIN, ORG_ADMIN, APP_ADMIN, USER_ADMIN, HELP_DESK_ADMIN, READ_ONLY_ADMIN, MOBILE_ADMIN, API_ACCESS_MANAGEMENT_ADMIN, REPORT_ADMIN, GROUP_MEMBERSHIP_ADMIN, ACCESS_CERTIFICATIONS_ADMIN, ACCESS_REQUESTS_ADMIN, CUSTOM`.

- [ ] **Step 1: Write failing tests**

`tests/commands-roles.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { roleAssignmentBody } from "../src/commands/roles";
import { knownPath } from "../src/okta/spec-paths";
import { standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("paths exist", () => {
  for (const p of ["/iam/roles", "/iam/assignees/users", "/iam/resource-sets", "/users/u/roles", "/users/u/roles/r", "/groups/g/roles", "/groups/g/roles/r"]) expect(knownPath(p), p).toBe(true);
});

test("roleAssignmentBody", () => {
  expect(roleAssignmentBody({ type: "APP_ADMIN" })).toEqual({ type: "APP_ADMIN" });
  expect(roleAssignmentBody({ type: "CUSTOM", role: "cr1", resourceSet: "rs1" })).toEqual({ type: "CUSTOM", role: "cr1", "resource-set": "rs1" });
  expect(() => roleAssignmentBody({ type: "CUSTOM" })).toThrow("CUSTOM roles need --role and --resource-set");
});

describe("roles", () => {
  test("custom roles list unwraps, assignees, resource-sets", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/iam/roles", body: { roles: [{ id: "cr1", label: "Zebra", description: "d" }, { id: "cr2", label: "Alpha", description: "d" }] } },
      { method: "GET", path: "/api/v1/iam/assignees/users", body: { value: [{ id: "00u1", orgId: "o", status: "ACTIVE" }] } },
      { method: "GET", path: "/api/v1/iam/resource-sets", body: { "resource-sets": [{ id: "rs1", label: "All apps" }] } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["roles", "list", "--output-fields", "label"], t.ctx);
    expect(t.out.at(-1)).toBe("Alpha  \nZebra  \n");
    await runTest(["roles", "assignees", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("00u1  \n");
    await runTest(["roles", "resource-sets", "--output-fields", "id"], t.ctx);
    expect(t.out.at(-1)).toBe("rs1  \n");
  });

  test("user and group role assignment", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/roles", body: [{ id: "ra1", type: "APP_ADMIN", label: "Application Administrator", status: "ACTIVE", assignmentType: "USER" }] },
      { method: "POST", path: "/api/v1/users/00u00000000000000001/roles", body: { id: "ra2", type: "READ_ONLY_ADMIN" } },
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/roles/ra1" },
      { method: "GET", path: "/api/v1/groups/00g1/roles", body: [] },
      { method: "POST", path: "/api/v1/groups/00g1/roles", body: { id: "ra3", type: "CUSTOM" } },
      { method: "DELETE", path: "/api/v1/groups/00g1/roles/ra3" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "roles", "bob@x.com", "--output-fields", "id,type"], t.ctx);
    expect(t.out.at(-1)).toBe("ra1  APP_ADMIN  \n");
    await runTest(["users", "assign-role", "bob@x.com", "-t", "READ_ONLY_ADMIN", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "READ_ONLY_ADMIN" });
    await runTest(["users", "unassign-role", "bob@x.com", "ra1"], t.ctx);
    expect(t.out.at(-1)).toBe("role assignment ra1 removed from user 00u00000000000000001 (bob@x.com)\n");
    await runTest(["groups", "roles", "engineering"], t.ctx);
    expect(t.out.at(-1)).toBe("[]\n");
    await runTest(["groups", "assign-role", "engineering", "-t", "CUSTOM", "--role", "cr1", "--resource-set", "rs1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "CUSTOM", role: "cr1", "resource-set": "rs1" });
    await runTest(["groups", "unassign-role", "00g1", "ra3"], t.ctx);
    expect(t.out.at(-1)).toBe("role assignment ra3 removed from group 00g1 (Engineering)\n");
    expect(await runTest(["users", "assign-role", "bob@x.com", "-t", "NOT_A_ROLE"], t.ctx)).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

`src/commands/roles.ts`:
```ts
import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose } from "../cli/options";
import { getGroup, getUser } from "../lib/lookup";
import type { OktaClient } from "../okta/client";
import { ExitError } from "../okta/errors";
import { defineResource, type ResourceSpec } from "./resource";

export const ROLE_TYPES = ["SUPER_ADMIN", "ORG_ADMIN", "APP_ADMIN", "USER_ADMIN", "HELP_DESK_ADMIN", "READ_ONLY_ADMIN", "MOBILE_ADMIN", "API_ACCESS_MANAGEMENT_ADMIN", "REPORT_ADMIN", "GROUP_MEMBERSHIP_ADMIN", "ACCESS_CERTIFICATIONS_ADMIN", "ACCESS_REQUESTS_ADMIN", "CUSTOM"];
const ASSIGNMENT_FIELDS = "id,type,label,status,assignmentType,resource-set";

export const CUSTOM_ROLES: ResourceSpec = { name: "roles", description: "Admin roles: custom roles, resource sets, assignees", path: "/iam/roles", singular: "custom role", nameField: "label", defaultFields: "id,label,description", listKey: "roles" };

export function roleAssignmentBody(opts: { type: string; role?: string; resourceSet?: string }): Record<string, unknown> {
  if (opts.type !== "CUSTOM") return { type: opts.type };
  if (!opts.role || !opts.resourceSet) throw new ExitError("CUSTOM roles need --role and --resource-set");
  return { type: "CUSTOM", role: opts.role, "resource-set": opts.resourceSet };
}

type Resolver = (client: OktaClient, value: string, field?: string) => Promise<any>;

function attachAssignments(parent: Command, ctx: Ctx, kind: "user" | "group", resolve: Resolver, nameOf: (x: any) => string) {
  const base = kind === "user" ? "users" : "groups";
  const lookupOpt = (cmd: Command) => kind === "user" ? cmd.option("-f, --user-lookup-field <field>", "profile field to match", "login") : cmd;
  addOutputOptions(addVerbose(lookupOpt(parent.command("roles").description(`List admin role assignments of a ${kind}`).argument(`<${kind}>`))), ASSIGNMENT_FIELDS)
    .action(action(ctx, async (client, opts, who) => client.getAll(`/${base}/${(await resolve(client, who, opts.userLookupField)).id}/roles`)));
  addOutputOptions(addVerbose(lookupOpt(parent.command("assign-role").description(`Assign an admin role to a ${kind}`).argument(`<${kind}>`)
    .addOption(new Option("-t, --type <ROLE_TYPE>", "role type").choices(ROLE_TYPES).makeOptionMandatory())
    .option("--role <id-or-label>", "custom role (with -t CUSTOM)").option("--resource-set <id>", "resource set (with -t CUSTOM)"))), ASSIGNMENT_FIELDS)
    .action(action(ctx, async (client, opts, who) => client.json("POST", `/${base}/${(await resolve(client, who, opts.userLookupField)).id}/roles`, { body: roleAssignmentBody(opts) })));
  addVerbose(lookupOpt(parent.command("unassign-role").description(`Remove an admin role assignment from a ${kind}`).argument(`<${kind}>`).argument("<assignment-id>")))
    .action(action(ctx, async (client, opts, who, rid) => {
      const target = await resolve(client, who, opts.userLookupField);
      await client.json("DELETE", `/${base}/${target.id}/roles/${rid}`);
      return `role assignment ${rid} removed from ${kind} ${target.id} (${nameOf(target)})`;
    }));
}

export function registerRoles(program: Command, ctx: Ctx, groups: { users: Command; groups: Command }): void {
  const g = defineResource(program, ctx, CUSTOM_ROLES);
  addOutputOptions(addVerbose(g.command("assignees").description("List users that have admin role assignments")), "id,orgId,status,created,lastUpdated")
    .action(action(ctx, (client) => client.getAll("/iam/assignees/users", { listKey: "value" })));
  addOutputOptions(addVerbose(g.command("resource-sets").description("List resource sets").argument("[partial]")), "id,label,description")
    .action(action(ctx, async (client, _o, partial?: string) => {
      const all: any[] = await client.getAll("/iam/resource-sets", { listKey: "resource-sets" });
      return partial ? all.filter((r) => String(r.label).toLowerCase().includes(partial.toLowerCase())) : all;
    }));
  attachAssignments(groups.users, ctx, "user", (c, v, f) => getUser(c, v, f), (u) => u.profile.login);
  attachAssignments(groups.groups, ctx, "group", (c, v) => getGroup(c, v), (g) => g.profile.name);
}
```

In `src/cli/program.ts`: `const usersCmd = registerUsers(program, ctx); const groupsCmd = registerGroups(program, ctx); ... registerRoles(program, ctx, { users: usersCmd, groups: groupsCmd });` (`registerGroups` now returns `g`).

- [ ] **Step 4: Run, expect pass** — `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/roles.ts src/commands/groups.ts src/cli/program.ts tests/commands-roles.test.ts
git commit -m "feat: admin roles and role assignments"
```

---

### Task 20: Platform admin — `trusted-origins`, `domains`, `zones`, `log-streams`

**Files:**
- Create: `src/commands/platform.ts`, `tests/commands-platform.test.ts`
- Modify: `src/cli/program.ts`

**Interfaces:**
- Produces: `registerPlatform(program, ctx)` and exported specs `TRUSTED_ORIGINS`, `DOMAINS`, `ZONES`, `LOG_STREAMS`.

Descriptors:
```ts
export const TRUSTED_ORIGINS: ResourceSpec = { name: "trusted-origins", description: "Trusted origins (CORS / redirect)", path: "/trustedOrigins", singular: "trusted origin", nameField: "name", defaultFields: "id,status,name,origin", lifecycle: true };
export const DOMAINS: ResourceSpec = { name: "domains", description: "Custom domains", path: "/domains", singular: "custom domain", nameField: "domain", defaultFields: "id,domain,validationStatus,certificateSourceType", listKey: "domains", replaceable: false };
export const ZONES: ResourceSpec = { name: "zones", description: "Network zones", path: "/zones", singular: "network zone", nameField: "name", defaultFields: "id,status,type,usage,name", lifecycle: true };
export const LOG_STREAMS: ResourceSpec = { name: "log-streams", description: "Log streams", path: "/logStreams", singular: "log stream", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true, listOptions: [{ flags: "-t, --type <type>", param: "filter", description: "log stream type (aws_eventbridge, splunk_cloud_logstreaming)" }] };
```
Note `LOG_STREAMS` type flag maps to the `filter` param; the handler must turn the value `X` into `type eq "X"`. Implement this by giving `ListOption` an optional `transform?: (v: string) => string` field (add to `resource.ts`, applied in `lookupQuery`).

Extra subcommands:
- `trusted-origins add -n/--name <name> -o/--origin <url> --scope <CORS|REDIRECT|IFRAME_EMBED>...` (collect; default `["CORS","REDIRECT"]`) → POST body `{ name, origin, scopes: scopes.map(type => ({ type })) }`. This **replaces** the generic `add` for this resource: set `creatable: false` in the spec and define `add` manually.
- `domains add -d/--domain <fqdn> [--cert-source MANUAL|OKTA_MANAGED (default OKTA_MANAGED)]` → POST `{ domain, certificateSourceType }` (`creatable: false` + manual add); `domains verify <domain-or-id>` (out) → POST `/domains/{id}/verify`.
- `zones` and `log-streams`: generic only.

- [ ] **Step 1: Write failing tests**

`tests/commands-platform.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { DOMAINS, LOG_STREAMS, TRUSTED_ORIGINS, ZONES } from "../src/commands/platform";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

test("spec paths", () => {
  for (const s of [TRUSTED_ORIGINS, DOMAINS, ZONES, LOG_STREAMS]) {
    expect(knownPath(s.path), s.path).toBe(true);
    expect(knownPath(`${s.path}/x`), s.path).toBe(true);
    if (s.lifecycle) expect(knownPath(`${s.path}/x/lifecycle/activate`), s.path).toBe(true);
  }
  expect(knownPath("/domains/x/verify")).toBe(true);
});

describe("platform resources", () => {
  test("trusted-origins add builds scopes", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/trustedOrigins", body: { id: "tos1", status: "ACTIVE", name: "app", origin: "https://app" } }]);
    const t = testCtx(srv.url);
    await runTest(["trusted-origins", "add", "-n", "app", "-o", "https://app", "--scope", "CORS"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ name: "app", origin: "https://app", scopes: [{ type: "CORS" }] });
    expect(t.out.at(-1)).toBe("tos1  ACTIVE  app  https://app  \n");
    await runTest(["trusted-origins", "add", "-n", "b", "-o", "https://b"], t.ctx);
    expect((srv.calls[1]!.body as any).scopes).toEqual([{ type: "CORS" }, { type: "REDIRECT" }]);
  });
  test("domains list unwraps, add, verify", async () => {
    const d = { id: "d1", domain: "login.acme.com", validationStatus: "NOT_STARTED", certificateSourceType: "OKTA_MANAGED" };
    srv = startServer([
      { method: "GET", path: "/api/v1/domains", body: { domains: [d] } },
      { method: "GET", path: /^\/api\/v1\/domains\/[^/]+$/, status: 404, body: { errorSummary: "nf" } },
      { method: "POST", path: "/api/v1/domains", body: d },
      { method: "POST", path: "/api/v1/domains/d1/verify", body: { ...d, validationStatus: "VERIFIED" } },
    ]);
    const t = testCtx(srv.url);
    await runTest(["domains", "list", "--output-fields", "domain"], t.ctx);
    expect(t.out.at(-1)).toBe("login.acme.com  \n");
    await runTest(["domains", "add", "-d", "login.acme.com"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ domain: "login.acme.com", certificateSourceType: "OKTA_MANAGED" });
    await runTest(["domains", "verify", "acme", "--output-fields", "validationStatus"], t.ctx);
    expect(t.out.at(-1)).toBe("VERIFIED  \n");
  });
  test("log-streams -t becomes filter", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/logStreams", body: [] }]);
    const t = testCtx(srv.url);
    await runTest(["log-streams", "list", "-t", "splunk_cloud_logstreaming"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ filter: 'type eq "splunk_cloud_logstreaming"' });
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

In `src/commands/resource.ts` extend `ListOption` with `transform?: (v: string) => string` and in `lookupQuery` use `q[lo.param] = lo.transform ? lo.transform(String(v)) : v`.

`src/commands/platform.ts`:
```ts
import { Option, type Command } from "commander";
import type { Ctx } from "../cli/context";
import { action, addOutputOptions, addVerbose, collect } from "../cli/options";
import { defineResource, resourceGet, type ResourceSpec } from "./resource";

export const TRUSTED_ORIGINS: ResourceSpec = { name: "trusted-origins", description: "Trusted origins (CORS / redirect)", path: "/trustedOrigins", singular: "trusted origin", nameField: "name", defaultFields: "id,status,name,origin", lifecycle: true, creatable: false };
export const DOMAINS: ResourceSpec = { name: "domains", description: "Custom domains", path: "/domains", singular: "custom domain", nameField: "domain", defaultFields: "id,domain,validationStatus,certificateSourceType", listKey: "domains", replaceable: false, creatable: false };
export const ZONES: ResourceSpec = { name: "zones", description: "Network zones", path: "/zones", singular: "network zone", nameField: "name", defaultFields: "id,status,type,usage,name", lifecycle: true };
export const LOG_STREAMS: ResourceSpec = { name: "log-streams", description: "Log streams", path: "/logStreams", singular: "log stream", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
  listOptions: [{ flags: "-t, --type <type>", param: "filter", description: "log stream type (aws_eventbridge, splunk_cloud_logstreaming)", transform: (v) => `type eq "${v}"` }] };

export function registerPlatform(program: Command, ctx: Ctx): void {
  const to = defineResource(program, ctx, TRUSTED_ORIGINS);
  addOutputOptions(addVerbose(to.command("add").description("Create a trusted origin")
    .requiredOption("-n, --name <name>").requiredOption("-o, --origin <url>")
    .addOption(new Option("--scope <scope>", "scope type, repeatable (default: CORS + REDIRECT)").choices(["CORS", "REDIRECT", "IFRAME_EMBED"]).argParser(collect).default([]))), TRUSTED_ORIGINS.defaultFields)
    .action(action(ctx, (client, opts) => {
      const scopes: string[] = opts.scope.length ? opts.scope : ["CORS", "REDIRECT"];
      return client.json("POST", "/trustedOrigins", { body: { name: opts.name, origin: opts.origin, scopes: scopes.map((type) => ({ type })) } });
    }));

  const dm = defineResource(program, ctx, DOMAINS);
  addOutputOptions(addVerbose(dm.command("add").description("Create a custom domain").requiredOption("-d, --domain <fqdn>")
    .addOption(new Option("--cert-source <type>", "certificate source").choices(["MANUAL", "OKTA_MANAGED"]).default("OKTA_MANAGED"))), DOMAINS.defaultFields)
    .action(action(ctx, (client, opts) => client.json("POST", "/domains", { body: { domain: opts.domain, certificateSourceType: opts.certSource } })));
  addOutputOptions(addVerbose(dm.command("verify").description("Trigger DNS verification of a custom domain").argument("<domain-or-id>")), DOMAINS.defaultFields)
    .action(action(ctx, async (client, _o, d) => client.json("POST", `/domains/${(await resourceGet(client, DOMAINS, d)).id}/verify`)));

  defineResource(program, ctx, ZONES);
  defineResource(program, ctx, LOG_STREAMS);
}
```

Register in program.

- [ ] **Step 4: Run, expect pass** — `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/platform.ts src/commands/resource.ts src/cli/program.ts tests/commands-platform.test.ts
git commit -m "feat: trusted-origins, domains, zones, log-streams"
```

---

## Tasks 21–28: compact specs

The pattern is now fixed. For each task below: write the test file first (every listed assertion), run it to see it fail, implement, run `bun run check`, commit with the given message. Every test file starts with a `knownPath()` assertion for every path the module uses (including `{id}` sub-paths). All commands get `addVerbose`; commands marked (out) get `addOutputOptions` with the listed fields. Lookup of `<name-or-id>` is always `resourceGet` (id, then unique substring on `nameField`). Extra subcommands attach to the `Command` returned by `defineResource`. Bodies built from flags use `client.json`. Register every module in `src/cli/program.ts`.

### Task 21: Automation — `inlinehooks`, `hook-keys` (`src/commands/inlinehooks.ts`, `tests/commands-inlinehooks.test.ts`, commit `feat: inline hooks and hook keys`)

```ts
export const INLINE_HOOKS: ResourceSpec = { name: "inlinehooks", description: "Inline hook operations", path: "/inlineHooks", singular: "inline hook", nameField: "name", defaultFields: "id,status,type,version,name", lifecycle: true, creatable: false,
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "inline hook type, e.g. com.okta.oauth2.tokens.transform" }] };
export const HOOK_KEYS: ResourceSpec = { name: "hook-keys", description: "Hook keys (OAuth 2.0 client credentials for hooks)", path: "/hook-keys", singular: "hook key", nameField: "name", defaultFields: "id,name,keyId,created,lastUpdated", creatable: false };
```
- `inlinehooks add -n/--name -t/--type <type> -u/--url <uri> [--version 1.0.0] [--auth-header <key>] [--auth-value <secret>] [--method POST]` (out) → POST `/inlineHooks` body `{ name, type, version, channel: { type: "HTTP", version: "1.0.0", config: { uri, method, headers: [], authScheme?: { type: "HEADER", key, value } } } }` (authScheme only when both auth flags given; `version` default `1.0.0`; `method` default `POST`).
- `inlinehooks execute <name-or-id> -b <json>` (out, fields none) → POST `/inlineHooks/{id}/execute` with `parseBody(opts.body)`.
- `hook-keys add -n/--name <name>` (out) → POST `/hook-keys` `{ name }`; `hook-keys public <keyId>` (out, fields none) → GET `/hook-keys/public/{keyId}`.
- Tests: list with `-t` passes `type` query; `add` body shape with and without authScheme; `execute` posts the body to the right path; `hook-keys add` body; `hook-keys public` path.

### Task 22: Automation — `schemas`, `linked-objects` (`src/commands/schemas.ts`, `tests/commands-schemas.test.ts`, commit `feat: schemas and linked objects`)

`schemas` group (`subgroup(program, "schemas", "Profile schemas (user, group, app)")`):
- `schemas user get [schemaId=default]` (out, fields none) → GET `/meta/schemas/user/{schemaId}`.
- `schemas user properties [schemaId=default]` (out, fields `name,scope,type,title,required,mutability`) → flatten `definitions.base.properties` (scope `base`) and `definitions.custom.properties` (scope `custom`) into rows `{ name, scope, type, title, required: !!p.required, mutability, ...rest }` sorted by scope then name. Export `flattenSchemaProperties(schema: any): any[]`.
- `schemas user add-property -n/--name <name> [-t/--type string|boolean|integer|number|array (default string)] [--title <t>] [--description <d>] [--required] [--min-length <n>] [--max-length <n>] [--enum a,b,c] [--items-type string] [--schema-id default] [--mutability READ_WRITE|READ_ONLY (default READ_WRITE)] [--permissions SELF:READ_WRITE (default SELF:READ_WRITE)]` (out, same fields as `properties`, returns the flattened rows of the response) → POST `/meta/schemas/user/{schemaId}` body `{ definitions: { custom: { id: "#custom", type: "object", properties: { [name]: prop } } } }` where `prop = { title: title ?? name, description, type, required, mutability, scope: "NONE", permissions: [{ principal, action }], minLength, maxLength, enum: enum?.split(","), oneOf: enum?.map(v => ({ const: v, title: v })), items: type === "array" ? { type: itemsType } : undefined }` with `undefined` keys removed. Export `schemaPropertyBody(opts): Record<string, unknown>`.
- `schemas user remove-property -n/--name <name> [--schema-id default]` → POST same path with `{ definitions: { custom: { id: "#custom", type: "object", properties: { [name]: null } } } }` → returns `custom property {name} removed from schema {schemaId}`.
- `schemas group get` (out, none) → GET `/meta/schemas/group/default`; `schemas group properties` → same flattening.
- `schemas app get <app>` (out, none) → `getApp` then GET `/meta/schemas/apps/{appId}/default`; `schemas app properties <app>`.
- `linked-objects` via defineResource: `{ name: "linked-objects", description: "Linked object definitions (user relationships)", path: "/meta/schemas/user/linkedObjects", singular: "linked object definition", nameField: "primary.name", defaultFields: "primary.name,primary.title,associated.name,associated.title", replaceable: false, creatable: false }` — note GET by id uses `primary.name` as the id, which `resourceGet` already tries first. `linked-objects add --primary-name --primary-title --associated-name --associated-title [--primary-description] [--associated-description]` (out) → POST body `{ primary: { name, title, description, type: "USER" }, associated: { ... } }`.
- On the `users` group (pass `usersCmd` into `registerSchemas(program, ctx, usersCmd)`): `users linked <user> <relationship> [-f]` (out, fields `_links.self.href`… no: the API returns `[{ _links: { self: { href } } }]` which `stripLinks` removes. Instead return the raw response via `client.request` + `rsp.json()` and default fields `_links.self.href`); `users link <user> --to <primary-user> --rel <primaryRelationshipName> [-f]` → PUT `/users/{userId}/linkedObjects/{rel}/{primaryUserId}` → `user {uid} linked to {pid} via {rel}`; `users unlink <user> <relationship> [-f]` → DELETE `/users/{userId}/linkedObjects/{rel}` → `relationship {rel} removed from user {uid}`.
- Tests: `flattenSchemaProperties` on the Python `okta_user_schema` fixture shape (base `login` + custom `abool`, `anint` → 3 rows, custom rows have `scope: "custom"`); `schemaPropertyBody` with enum + array; `add-property` POST path/body; `remove-property` null body and message; `schemas app get` resolves app id; `users link` PUT path.

### Task 23: Automation — `groups rules`, `user-types` (`src/commands/group-rules.ts`, `src/commands/user-types.ts`, `tests/commands-group-rules-user-types.test.ts`, commit `feat: group rules and user types`)

- `registerGroupRules(groupsCmd, ctx)`: `defineResource(groupsCmd, ctx, GROUP_RULES)` with `{ name: "rules", description: "Group rules", path: "/groups/rules", singular: "group rule", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true, creatable: false, listOptions: [{ flags: "-s, --search <text>", param: "search", description: "name search" }] }` — the CLI path is `okta-cli groups rules list`. **Ordering caveat:** `resourceGet` tries `GET /groups/rules/{id}` first; fine. But `retrieve("groups", "rules")` in `getGroup` is unaffected because the `rules` subcommand is registered on the commander group, not as a group name.
- `groups rules add -n/--name <name> -e/--expression <okta-expression> -g/--group <groupId>... [--exclude-user <userId>...]` (out) → POST `/groups/rules` body `{ type: "group_rule", name, conditions: { expression: { type: "urn:okta:expression:1.0", value }, people: { users: { exclude } } }, actions: { assignUserToGroups: { groupIds } } }` (`people` only when excludes given).
- `groups rules delete` gains `--remove-users` flag → query `removeUsers=true`. Implement by defining `delete` manually (`deletable: false` in spec).
- `user-types`: `{ name: "user-types", description: "User types", path: "/meta/types/user", singular: "user type", nameField: "name", defaultFields: "id,name,displayName,default,description" }` + `user-types add -n/--name <name> -d/--display-name <name> [--description <d>]` (out) → POST `{ name, displayName, description }` (`creatable: false`, manual add).
- Tests: `groups rules list -s x` sends `search`; `add` body; `delete --remove-users` query; `user-types add` body; `knownPath` for all.

### Task 24: Identity & access — `policies` (`src/commands/policies.ts`, `tests/commands-policies.test.ts`, commit `feat: policies and policy rules`)

```ts
export const POLICY_TYPES = ["OKTA_SIGN_ON", "PASSWORD", "MFA_ENROLL", "IDP_DISCOVERY", "ACCESS_POLICY", "PROFILE_ENROLLMENT", "POST_AUTH_SESSION", "ENTITY_RISK", "CONTINUOUS_ACCESS"];
export const POLICIES: ResourceSpec = { name: "policies", description: "Policies and rules", path: "/policies", singular: "policy", nameField: "name", defaultFields: "id,status,type,priority,name", lifecycle: true, sortBy: "priority",
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "policy type (required for list and for name lookups)", choices: POLICY_TYPES }, { flags: "--status <status>", param: "status", description: "ACTIVE or INACTIVE", choices: ["ACTIVE", "INACTIVE"] }] };
```
`list` requires `-t` (Okta requires `type`): mark that option `required: true` — but `get/delete/activate/deactivate` by id must still work without `-t`. Therefore `required` must only apply to `list`. Add `requiredForList?: boolean` to `ListOption` (in `resource.ts`) honoured only by the `list` subcommand. `sortBy: "priority"` sorts numerically when both values are numbers (adjust `resourceList` sort: numeric compare when both are numbers).
- `policies rules <policy> [-t]` (out, fields `id,status,type,priority,name,system`) → GET `/policies/{id}/rules`, sorted by priority.
- `policies rule <policy> <rule-name-or-id> [-t]` (out, same) → GET `/policies/{id}/rules/{ruleId}`; name fallback = unique substring match over `rules` list.
- `policies rule-add <policy> -b <json> [-s k=v] [-t]` (out) → POST `/policies/{id}/rules`.
- `policies rule-replace <policy> <rule> -b/-s` → PUT (merge like generic replace).
- `policies rule-activate|rule-deactivate|rule-delete <policy> <rule> [-t]` → POST `/policies/{id}/rules/{rid}/lifecycle/{verb}` (out) / DELETE → `rule {rid} ({name}) deleted from policy {pid}`.
- `policies clone <policy> [-t]` (out) → POST `/policies/{id}/clone`.
- `policies apps <policy> [-t]` (out, fields `id,label,status`) → GET `/policies/{id}/app`.
- `policies mappings <policy>` (out, fields `id,resourceType,resourceId`) → GET `/policies/{id}/mappings`; `policies map <policy> --resource-type APP|USER_TYPE|GROUP --resource-id <id>` (out) → POST `/policies/{id}/mappings` `{ resourceType, resourceId }`.
- Tests: `list` without `-t` fails (commander mandatory error, non-zero exit); `list -t PASSWORD` sends `type`; numeric priority sort; `rules` sorted; `rule` name lookup; `rule-delete` message; `clone`, `apps`, `map` body; knownPath for every path.

### Task 25: Identity & access — `authenticators`, `sessions`, user factors/sessions (`src/commands/authenticators.ts`, `tests/commands-authenticators.test.ts`, commit `feat: authenticators, sessions, user factors`)

```ts
export const AUTHENTICATORS: ResourceSpec = { name: "authenticators", description: "Authenticators (MFA)", path: "/authenticators", singular: "authenticator", nameField: "name", defaultFields: "id,status,type,key,name", lifecycle: true, deletable: false, creatable: false };
```
- `authenticators methods <name-or-id>` (out, fields `type,status`) → GET `/authenticators/{id}/methods`.
- `authenticators method-activate|method-deactivate <authenticator> <methodType>` (out, same) → POST `/authenticators/{id}/methods/{methodType}/lifecycle/{verb}`.
- `sessions` group: `sessions get <sessionId>` (out, fields `id,userId,login,status,createdAt,expiresAt`) → GET `/sessions/{id}`; `sessions refresh <sessionId>` (out) → POST `/sessions/{id}/lifecycle/refresh`; `sessions revoke <sessionId>` → DELETE → `session {id} revoked`.
- On `users` (`registerUserSecurity(usersCmd, ctx)` exported from the same file): `users factors <user> [-f]` (out, fields `id,factorType,provider,status,created`) GET `/users/{id}/factors`; `users factors-catalog <user>` (out, fields `factorType,provider,status,enrollment`) GET `/users/{id}/factors/catalog`; `users factor-delete <user> <factorId> [--remove-recovery-enrollment]` → DELETE `/users/{id}/factors/{fid}` (query `removeRecoveryEnrollment=true` when flag) → `factor {fid} removed from user {uid} ({login})`; `users factors-reset <user>` → POST `/users/{id}/lifecycle/reset_factors` → `all factors reset for user {uid} ({login})`; `users unsuspend <login_or_id>` → POST `/users/{id}/lifecycle/unsuspend` (returns response, mirrors `suspend`); `users blocks <user>` (out, fields `type,appliesTo`) GET `/users/{id}/blocks`; `users sessions-revoke <user> [--oauth-tokens] [-f]` → DELETE `/users/{id}/sessions` (query `oauthTokens=true` when flag) → `sessions revoked for user {uid} ({login})`; `users idps <user>` (out, fields `id,type,status,name`) GET `/users/{id}/idps`.
- Tests: each path via knownPath; `methods` path; `method-activate` path; `sessions revoke` message; `factor-delete` query flag and message; `sessions-revoke --oauth-tokens` query; `unsuspend` path.

### Task 26: Identity & access — `idps` (`src/commands/idps.ts`, `tests/commands-idps.test.ts`, commit `feat: identity providers`)

```ts
export const IDPS: ResourceSpec = { name: "idps", description: "Identity providers", path: "/idps", singular: "identity provider", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "IdP type (SAML2, OIDC, GOOGLE, ...)" }] };
```
- `idps users <idp>` (out, fields `id,externalId,created,lastUpdated`) → GET `/idps/{id}/users`.
- `idps link <idp> -u/--user <user> -e/--external-id <id> [-f]` (out, same fields) → POST `/idps/{id}/users/{userId}` `{ externalId }`.
- `idps unlink <idp> -u/--user <user> [-f]` → DELETE `/idps/{id}/users/{userId}` → `user {uid} ({login}) unlinked from idp {iid} ({name})`.
- `idps keys` (out, fields `kid,kty,use,created,expiresAt`) → GET `/idps/credentials/keys`.
- Tests: `list -t SAML2` query; `link` body and path; `unlink` message; `keys` path; knownPath.

### Task 27: User profile updates (`src/commands/users.ts` additions, `tests/commands-users-profile.test.ts`, commit `feat: users update --from-json, replace, profile`)

- `users update` gains `--from-json <json|FILE:path>` (merged under `-s/-S`, i.e. `deepMerge(parseBody(fromJson), usersUpdateBody(...))`) and `-f/--user-lookup-field <field>` (when given and not `login`, resolve via `getUser` first; otherwise pass the argument straight as Okta accepts id or login).
- `users replace <user> (--from-json <json|FILE> | -s ...) [-f]` → PUT `/users/{id}`; when only `-s`/`-S` given, GET the user first and `deepMerge` (PUT is a full replacement; Okta drops unspecified profile attributes). Returns the response (out, `USER_FIELDS`).
- `users profile <user> [-f]` (out, fields `field,value`) → rows `[{ field, value }]` from `nestedToFlat(user.profile)` sorted by field; non-scalar values JSON-stringified.
- `users schema-check <user> [-f]` (out, fields `field,value,status`) → compares the user's profile keys with `GET /meta/schemas/user/default` base+custom property names; `status` = `ok` / `not-in-schema`; useful before bulk updates. Export `schemaCheck(profile, schema): any[]`.
- Tests: `--from-json` merge order (`-s` wins); `replace -s` fetches then PUTs merged object; `profile` rows sorted; `schema-check` flags unknown field.

### Task 28: Docs, CI, release, Dockerfile, Makefile, PR (commit `docs: readme, changelog, ci and release pipeline`)

- `README.md`: rewrite for 19.x. Sections: what it is (keep the "not affiliated with Okta" note and the `cli.okta.com` disambiguation), Installation (release binaries for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` from GitHub Releases; `bun install -g github:gldc/okta-cli`; `bunx`), Quickstart (the same examples as 18.1.2 plus one per new group: `logs list --since`, `policies list -t PASSWORD`, `schemas user add-property`, `users roles`, `inlinehooks list`), Configuration (path per OS, `OKTA_CLI_CONFIG`, `OKTA_URL`/`OKTA_TOKEN`), CSV/Excel formats (verbatim from 18.1.2 including the trailing-comma note), Output formats, Exit codes, Development (`bun install`, `bun run check`, `bun run gen:types`, spec version pin), Compatibility notes (the fixed Python bugs: `eventhooks activate`, `groups clear`, `config current-context`, `groups list -a` now a flag).
- `CHANGES.rst`: prepend
  ```
  v19.0.0
  =======

  * Rewrite in TypeScript on Bun; single-binary releases; Python no longer required
  * Drop-in compatible command surface with 18.1.2 (see README "Compatibility notes" for 4 bug fixes)
  * New: logs, tokens, roles (+ users/groups role assignment), org, trusted-origins, domains, zones, log-streams
  * New: inlinehooks, hook-keys, schemas (user/group/app, add/remove custom properties), linked-objects, groups rules, user-types
  * New: policies (+ rules, mappings, clone), authenticators, sessions, idps, users factors/blocks/sessions-revoke/unsuspend/idps
  * New: users update --from-json, users replace, users profile, users schema-check
  * New: OKTA_CLI_CONFIG, OKTA_URL/OKTA_TOKEN environment overrides
  * Types generated from Okta management OpenAPI spec 2026.08.4
  ```
- `.github/workflows/ci.yml`: on push/PR → `oven-sh/setup-bun@v2` (bun-version from `.tool-versions`), `bun install --frozen-lockfile`, `bun run check`, `bun run build`, `./dist/okta-cli version`.
- `.github/workflows/release.yml`: on tag `v*` → matrix `{ target: [bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64] }`, `bun build --compile --target=${{ matrix.target }} src/main.ts --outfile dist/okta-cli-${{ matrix.target }}`, `softprops/action-gh-release@v2` attaching `dist/*`.
- `Dockerfile`: `FROM oven/bun:1.3.5` → `WORKDIR /app`, `COPY package.json bun.lock ./`, `RUN bun install --frozen-lockfile --production`, `COPY . .`, `ENTRYPOINT ["bun", "src/main.ts"]`.
- `Makefile`: targets `install` (`bun install`), `check` (`bun run check`), `test`, `build`, `clean` (`rm -rf dist`), `release` (`git tag v$(shell bun -p "require('./package.json').version") && git push --tags`).
- Final verification: `bun run check`; `bun run build`; `./dist/okta-cli --help` lists every group: `config users pw groups apps features eventhooks logs tokens roles org trusted-origins domains zones log-streams inlinehooks hook-keys schemas linked-objects user-types policies authenticators sessions idps` plus `dump raw version`; `./dist/okta-cli users -h` shows the 18.1.2 subcommands plus the new ones.
- Open the PR: `gh pr create --base main --title "Rewrite in TypeScript/Bun; add platform, automation, IAM endpoints" --body-file docs/superpowers/plans/pr-body.md` where the body has sections Why / What changed / Review focus / Verification (terse), ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Self-review notes

- Spec coverage: drop-in surface → Tasks 8–15; Platform admin → 18–20; Automation → 21–23; Identity & access → 24–26; user profile updates → 27; packaging → 1, 12 (embed proof), 28.
- Type consistency: `action(ctx, handler, { client })`, `Handler = (client, opts, ...args)`, `registerUsers`/`registerGroups` return `Command`, `ResourceSpec` fields as defined in Task 17 plus `transform` (Task 20) and `requiredForList` (Task 24).
- Known deviations from 18.1.2, all intentional and listed in README: 4 bug fixes; `-v` logging is request-line based rather than Python logging levels; JSON output is UTF-8 (Python default escaped non-ASCII when no `-j`).
