# MCP Server (okta-cli 19.6.0) Implementation Plan

> **For agentic workers:** implement task-by-task with TDD; each task ends with `bun run check` green and one commit.

**Goal:** `okta-cli mcp serve|stdio` exposes every CLI command as an MCP tool over streamable HTTP (spec 2025-11-25) or stdio, deployable to Runlayer Deploy from the repo's Dockerfile.

**Architecture:** The tool catalog is derived at startup from the commander tree (`buildProgram`): every leaf command becomes one tool whose JSON Schema is generated from its positional arguments and options. A tool call rebuilds argv and runs it through the existing `runCli` with a capturing `Ctx`, so auth, lookups, pagination, output formatting (`--json`) and error mapping are reused unchanged. Read-only mode is enforced at the HTTP client (non-GET refused), not by heuristics. Transport is the official SDK's `WebStandardStreamableHTTPServerTransport` in stateless mode behind `Bun.serve`, plus `StdioServerTransport`.

**Tech Stack:** Bun 1.3.5, TypeScript, commander 15, `@modelcontextprotocol/sdk` ^1.30.0 (low-level `Server`, no zod schemas), `bun test`.

## Global Constraints

- Node/Bun only APIs already used in the repo; no express/hono. Add exactly one runtime dependency: `@modelcontextprotocol/sdk` (`bun add @modelcontextprotocol/sdk@^1.30.0`).
- Never log tool arguments or Okta responses on the server side (PII). One stderr line per call: `mcp tool=<name> code=<n> ms=<n>`.
- Never read local files on behalf of a tool call: `FILE:` body prefixes are rejected in MCP mode.
- No import cycle: `src/commands/mcp.ts` must not import `src/cli/program.ts` at module top level. `registerMcp(program, ctx, buildProgramFn)` receives the program factory as a parameter (same pattern as governance family registration in program.ts).
- Tool names match `^[a-zA-Z0-9_]{1,64}$`: command path joined with `_`, hyphens replaced by `_` (e.g. `users_list`, `governance_entitlement_bundles_get`). 787 leaves today, longest 49 chars, no duplicates.
- Commit message trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `bun run check` (tsc + tests) must pass before every commit.

## Facts about the commander tree (verified 2026-09-14)

- `buildProgram(ctx)` in `src/cli/program.ts` returns the root `Command`; leaves are commands with `commands.length === 0`. Root-level groups to exclude from the catalog: `config`, `version`, `mcp`.
- Leaf metadata: `cmd.name()`, `cmd.description()`, `cmd.registeredArguments` (`{name(), required, variadic, description}`; only 2 of 809 have descriptions), `cmd.options` (`{long, short, attributeName(), required (takes <value>), optional ([value]), mandatory, defaultValue, argChoices, description, negate, parseArg}`).
- `parseArg.name` values seen: `count` (verbose, 780), `int` (660), `collect` (193), anonymous (85), `limit`, `pageSize`, `collectScope`. Map: `int`→integer; `collect`/`collectScope`→array of strings; `count`→skip; everything else→string.
- Output/verbosity options to exclude from schemas: `json`, `yaml`, `csv`, `csvDialect`, `colwidth`, `outputFields`, `verbose`. `confirmation` (from `--no-confirmation`, users.ts) is excluded from the schema and passed automatically.
- Commands that print plain text (no `--json` option): mostly mutations (`users delete`, `apps add`, ...). Their stdout is returned as text.
- `action()` (src/cli/options.ts) writes results via `ctx.io.out`, errors via `mapError` → `ctx.io.exit(code)` → `ExitSignal`; `runCli` returns the exit code (0 ok, 253 Okta API error, 255 usage/comm error, 254 crash, commander errors have their own codes).
- `OktaClient.request(method, path, opts)` and `OktaClient.upload(path, field, file, opts)` are the two public entry points that hit the network (`send()` is private). `json`, `get`, `getAll`, `getAuto` all call `request`.
- SDK 1.30.0: `import { Server } from "@modelcontextprotocol/sdk/server/index.js"`, `import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"`, `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`, `import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"`. Client for tests: `import { Client } from "@modelcontextprotocol/sdk/client/index.js"`, `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"`. `LATEST_PROTOCOL_VERSION` is `2025-11-25`.
- Test helpers: `tests/fixtures/server.ts` `startServer(routes)` → `{url, calls, add, stop}` (first route matching method+path wins; use `handler` for query-dependent responses). `tests/fixtures/ctx.ts` `testCtx(serverUrl)` → `{ctx, out, err, exits, answers}` and `runTest(argv, ctx)`.
- Existing `Dockerfile` runs `bun src/main.ts` from source (CLI image). It is replaced by a multi-stage image that compiles the binary and defaults to the MCP server; the CLI stays reachable via `docker run ... okta-cli users list` because the entrypoint is the binary.

## File structure

