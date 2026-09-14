import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
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
