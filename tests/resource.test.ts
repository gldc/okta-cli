import { afterEach, describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { defineResource, type ResourceSpec } from "../src/commands/resource";
import { buildProgram } from "../src/cli/program";
import { knownPath } from "../src/okta/spec-paths";
import { ExitSentinel, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const spec: ResourceSpec = { name: "test-zones", description: "Network zones", path: "/zones", singular: "network zone", nameField: "name", defaultFields: "id,status,type,name", lifecycle: true,
  listOptions: [{ flags: "-t, --type <type>", param: "type", description: "zone type" }] };
const zones = [{ id: "z2", status: "ACTIVE", type: "IP", name: "Office" }, { id: "z1", status: "ACTIVE", type: "DYNAMIC", name: "Blocked" }];
const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };

async function run(argv: string[], t: ReturnType<typeof testCtx>) {
  const p = buildProgram(t.ctx);
  defineResource(p, t.ctx, spec);
  try { await p.parseAsync(argv, { from: "user" }); return 0; } catch (e) { if (e instanceof ExitSentinel) return e.code; throw e; }
}

// Like run(), but for a throwaway spec passed in (used by the basePath/filterRequired/limitOption
// tests below) - also catches the CommanderError a missing requiredOption throws, mirroring
// runCli's handling in src/cli/program.ts.
async function runG(argv: string[], t: ReturnType<typeof testCtx>, s: ResourceSpec) {
  const p = buildProgram(t.ctx);
  defineResource(p, t.ctx, s);
  try { await p.parseAsync(argv, { from: "user" }); return 0; }
  catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
}

describe("defineResource", () => {
  test("spec path is a real okta path", () => expect(knownPath(spec.path)).toBe(true));

  test("list sorted with partial + extra query; get by id / name", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/zones\/[^/]+$/, handler: (_r, url) => url.pathname.endsWith("/z1") ? Response.json(zones[1]) : Response.json(notFound, { status: 404 }) },
      { method: "GET", path: "/api/v1/zones", body: zones },
    ]);
    const t = testCtx(srv.url);
    await run(["test-zones", "list", "-t", "IP"], t);
    expect(srv.calls[0]!.query).toEqual({ type: "IP" });
    expect(t.out.at(-1)).toBe("z1  ACTIVE  DYNAMIC  Blocked  \nz2  ACTIVE  IP       Office   \n");
    await run(["test-zones", "list", "off", "--output-fields", "id"], t);
    expect(t.out.at(-1)).toBe("z2  \n");
    await run(["test-zones", "get", "z1", "-j"], t);
    expect(JSON.parse(t.out.at(-1)!).id).toBe("z1");
    await run(["test-zones", "get", "office", "--output-fields", "id"], t);
    expect(t.out.at(-1)).toBe("z2  \n");
    expect(await run(["test-zones", "get", "zzz"], t)).toBe(255);
  });

  test("add / replace merge / delete / activate / deactivate", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/zones/z2", body: zones[0] },
      { method: "GET", path: "/api/v1/zones/office", status: 404, body: notFound },
      { method: "GET", path: "/api/v1/zones", body: zones },
      { method: "POST", path: "/api/v1/zones", body: { id: "z9", name: "New" } },
      { method: "PUT", path: "/api/v1/zones/z2", body: { ...zones[0], name: "Renamed" } },
      { method: "DELETE", path: "/api/v1/zones/z2" },
      { method: "POST", path: "/api/v1/zones/z2/lifecycle/activate", body: { ...zones[0] } },
      { method: "POST", path: "/api/v1/zones/z2/lifecycle/deactivate" },
    ]);
    const t = testCtx(srv.url);
    await run(["test-zones", "add", "-b", '{"type":"IP"}', "-s", "name=New", "-j"], t);
    expect(srv.calls.at(-1)!.body).toEqual({ type: "IP", name: "New" });
    await run(["test-zones", "replace", "z2", "-s", "name=Renamed"], t);
    expect(srv.calls.at(-1)!.method).toBe("PUT");
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/zones/z2"); // URL still keys off existing's id
    // `id` (a read-only field) is stripped from the merge base - the URL, not the body, carries it.
    expect(srv.calls.at(-1)!.body).toEqual({ status: "ACTIVE", type: "IP", name: "Renamed" });
    await run(["test-zones", "delete", "office"], t);
    expect(t.out.at(-1)).toBe("network zone z2 (Office) deleted\n");
    await run(["test-zones", "activate", "z2", "--output-fields", "id"], t);
    expect(t.out.at(-1)).toBe("z2  \n");
    await run(["test-zones", "deactivate", "z2"], t);
    expect(t.out.at(-1)).toBe("network zone z2 (Office) deactivated\n");
  });

  test("replace strips default read-only fields plus spec.replaceOmit from the merge base (never mutates existing)", async () => {
    const roSpec: ResourceSpec = { name: "ro-things", description: "d", path: "/ro-things", singular: "ro thing", nameField: "name", defaultFields: "id,name", replaceOmit: ["secret"] };
    const roItem = { id: "r1", name: "Thing", secret: "s3cr3t", created: "2020", lastUpdated: "2021", createdBy: "u1", lastUpdatedBy: "u2", _links: { self: {} }, _embedded: { x: 1 } };
    const roItemCopy = { ...roItem };
    srv = startServer([
      { method: "GET", path: "/api/v1/ro-things/r1", body: roItem },
      { method: "PUT", path: "/api/v1/ro-things/r1", body: { name: "Renamed" } },
    ]);
    const t = testCtx(srv.url);
    const p = buildProgram(t.ctx);
    defineResource(p, t.ctx, roSpec);
    try { await p.parseAsync(["ro-things", "replace", "r1", "-s", "name=Renamed"], { from: "user" }); } catch (e) { if (!(e instanceof ExitSentinel)) throw e; }
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/ro-things/r1"); // URL still keys off existing's id
    const body = srv.calls.at(-1)!.body;
    for (const f of ["id", "created", "lastUpdated", "createdBy", "lastUpdatedBy", "_links", "_embedded", "secret"]) expect(body).not.toHaveProperty(f);
    expect(body).toEqual({ name: "Renamed" });
    expect(roItem).toEqual(roItemCopy); // existing was never mutated
  });

  test("beforeReplace hook can adjust the body right before the PUT", async () => {
    const hookSpec: ResourceSpec = {
      name: "ro-things2", description: "d", path: "/ro-things2", singular: "ro thing", nameField: "name", defaultFields: "id,name",
      beforeReplace: async (_client, existing, body) => ({ ...body, stampedFrom: existing.id }),
    };
    srv = startServer([
      { method: "GET", path: "/api/v1/ro-things2/r1", body: { id: "r1", name: "Thing" } },
      { method: "PUT", path: "/api/v1/ro-things2/r1", body: { name: "Renamed", stampedFrom: "r1" } },
    ]);
    const t = testCtx(srv.url);
    const p = buildProgram(t.ctx);
    defineResource(p, t.ctx, hookSpec);
    try { await p.parseAsync(["ro-things2", "replace", "r1", "-s", "name=Renamed"], { from: "user" }); } catch (e) { if (!(e instanceof ExitSentinel)) throw e; }
    expect(srv.calls.at(-1)!.body).toEqual({ name: "Renamed", stampedFrom: "r1" });
  });

  test("get by id: 502 surfaces COMMUNICATION_ERROR instead of falling back to list search", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/zones/z1", status: 502, body: { errorSummary: "bad gateway" } },
      { method: "GET", path: "/api/v1/zones", body: zones },
    ]);
    const t = testCtx(srv.url);
    expect(await run(["test-zones", "get", "z1"], t)).toBe(255);
    expect(t.err.join("")).toContain("COMMUNICATION_ERROR");
    expect(srv.calls.length).toBe(1);
  });
});