- Create `src/mcp/catalog.ts` — walk program → `ToolDef[]`; JSON Schema generation; read/write classification; include/exclude/read-only filtering.
- Create `src/mcp/invoke.ts` — `buildArgv(def, input)` and `invokeTool(def, input, deps)` → `{code, stdout, stderr}`; capturing `Ctx`; `ReadOnlyClient`.
- Create `src/mcp/server.ts` — `createMcpServer(defs, invoke)`, `serveHttp(opts)`, `serveStdio(opts)`.
- Create `src/commands/mcp.ts` — `registerMcp(program, ctx, buildProgramFn)`: `mcp tools`, `mcp serve`, `mcp stdio`.
- Modify `src/cli/program.ts` — register `mcp` group.
- Replace `Dockerfile`; add `runlayer.yaml.example`; extend `.dockerignore`.
- Modify `README.md`, `CHANGES.rst`, `package.json` version + dependency, `src/version.ts`.
- Tests: `tests/mcp-catalog.test.ts`, `tests/mcp-invoke.test.ts`, `tests/mcp-server.test.ts`, `tests/commands-mcp.test.ts`.

---

### Task 1: Tool catalog from the commander tree

**Files:**
- Create: `src/mcp/catalog.ts`
- Test: `tests/mcp-catalog.test.ts`
- Modify: `package.json` (add dependency; run `bun add @modelcontextprotocol/sdk@^1.30.0` — commit `bun.lock` too)

**Interfaces (Produces):**

```ts
export interface ToolArg { name: string; required: boolean; variadic: boolean }
export interface ToolOpt {
  attr: string;            // commander attributeName(), used as the schema property name
  long: string;            // "--filter"
  kind: "boolean" | "string" | "integer" | "string[]" | "body";
  negate: boolean;         // --no-x style: property is boolean default true, false emits --no-x
  required: boolean;       // commander mandatory
  choices?: string[];
  description: string;
  default?: unknown;
}
export interface ToolDef {
  name: string;            // users_list
  path: string[];          // ["users", "list"]
  description: string;
  args: ToolArg[];
  opts: ToolOpt[];
  hasJson: boolean;        // leaf declares --json → invoke appends --json
  hasNoConfirmation: boolean; // leaf declares --no-confirmation → invoke appends it
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export const EXCLUDED_GROUPS = new Set(["config", "version", "mcp"]);
export const EXCLUDED_OPTS = new Set(["json", "yaml", "csv", "csvDialect", "colwidth", "outputFields", "verbose", "confirmation", "help"]);
export const WRITE_VERBS = [ ... ];
export function buildCatalog(program: Command): ToolDef[];
export function toolName(path: string[]): string;
export function isReadOnly(leaf: Command, path: string[]): boolean;
export interface CatalogFilter { readOnly?: boolean; include?: string[]; exclude?: string[] }
export function filterCatalog(defs: ToolDef[], f: CatalogFilter): ToolDef[];
export function globToRegExp(glob: string): RegExp;   // `*` → `.*`, anchored, case-sensitive
```

**Rules:**

- Walk: for each `program.commands` not in `EXCLUDED_GROUPS`, recurse; a command with `commands.length === 0` is a leaf. Path uses `cmd.name()` (not aliases).
- `description` = `leaf.description()`; if the leaf has positional args append ` Positional arguments: <a> [b] ...` using commander's `humanReadableArgName` format built by hand: `<name>` required, `[name]` optional, `...` suffix if variadic.
- Args → schema properties keyed by `arg.name()`: `{type:"string", description:"Positional argument <name>"}`; variadic → `{type:"array", items:{type:"string"}}`; required args go in `required`.
- Options → skip if `attr` in `EXCLUDED_OPTS` or `parseArg?.name === "count"`. Kind: no value (`!required && !optional`) → boolean; `parseArg?.name === "int"` → integer; `parseArg?.name` in {`collect`,`collectScope`} or `variadic` → `string[]`; `long === "--body"` → `body`; else string. `negate` → kind boolean, `default: true`. `choices` from `argChoices` → `enum`. `default` from `defaultValue` when not undefined and not `[]`. `required` = `mandatory`.
- Schema per kind: boolean `{type:"boolean"}`; string `{type:"string"}`; integer `{type:"integer"}`; string[] `{type:"array", items:{type:"string"}}`; body `{anyOf:[{type:"object"},{type:"array"},{type:"string"}], description: opt.description + " Pass a JSON value; FILE: paths are not allowed."}`.
- `inputSchema = { type:"object", properties, required (omit key if empty), additionalProperties:false }`.
- `isReadOnly(leaf, path)`: false if leaf has no `--json` option; false if any option long is `--body` or `--set`; false if any `-`-separated token of the leaf name (last path segment) is in `WRITE_VERBS`; else true.
- `WRITE_VERBS = ["add","adduser","create","update","replace","patch","delete","remove","removeuser","revoke","activate","deactivate","reactivate","suspend","unsuspend","unlock","reset","set","assign","unassign","clear","expire","link","unlink","publish","rotate","generate","import","bulk","subscribe","unsubscribe","reorder","allow","disallow","upload","logo","sync","execute","run","retry","enable","disable","promote","opt","verify","send","test","cancel","approve","deny","reassign","resend","close","reopen","launch","end","start","stop","move","clone","trigger","invoke","register","deregister","enroll","unenroll","grant","exchange","migrate","rename","preview","dr","failover"]`.
- `annotations`: `readOnlyHint = readOnly`; `destructiveHint = !readOnly && /(^|-)(delete|remove|removeuser|revoke|deactivate|suspend|clear|expire|unlink|unassign|unsubscribe|reset|cancel|deny|end|stop|unenroll|deregister)($|-)/.test(leafName)`; `idempotentHint = readOnly`; `openWorldHint = true`.
- `filterCatalog`: start with all; if `readOnly` keep `d.readOnly`; if `include` non-empty keep names matching any include glob; then drop names matching any exclude glob. Globs match the full tool name (`users_*`, `*_delete`).

