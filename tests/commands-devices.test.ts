import { afterEach, describe, expect, test } from "bun:test";
import { DEVICE_ASSURANCES, DEVICES } from "../src/commands/devices";
import { knownPath } from "../src/okta/spec-paths";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };
const device = { id: "guo1", status: "ACTIVE", profile: { displayName: "Bob's iPhone", platform: "IOS", osVersion: "17.0" }, lastUpdated: "2026-01-01T00:00:00.000Z" };
const deviceByIdRoute = { method: "GET" as const, path: /^\/api\/v1\/devices\/guo1$/, body: device };

test("spec paths", () => {
  for (const p of [
    DEVICES.path, `${DEVICES.path}/x`, `${DEVICES.path}/x/lifecycle/activate`, `${DEVICES.path}/x/lifecycle/deactivate`,
    `${DEVICES.path}/x/lifecycle/suspend`, `${DEVICES.path}/x/lifecycle/unsuspend`, `${DEVICES.path}/x/users`,
    DEVICE_ASSURANCES.path, `${DEVICE_ASSURANCES.path}/x`,
    "/users/x/devices",
  ]) expect(knownPath(p), p).toBe(true);
});

describe("devices list", () => {
  test("--search and --expand build the query and print the default table", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/devices", body: [device] }]);
    const t = testCtx(srv.url);
    await runTest(["devices", "list", "--search", 'status eq "ACTIVE"', "--expand", "user"], t.ctx);
    expect(srv.calls[0]!.query).toEqual({ search: 'status eq "ACTIVE"', expand: "user" });
    expect(t.out.at(-1)).toBe("guo1  ACTIVE  Bob's iPhone  IOS  17.0  2026-01-01T00:00:00.000Z  \n");
  });

  test("--expand rejects an invalid value locally", async () => {
    srv = startServer([]);
    const t = testCtx(srv.url);
    expect(await runTest(["devices", "list", "--expand", "bogus"], t.ctx)).not.toBe(0);
    expect(srv.calls.length).toBe(0);
  });
});

describe("devices suspend / unsuspend", () => {
  test("suspend resolves by id and posts lifecycle/suspend", async () => {
    srv = startServer([deviceByIdRoute, { method: "POST", path: "/api/v1/devices/guo1/lifecycle/suspend" }]);
    const t = testCtx(srv.url);
    await runTest(["devices", "suspend", "guo1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/devices/guo1/lifecycle/suspend");
    expect(t.out.at(-1)).toBe("device guo1 (Bob's iPhone) suspended\n");
  });

  test("unsuspend resolves by id and posts lifecycle/unsuspend", async () => {
    srv = startServer([deviceByIdRoute, { method: "POST", path: "/api/v1/devices/guo1/lifecycle/unsuspend" }]);
    const t = testCtx(srv.url);
    await runTest(["devices", "unsuspend", "guo1"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/devices/guo1/lifecycle/unsuspend");
    expect(t.out.at(-1)).toBe("device guo1 (Bob's iPhone) unsuspended\n");
  });
});

describe("devices users", () => {
  test("lists the users associated with a device", async () => {
    srv = startServer([
      deviceByIdRoute,
      {
        method: "GET", path: "/api/v1/devices/guo1/users",
        body: [{ user: { id: "00u1", profile: { login: "bob@x.com" } }, managementStatus: "MANAGED", screenLockType: "PASSCODE", created: "2026-01-01T00:00:00.000Z" }],
      },
    ]);
    const t = testCtx(srv.url);
    await runTest(["devices", "users", "guo1", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/devices/guo1/users");
    expect(JSON.parse(t.out.join(""))[0].user.id).toBe("00u1");
  });
});

describe("device-assurances", () => {
  test("list returns the default fields", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/device-assurances", body: [{ id: "das1", name: "iOS assurance", platform: "IOS", lastUpdate: "2026-01-01T00:00:00.000Z" }] }]);
    const t = testCtx(srv.url);
    await runTest(["device-assurances", "list"], t.ctx);
    expect(t.out.at(-1)).toBe("das1  iOS assurance  IOS  2026-01-01T00:00:00.000Z  \n");
  });

  test("add posts a JSON body", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/device-assurances", body: { id: "das2", name: "New" } }]);
    const t = testCtx(srv.url);
    await runTest(["device-assurances", "add", "-s", "name=New"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual({ name: "New" });
  });
});

describe("users devices", () => {
  test("resolves the user by login and lists their devices", async () => {
    srv = startServer([
      {
        method: "GET", path: "/api/v1/users", handler: (_r, url) => {
          const search = url.searchParams.get("search") ?? "";
          return Response.json(search.includes("bob@x.com") ? [{ id: "00u1", profile: { login: "bob@x.com" } }] : []);
        },
      },
      { method: "GET", path: /^\/api\/v1\/users\/[^/]+$/, status: 404, body: notFound },
      {
        method: "GET", path: "/api/v1/users/00u1/devices",
        body: [{ device: { id: "guo1", status: "ACTIVE", profile: { displayName: "Bob's iPhone", platform: "IOS" } }, created: "2026-01-01T00:00:00.000Z" }],
      },
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "devices", "bob@x.com", "-j"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/users/00u1/devices");
    expect(JSON.parse(t.out.join(""))[0].device.id).toBe("guo1");
  });
});