describe("ResourceSpec.basePath", () => {
  const govSpec: ResourceSpec = { name: "gov-things", description: "Gov things", path: "/gov-things", basePath: "/governance/api/v1", singular: "gov thing", nameField: "name", listKey: "data", defaultFields: "id,name" };
  const govItem = { id: "g1", name: "Thing" };

  test("list/get/add/replace/delete all hit the spec's basePath, not /api/v1", async () => {
    srv = startServer([
      { method: "GET", path: "/governance/api/v1/gov-things", body: { data: [govItem] } },
      { method: "GET", path: "/governance/api/v1/gov-things/g1", body: govItem },
      { method: "POST", path: "/governance/api/v1/gov-things", body: { id: "g2", name: "New" } },
      { method: "PUT", path: "/governance/api/v1/gov-things/g1", body: { ...govItem, name: "Renamed" } },
      { method: "DELETE", path: "/governance/api/v1/gov-things/g1" },
    ]);
    const t = testCtx(srv.url);
    await runG(["gov-things", "list"], t, govSpec);
    expect(srv.calls.at(-1)!.path).toBe("/governance/api/v1/gov-things");
    await runG(["gov-things", "get", "g1"], t, govSpec);
    expect(srv.calls.at(-1)!.path).toBe("/governance/api/v1/gov-things/g1");
    await runG(["gov-things", "add", "-s", "name=New"], t, govSpec);
    expect(srv.calls.at(-1)!.path).toBe("/governance/api/v1/gov-things");
    await runG(["gov-things", "replace", "g1", "-s", "name=Renamed"], t, govSpec);
    expect(srv.calls.at(-1)!.path).toBe("/governance/api/v1/gov-things/g1");
    await runG(["gov-things", "delete", "g1"], t, govSpec);
    expect(srv.calls.at(-1)).toEqual(expect.objectContaining({ method: "DELETE", path: "/governance/api/v1/gov-things/g1" }));
  });

  test("_links.next.href pagination is followed across two pages with listKey \"data\"", async () => {
    srv = startServer([]);
    srv.add({
      method: "GET", path: "/governance/api/v1/gov-things",
      handler: (_req, url) => {
        const after = url.searchParams.get("after");
        if (!after) return Response.json({ data: [{ id: "g1", name: "A" }], _links: { next: { href: `${srv.url}/governance/api/v1/gov-things?after=x` } } });
        return Response.json({ data: [{ id: "g2", name: "B" }] });
      },
    });
    const t = testCtx(srv.url);
    await runG(["gov-things", "list"], t, govSpec);
    expect(srv.calls.length).toBe(2);
    expect(t.out.at(-1)).toBe("g1  A  \ng2  B  \n");
  });
});