**Steps:**

- [ ] Step 1: `bun add @modelcontextprotocol/sdk@^1.30.0` (dependency needed in later tasks; add now so one lockfile change).
- [ ] Step 2: Write `tests/mcp-catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { testCtx } from "./fixtures/ctx";
import { buildCatalog, filterCatalog, globToRegExp, toolName } from "../src/mcp/catalog";

const program = buildProgram(testCtx("http://127.0.0.1:1").ctx);
const defs = buildCatalog(program);
const byName = new Map(defs.map((d) => [d.name, d]));

describe("mcp catalog", () => {
  test("covers every leaf except config/version/mcp with unique valid names", () => {
    expect(defs.length).toBeGreaterThan(700);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const d of defs) expect(d.name).toMatch(/^[a-zA-Z0-9_]{1,64}$/);
    expect(defs.some((d) => d.path[0] === "config")).toBe(false);
    expect(byName.has("version")).toBe(false);
    expect(defs.some((d) => d.path[0] === "mcp")).toBe(false);
  });
  test("toolName joins with underscores", () => {
    expect(toolName(["governance", "entitlement-bundles", "get"])).toBe("governance_entitlement_bundles_get");
  });
  test("users list schema: options typed, output options excluded", () => {
    const d = byName.get("users_list")!;
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.filter).toEqual({ type: "string", description: expect.any(String) });
    expect(p.match).toEqual({ type: "array", items: { type: "string" }, description: expect.any(String) });
    expect(p.partial).toEqual({ type: "boolean", description: expect.any(String) });
    expect(p.json).toBeUndefined(); expect(p.outputFields).toBeUndefined(); expect(p.verbose).toBeUndefined();
    expect(d.inputSchema.additionalProperties).toBe(false);
    expect(d.hasJson).toBe(true);
    expect(d.readOnly).toBe(true);
    expect(d.annotations.readOnlyHint).toBe(true);
  });
  test("positional arguments become required string properties", () => {
    const d = byName.get("users_get")!;
    const p = d.inputSchema.properties as Record<string, any>;
    const argName = d.args[0]!.name;
    expect(p[argName].type).toBe("string");
    expect(d.inputSchema.required).toContain(argName);
    expect(d.description).toContain(`<${argName}>`);
  });
  test("body option accepts object or string; --set is string[]", () => {
    const d = byName.get("groups_add")!;
    const p = d.inputSchema.properties as Record<string, any>;
    expect(p.body.anyOf.map((s: any) => s.type)).toEqual(["object", "array", "string"]);
    expect(p.set).toEqual({ type: "array", items: { type: "string" }, description: expect.any(String) });
    expect(d.readOnly).toBe(false);
  });
  test("write classification", () => {
    expect(byName.get("users_delete")!.readOnly).toBe(false);
    expect(byName.get("users_delete")!.annotations.destructiveHint).toBe(true);
    expect(byName.get("users_delete")!.hasNoConfirmation).toBe(true);
    expect(byName.get("groups_adduser")!.readOnly).toBe(false);
    expect(byName.get("apps_keys")!.readOnly).toBe(true);
    expect(byName.get("roles_permissions")!.readOnly).toBe(true);
    expect(byName.get("groups_list")!.annotations.destructiveHint).toBe(false);
  });
  test("integer options", () => {
    const d = defs.find((x) => (x.inputSchema.properties as any).limit)!;
    expect((d.inputSchema.properties as any).limit.type).toBe("integer");
  });
  test("filterCatalog read-only / include / exclude", () => {
    const ro = filterCatalog(defs, { readOnly: true });
    expect(ro.every((d) => d.readOnly)).toBe(true);
    expect(ro.length).toBeGreaterThan(200);
    const inc = filterCatalog(defs, { include: ["users_*", "groups_list"] });
    expect(inc.every((d) => d.name.startsWith("users_") || d.name === "groups_list")).toBe(true);
    expect(inc.some((d) => d.name === "groups_list")).toBe(true);
    const exc = filterCatalog(defs, { exclude: ["*_delete"] });
    expect(exc.some((d) => d.name.endsWith("_delete"))).toBe(false);
    expect(globToRegExp("users_*").test("users_list")).toBe(true);
    expect(globToRegExp("users_*").test("xusers_list")).toBe(false);
  });
});
```

