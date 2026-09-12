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

  test("add without -e/--event errors and makes no HTTP call", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/eventHooks", body: hooks[0] }]);
    const t = testCtx(srv.url);
    const code = await runTest(["eventhooks", "add", "-u", "https://h", "-n", "x"], t.ctx);
    expect(code).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });
});