describe("ResourceSpec.filterRequired", () => {
  const filterSpec: ResourceSpec = { name: "gov-filtered", description: "Gov filtered things", path: "/gov-filtered", basePath: "/governance/api/v1", singular: "gov filtered thing", nameField: "name", listKey: "data", defaultFields: "id,name", filterRequired: true, creatable: false, replaceable: false, deletable: false };

  test("list without -f exits non-zero with commander's required-option error; no request is made", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runG(["gov-filtered", "list"], t, filterSpec)).not.toBe(0);
    expect(t.err.join("")).toContain("required option");
    expect(srv.calls.length).toBe(0);
  });

  test("list with -f sends filter as given, with no injected default", async () => {
    srv = startServer([{ method: "GET", path: "/governance/api/v1/gov-filtered", body: { data: [] } }]);
    const t = testCtx(srv.url);
    await runG(["gov-filtered", "list", "-f", 'name eq "x"'], t, filterSpec);
    expect(srv.calls.at(-1)!.query).toEqual({ filter: 'name eq "x"' });
  });

  test("get: a 404 by-id throws instead of falling back to a filterless list", async () => {
    srv = startServer([{ method: "GET", path: "/governance/api/v1/gov-filtered/nope", status: 404, body: notFound }]);
    const t = testCtx(srv.url);
    expect(await runG(["gov-filtered", "get", "nope"], t, filterSpec)).not.toBe(0);
    expect(t.err.join("")).toContain("must be given by id");
    expect(srv.calls.length).toBe(1); // no filterless list call was made
  });
});

describe("ResourceSpec.limitOption", () => {
  const limitSpec: ResourceSpec = { name: "gov-limited", description: "Gov limited things", path: "/gov-limited", basePath: "/governance/api/v1", singular: "gov limited thing", nameField: "name", listKey: "data", defaultFields: "id,name", limitOption: true, creatable: false, replaceable: false, deletable: false };

  test("--limit caps the result client-side across pages; the limit query parameter is never sent", async () => {
    srv = startServer([]);
    srv.add({
      method: "GET", path: "/governance/api/v1/gov-limited",
      handler: (_req, url) => {
        const after = url.searchParams.get("after");
        if (!after) return Response.json({ data: [{ id: "l1", name: "A" }, { id: "l2", name: "B" }], _links: { next: { href: `${srv.url}/governance/api/v1/gov-limited?after=x` } } });
        return Response.json({ data: [{ id: "l3", name: "C" }, { id: "l4", name: "D" }] });
      },
    });
    const t = testCtx(srv.url);
    await runG(["gov-limited", "list", "--limit", "3"], t, limitSpec);
    expect(srv.calls[0]!.query.limit).toBeUndefined();
    expect(t.out.at(-1)).toBe("l1  A  \nl2  B  \nl3  C  \n");
  });
});