- [ ] Step 3: run `bun test tests/mcp-catalog.test.ts` → fails (module missing).
- [ ] Step 4: Implement `src/mcp/catalog.ts` per Rules. Note `users_get`'s positional arg name: read it from `d.args[0].name` in the test as written; do not hardcode.
- [ ] Step 5: `bun run check` green. Commit: `mcp: tool catalog generated from the commander tree`.

---

### Task 2: Invocation — argv rebuild, capturing context, read-only client

**Files:**
- Create: `src/mcp/invoke.ts`
- Test: `tests/mcp-invoke.test.ts`

**Interfaces (Consumes):** `ToolDef` from Task 1; `runCli` from `src/cli/program.ts`; `Ctx`, `ExitSignal` from `src/cli/context.ts`; `OktaClient`, `Method`, `RequestOptions` from `src/okta/client.ts`; `ExitError` from `src/okta/errors.ts`.

**Interfaces (Produces):**

```ts
export class ReadOnlyClient extends OktaClient {
  // Same constructor as OktaClient. Overrides request() and upload():
  // request: if method !== "GET" throw new ExitError(`read-only mode: refusing ${method} ${path}`); else super.request(...)
  // upload: always throw new ExitError(`read-only mode: refusing upload to ${path}`)
}
export function readOnlyClient(client: OktaClient): OktaClient;
// Wraps an already-built client without re-running auth: returns a Proxy-free object created with
// Object.create(client) whose request/upload are overridden as above (super calls via
// OktaClient.prototype.request.call(client, ...)). Prefer this over the subclass so buildClient's
// OAuth token source is reused. (Ship only ONE of the two: implement readOnlyClient(); drop the class.)

export interface InvokeDeps {
  getClient: () => Promise<OktaClient>;   // shared, lazily built once by the server
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}
export interface InvokeResult { code: number; stdout: string; stderr: string }
export function buildArgv(def: ToolDef, input: Record<string, unknown>): string[];
export async function invokeTool(def: ToolDef, input: Record<string, unknown>, deps: InvokeDeps): Promise<InvokeResult>;
export function toCallToolResult(r: InvokeResult): { content: { type: "text"; text: string }[]; isError?: boolean };
```

**Rules for `buildArgv`:**

- Order: `[...def.path, ...optionTokens, "--", ...positionalTokens]`. The `--` is always emitted when there is at least one positional token; omitted otherwise.
- Option tokens for each `ToolOpt` whose `attr` is present in `input` (and not `undefined`/`null`):
  - boolean, `negate: false`: `true` → `--long`; `false` → nothing.
  - boolean, `negate: true`: `false` → `--no-<name>` (i.e. `opt.long` itself, which commander stores as `--no-x`); `true` → nothing.
  - string: `--long=<value>` (single token; safe for values starting with `-`). Non-string → `String(v)`.
  - integer: must be a number (integer) → `--long=<n>`; otherwise throw `ExitError("<attr> must be an integer")`.
  - string[]: array → one `--long=<v>` token per element; a lone string is accepted as a single element.
  - body: string → if it starts with `FILE:` throw `ExitError("FILE: bodies are not allowed in MCP mode")`, else `--body=<string>`; object/array → `--body=<JSON.stringify(v)>`.
- Also: if `def.hasJson` append `--json`; if `def.hasNoConfirmation` append `--no-confirmation` (before `--`).
- Positionals in `def.args` order: required arg missing → throw `ExitError("missing positional argument <name>")`; optional missing → stop (commander requires positionals to be contiguous; if a later optional is present but an earlier is missing throw `ExitError`). Variadic → spread array elements (a lone string accepted).
- Unknown keys in `input` (not an arg name or opt attr) → throw `ExitError("unknown argument: <key>")`.

**Rules for `invokeTool`:**

- Build a capturing `Ctx`: `io.out`/`io.err` push to arrays; `io.prompt` returns `null`; `io.exit(code)` throws `new ExitSignal(code)`; `getClient()` returns `deps.getClient()` (ignores verbosity); `now` = `deps.now ?? (() => new Date())`; `env = deps.env`.
- `buildArgv` errors (ExitError) → return `{code: 255, stdout: "", stderr: "ERROR: <message>\n"}` without running.
- Run `runCli(argv, ctx)`; return `{code, stdout: out.join(""), stderr: err.join("")}`. Never let an exception escape: catch anything else → `{code: 254, stderr: String(e)}`.
- `toCallToolResult`: text = stdout trimmed; if code !== 0 → `isError: true`, text = `(stdout + stderr).trim()` prefixed with `exit code <n>\n`. If text is empty and code is 0 → text `"ok"`.

**Steps:**

- [ ] Step 1: Write `tests/mcp-invoke.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildProgram } from "../src/cli/program";
import { buildCatalog } from "../src/mcp/catalog";
import { buildArgv, invokeTool, readOnlyClient, toCallToolResult } from "../src/mcp/invoke";
import { OktaClient } from "../src/okta/client";
import { testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";
import { user } from "./fixtures/data";   // adjust to whatever fixture builder exists; else inline {id:"00u1", status:"ACTIVE", profile:{login:"a@x.io", email:"a@x.io"}}

const defs = buildCatalog(buildProgram(testCtx("http://127.0.0.1:1").ctx));
const byName = new Map(defs.map((d) => [d.name, d]));

describe("buildArgv", () => {
  test("options first, -- before positionals, --json appended", () => {
    const d = byName.get("users_get")!;
    const argv = buildArgv(d, { [d.args[0]!.name]: "-weird", });
    expect(argv.slice(0, 2)).toEqual(["users", "get"]);
    expect(argv).toContain("--json");
    expect(argv.slice(-2)).toEqual(["--", "-weird"]);
  });
  test("string, boolean, array, integer options", () => {
    const d = byName.get("users_list")!;
    const argv = buildArgv(d, { filter: 'status eq "ACTIVE"', partial: true, match: ["a=b", "c=d"] });
    expect(argv).toEqual(["users", "list", '--filter=status eq "ACTIVE"', "--partial", "--match=a=b", "--match=c=d", "--json"]);
  });
  test("body object is stringified; FILE: rejected; unknown key rejected", () => {
    const d = byName.get("groups_add")!;
    expect(buildArgv(d, { body: { profile: { name: "x" } } })).toContain('--body={"profile":{"name":"x"}}');
    expect(() => buildArgv(d, { body: "FILE:/etc/passwd" })).toThrow(/FILE:/);
    expect(() => buildArgv(d, { nope: 1 })).toThrow(/unknown argument/);
  });
  test("missing required positional rejected; --no-confirmation appended", () => {
    const d = byName.get("users_delete")!;
    expect(() => buildArgv(d, {})).toThrow(/missing positional/);
    expect(buildArgv(d, { [d.args[0]!.name]: "00u1" })).toContain("--no-confirmation");
  });
});

describe("invokeTool", () => {
  const srv = startServer([
    { method: "GET", path: "/api/v1/users", body: [{ id: "00u1", status: "ACTIVE", profile: { login: "a@x.io", email: "a@x.io", firstName: "A", lastName: "B" } }] },
    { method: "DELETE", path: "/api/v1/users/00u1" },
    { method: "GET", path: "/api/v1/users/00u1", body: { id: "00u1", status: "DEPROVISIONED", profile: { login: "a@x.io" } } },
  ]);
  afterAll(() => srv.stop());
  const deps = (client: OktaClient) => ({ getClient: async () => client, env: {} });
  const client = new OktaClient(srv.url, "tok", { sleep: async () => {} });

  test("returns JSON stdout and exit 0", async () => {
    const r = await invokeTool(byName.get("users_list")!, {}, deps(client));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].id).toBe("00u1");
    const c = toCallToolResult(r);
    expect(c.isError).toBeUndefined();
    expect(c.content[0]!.text).toContain("00u1");
  });
  test("Okta API error → non-zero code, isError", async () => {
    srv.add({ method: "GET", path: "/api/v1/groups", status: 403, body: { errorCode: "E0000006", errorSummary: "denied", errorCauses: [] } });
    const r = await invokeTool(byName.get("groups_list")!, {}, deps(client));
    expect(r.code).toBe(253);
    const c = toCallToolResult(r);
    expect(c.isError).toBe(true);
    expect(c.content[0]!.text).toContain("E0000006");
  });
  test("argv error → 255 without network", async () => {
    const before = srv.calls.length;
    const r = await invokeTool(byName.get("users_list")!, { bogus: true }, deps(client));
    expect(r.code).toBe(255);
    expect(r.stderr).toContain("unknown argument");
    expect(srv.calls.length).toBe(before);
  });
  test("read-only client refuses non-GET at the HTTP layer", async () => {
    const ro = readOnlyClient(client);
    const d = byName.get("users_delete")!;
    const r = await invokeTool(d, { [d.args[0]!.name]: "00u1" }, deps(ro));
    expect(r.code).toBe(255);
    expect(r.stderr).toContain("read-only mode");
    expect(srv.calls.some((c) => c.method === "DELETE")).toBe(false);
    const ok = await invokeTool(byName.get("users_list")!, {}, deps(ro));
    expect(ok.code).toBe(0);
  });
});
```

- [ ] Step 2: run → fails. Step 3: implement `src/mcp/invoke.ts`. Step 4: `bun run check`. Step 5: commit `mcp: tool invocation through runCli with capturing ctx and read-only client`.

Note for the `users_delete` test: the CLI first GETs the user (lookup) then DELETEs; with the read-only client the GET succeeds and the DELETE is refused → exit 255 via `mapError(ExitError)`.

---

### Task 3: MCP server (streamable HTTP + stdio)

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`

**Interfaces (Produces):**

```ts
export interface ServerDeps { defs: ToolDef[]; invoke: (def: ToolDef, input: Record<string, unknown>) => Promise<InvokeResult>; log: (line: string) => void; version: string }
export function createMcpServer(deps: ServerDeps): Server;   // low-level Server, capabilities {tools:{}}
export interface HttpOptions { host: string; port: number; path: string }   // path default "/mcp"
export function serveHttp(deps: ServerDeps, opts: HttpOptions): { url: string; port: number; stop(): void };   // uses Bun.serve
export async function serveStdio(deps: ServerDeps): Promise<void>;
```

**Rules:**

- `createMcpServer`: `new Server({ name: "okta-cli", version }, { capabilities: { tools: {} } })`. `tools/list` returns `deps.defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations }))` (no pagination; cursor ignored). `tools/call`: unknown name → `{ content:[{type:"text", text:"unknown tool <name>"}], isError:true }`; else `const t0 = performance.now(); const r = await deps.invoke(def, args ?? {}); deps.log(`mcp tool=${def.name} code=${r.code} ms=${Math.round(performance.now()-t0)}`); return toCallToolResult(r)`.
- `serveHttp`: `Bun.serve({ hostname: opts.host, port: opts.port, fetch })`. In `fetch`: `GET /healthz` → `Response.json({ ok: true, tools: defs.length, version })`. Requests whose pathname !== `opts.path` → 404 JSON `{error:"not found"}`. Otherwise stateless per request: `const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); const server = createMcpServer(deps); await server.connect(transport); return transport.handleRequest(req)`. Return `{ url: `http://${host}:${server.port}`, port: server.port, stop: () => server.stop(true) }`.
- `serveStdio`: `const server = createMcpServer(deps); await server.connect(new StdioServerTransport()); return new Promise(() => {})` — resolves never; the process exits on stdin EOF (SDK closes the transport → call `server.onclose = () => resolve()` and resolve then).
- Note: `deps.log` must write to stderr only (stdout is the stdio transport).

**Steps:**

- [ ] Step 1: Write `tests/mcp-server.test.ts` — full round trip with the SDK client:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildProgram } from "../src/cli/program";
import { buildCatalog, filterCatalog } from "../src/mcp/catalog";
import { invokeTool } from "../src/mcp/invoke";
import { serveHttp } from "../src/mcp/server";
import { OktaClient } from "../src/okta/client";
import { testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

const okta = startServer([{ method: "GET", path: "/api/v1/groups", body: [{ id: "00g1", type: "OKTA_GROUP", profile: { name: "Everyone", description: "" } }] }]);
const client = new OktaClient(okta.url, "tok", { sleep: async () => {} });
const defs = filterCatalog(buildCatalog(buildProgram(testCtx(okta.url).ctx)), { include: ["groups_*", "users_list"] });
const logs: string[] = [];
const http = serveHttp({ defs, version: "test", log: (l) => logs.push(l), invoke: (d, i) => invokeTool(d, i, { getClient: async () => client, env: {} }) }, { host: "127.0.0.1", port: 0, path: "/mcp" });
afterAll(() => { http.stop(); okta.stop(); });

async function connect() {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`)));
  return c;
}

describe("mcp http server", () => {
  test("healthz", async () => {
    const r = await fetch(`${http.url}/healthz`);
    expect(r.status).toBe(200);
    expect((await r.json()).tools).toBe(defs.length);
  });
  test("unknown path 404", async () => { expect((await fetch(`${http.url}/nope`, { method: "POST" })).status).toBe(404); });
  test("initialize + tools/list + tools/call", async () => {
    const c = await connect();
    const tools = await c.listTools();
    expect(tools.tools.length).toBe(defs.length);
    const gl = tools.tools.find((t) => t.name === "groups_list")!;
    expect(gl.inputSchema.type).toBe("object");
    expect(gl.annotations?.readOnlyHint).toBe(true);
    const r = await c.callTool({ name: "groups_list", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.content as any[])[0].text).toContain("00g1");
    expect(logs.some((l) => l.startsWith("mcp tool=groups_list code=0"))).toBe(true);
    await c.close();
  });
  test("tool error surfaces as isError", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "groups_get", arguments: { [defs.find((d) => d.name === "groups_get")!.args[0]!.name]: "nomatch" } });
    expect(r.isError).toBe(true);
    await c.close();
  });
  test("unknown tool", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "nope", arguments: {} });
    expect(r.isError).toBe(true);
    await c.close();
  });
  test("two concurrent calls (stateless)", async () => {
    const c = await connect();
    const [a, b] = await Promise.all([c.callTool({ name: "groups_list", arguments: {} }), c.callTool({ name: "groups_list", arguments: {} })]);
    expect(a.isError).toBeFalsy(); expect(b.isError).toBeFalsy();
    await c.close();
  });
});
```

`groups_get` with "nomatch": the mock returns the one group for `GET /api/v1/groups` (with any `q`); by-id GET `/api/v1/groups/nomatch` has no route → mock returns 500 → CLI maps to an error → isError. If the CLI's lookup path instead matches "nomatch" against the list and finds nothing → ExitError → isError as well. Either way `isError` is true.

- [ ] Step 2: run → fails. Step 3: implement `src/mcp/server.ts`. Step 4: `bun run check`. Step 5: commit `mcp: streamable HTTP (stateless) and stdio server`.

---

### Task 4: `okta-cli mcp` commands

**Files:**
- Create: `src/commands/mcp.ts`
- Modify: `src/cli/program.ts` (import `registerMcp`; call `registerMcp(program, ctx, () => buildProgram(ctx))` as the last registration, before `return program`)
- Test: `tests/commands-mcp.test.ts`

**Interfaces:**

```ts
export function registerMcp(parent: Command, ctx: Ctx, buildProgramFn: () => Command): Command;
```

**Commands:**

- `mcp` group description: `Serve the CLI as an MCP server (streamable HTTP or stdio)`.
- Shared options via a helper `addCatalogOptions(cmd)`: `--read-only` (boolean: only read tools are listed and every non-GET request is refused), `--include <glob>` (collect, repeatable: `users_*`), `--exclude <glob>` (collect, repeatable).
- `mcp tools [options]` + `addOutputOptions(cmd, "name readOnly description")` + `addVerbose`: prints the catalog after filtering as `[{name, readOnly, description}]` through the normal `action()` path (`{client: false}`). Result rows: `defs.map(d => ({ name: d.name, readOnly: d.readOnly, description: d.description }))`.
- `mcp serve [options] --host <host> --port <n> --path <path>`: defaults `127.0.0.1`, `8000` (int), `/mcp`. Uses `action(ctx, handler, {client:false})`. Handler: build defs from `buildProgramFn()` + filter; lazily shared client: `let clientP: Promise<OktaClient> | undefined; const getClient = () => (clientP ??= ctx.getClient(0).then(c => opts.readOnly ? readOnlyClient(c) : c))` — on rejection reset `clientP = undefined` so a bad token doesn't poison the process; deps `{defs, version: VERSION, log: (l) => ctx.io.err(l + "\n"), invoke: (d, i) => invokeTool(d, i, { getClient, env: ctx.env, now: ctx.now })}`. Start `serveHttp`, print `okta-cli mcp: serving <n> tools at http://host:port/path (read-only: yes|no)` to stderr, then `await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); })`, then `stop()`. Return `undefined` (nothing to print).
- `mcp stdio [options]`: same deps; `await serveStdio(deps)`. Startup banner to stderr.
- Env-var defaults for the container: `--host` default = `ctx.env.OKTA_MCP_HOST ?? "127.0.0.1"`, `--port` default = `int(ctx.env.OKTA_MCP_PORT ?? "8000")`, `--read-only` default true when `ctx.env.OKTA_MCP_READ_ONLY === "1"`, `--include`/`--exclude` defaults from comma-separated `OKTA_MCP_INCLUDE` / `OKTA_MCP_EXCLUDE`. Resolve these inside the handler (`opts.host ?? env...`) rather than as commander defaults, so `mcp tools` and tests behave the same.

**Steps:**

- [ ] Step 1: `tests/commands-mcp.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { runTest, testCtx } from "./fixtures/ctx";

describe("mcp tools", () => {
  test("lists tools as JSON, read-only filter, include glob", async () => {
    const { ctx, out } = testCtx("http://127.0.0.1:1");
    expect(await runTest(["mcp", "tools", "-j"], ctx)).toBe(0);
    const all = JSON.parse(out.join(""));
    expect(all.length).toBeGreaterThan(700);
    expect(all.some((t: any) => t.name.startsWith("mcp_"))).toBe(false);
    out.length = 0;
    expect(await runTest(["mcp", "tools", "-j", "--read-only", "--include", "users_*"], ctx)).toBe(0);
    const ro = JSON.parse(out.join(""));
    expect(ro.length).toBeGreaterThan(5);
    expect(ro.every((t: any) => t.readOnly && t.name.startsWith("users_"))).toBe(true);
  });
  test("env defaults: OKTA_MCP_READ_ONLY=1 and OKTA_MCP_INCLUDE", async () => {
    const { ctx, out } = testCtx("http://127.0.0.1:1");
    ctx.env = { OKTA_MCP_READ_ONLY: "1", OKTA_MCP_INCLUDE: "groups_*,users_list" };
    expect(await runTest(["mcp", "tools", "-j"], ctx)).toBe(0);
    const t = JSON.parse(out.join(""));
    expect(t.every((x: any) => x.readOnly)).toBe(true);
    expect(t.some((x: any) => x.name === "users_list")).toBe(true);
    expect(t.some((x: any) => x.name === "users_get")).toBe(false);
  });
  test("mcp serve is registered with host/port/path options", async () => {
    const { ctx, out, err } = testCtx("http://127.0.0.1:1");
    await runTest(["mcp", "serve", "--help"], ctx);
    const help = out.join("") + err.join("");
    expect(help).toContain("--host");
    expect(help).toContain("--port");
    expect(help).toContain("--read-only");
  });
});
```

- [ ] Step 2: run → fails. Step 3: implement `src/commands/mcp.ts` and wire it in `program.ts`. Step 4: `bun run check`. Step 5: commit `mcp: okta-cli mcp tools|serve|stdio commands`.

---

### Task 5: Container image + Runlayer Deploy manifest

**Files:**
- Replace: `Dockerfile`
- Modify: `.dockerignore` (add `.env`, `okta-cli-*`, `*.md` is NOT excluded — README is harmless; add `docs` already present)
- Create: `runlayer.yaml.example`

**Dockerfile:**

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1.3.5 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile src/main.ts --outfile /out/okta-cli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/okta-cli /usr/local/bin/okta-cli
# The MCP server keeps OAuth access tokens in memory only; nothing is written to $HOME.
ENV OKTA_CLI_NO_TOKEN_CACHE=1 OKTA_MCP_HOST=0.0.0.0 OKTA_MCP_PORT=8000 HOME=/tmp
USER 65532:65532
EXPOSE 8000
ENTRYPOINT ["okta-cli"]
CMD ["mcp", "serve"]
```

`runlayer.yaml.example`:

```yaml
# Copy to runlayer.yaml after `uvx runlayer deploy pull --deployment-id <id>` writes the real `id`.
name: okta
runtime: docker
build:
  dockerfile: Dockerfile
  context: .
  platform: arm
service:
  port: 8000
  path: /mcp
infrastructure:
  cpu: 256
  memory: 512
  platform: arm
env:
  OKTA_URL: https://your-org.okta.com
  # Either an SSWS API token ...
  OKTA_TOKEN: "<set in the Runlayer UI, not here>"
  # ... or an OAuth 2.0 service app (see README "Authentication"):
  # OKTA_CLIENT_ID: 0oa...
  # OKTA_PRIVATE_KEY: '{"kty":"RSA",...}'
  # OKTA_SCOPES: okta.users.read okta.groups.read
  # OKTA_DPOP: "1"
  OKTA_MCP_READ_ONLY: "1"
  # OKTA_MCP_INCLUDE: users_*,groups_*
  # OKTA_MCP_EXCLUDE: "*_delete"
```

**Steps:**

- [ ] Step 1: write the files. Step 2: `docker build -t okta-cli-mcp:dev .` must succeed (arm64 host). Step 3: `docker run --rm -p 18000:8000 -e OKTA_URL=https://example.okta.com -e OKTA_TOKEN=x okta-cli-mcp:dev` in the background; `curl -s localhost:18000/healthz` returns `{"ok":true,...}`; stop the container. Step 4: commit `mcp: multi-stage image running the MCP server; runlayer.yaml.example`.

---

### Task 6: Docs, version, changelog, PR

**Files:**
- Modify: `README.md` — add section `## MCP server` after "Identity Governance" (or at the end of the feature sections): what it is (every command is a tool, names `users_list` etc.), `okta-cli mcp serve --read-only`, `okta-cli mcp stdio` with a Claude Code snippet (`claude mcp add okta -- okta-cli mcp stdio --read-only`), `okta-cli mcp tools -j`, filters (`--include/--exclude` globs, env `OKTA_MCP_*`), read-only semantics (catalog filtered by verb classification and every non-GET refused at the HTTP client), Runlayer Deploy steps (build connector from manifest, `deploy pull`, copy `runlayer.yaml.example`, `uvx runlayer deploy --config runlayer.yaml`), credentials via env, note that `FILE:` bodies and local-file options are unavailable in MCP mode.
- Modify: `CHANGES.rst` — `v19.6.0` entry at top: MCP server (streamable HTTP 2025-11-25 + stdio), tool catalog, read-only mode, filters, Docker image, runlayer.yaml.example.
- Modify: `package.json` version `19.6.0`, `src/version.ts` `19.6.0`. Fix any test asserting the version.

**Steps:**

- [ ] Step 1: edit files. Step 2: `bun run check`. Step 3: commit `okta-cli 19.6.0: docs, changelog, version`. Step 4: `git push -u origin feat/mcp-server` and open the PR with `gh pr create --title "okta-cli 19.6.0: MCP server" --body-file <body>` where the body has sections `## Why`, `## What changed`, `## Review focus`, `## Verification`, ending with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
