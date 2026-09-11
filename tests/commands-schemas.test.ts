import { afterEach, describe, expect, test } from "bun:test";
import { flattenSchemaProperties, schemaPropertyBody } from "../src/commands/schemas";
import { knownPath } from "../src/okta/spec-paths";
import { apps, standardRoutes } from "./fixtures/data";
import { runTest, testCtx } from "./fixtures/ctx";
import { startServer } from "./fixtures/server";

let srv: ReturnType<typeof startServer>;
afterEach(() => srv?.stop());

const notFound = { errorCode: "E0000007", errorSummary: "nf", errorCauses: [] };

const userSchema = {
  definitions: {
    base: {
      id: "#base",
      type: "object",
      properties: {
        login: { title: "Username", type: "string", required: true, mutability: "READ_ONLY", scope: "NONE" },
      },
    },
    custom: {
      id: "#custom",
      type: "object",
      properties: {
        abool: { title: "A Bool", type: "boolean", required: false, mutability: "READ_WRITE", scope: "NONE" },
        anint: { title: "An Int", type: "integer", required: false, mutability: "READ_WRITE", scope: "NONE" },
      },
    },
  },
};

test("spec paths", () => {
  for (const p of ["/meta/schemas/user/default", "/meta/schemas/group/default", "/meta/schemas/apps/0oa1/default", "/meta/schemas/user/linkedObjects", "/meta/schemas/user/linkedObjects/manager", "/users/00u1/linkedObjects/manager", "/users/00u1/linkedObjects/manager/00u2"]) {
    expect(knownPath(p), p).toBe(true);
  }
});

test("flattenSchemaProperties: base + custom rows, sorted by scope then name", () => {
  const rows = flattenSchemaProperties(userSchema);
  expect(rows).toEqual([
    { name: "login", scope: "base", type: "string", title: "Username", required: true, mutability: "READ_ONLY" },
    { name: "abool", scope: "custom", type: "boolean", title: "A Bool", required: false, mutability: "READ_WRITE" },
    { name: "anint", scope: "custom", type: "integer", title: "An Int", required: false, mutability: "READ_WRITE" },
  ]);
});

test("schemaPropertyBody with enum + array", () => {
  expect(schemaPropertyBody({ name: "color", type: "string", enum: "red,green,blue" })).toEqual({
    definitions: { custom: { id: "#custom", type: "object", properties: { color: {
      title: "color", type: "string", required: false, mutability: "READ_WRITE", scope: "NONE",
      permissions: [{ principal: "SELF", action: "READ_WRITE" }],
      enum: ["red", "green", "blue"], oneOf: [{ const: "red", title: "red" }, { const: "green", title: "green" }, { const: "blue", title: "blue" }],
    } } } },
  });
  expect(schemaPropertyBody({ name: "tags", type: "array", itemsType: "string", title: "Tags", required: true })).toEqual({
    definitions: { custom: { id: "#custom", type: "object", properties: { tags: {
      title: "Tags", type: "array", required: true, mutability: "READ_WRITE", scope: "NONE",
      permissions: [{ principal: "SELF", action: "READ_WRITE" }],
      items: { type: "string" },
    } } } },
  });
});

describe("schemas user", () => {
  test("get default schema", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/meta/schemas/user/default", body: userSchema }]);
    const t = testCtx(srv.url);
    await runTest(["schemas", "user", "get", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(userSchema);
  });

  test("properties flattens", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/meta/schemas/user/default", body: userSchema }]);
    const t = testCtx(srv.url);
    await runTest(["schemas", "user", "properties", "--output-fields", "name,scope"], t.ctx);
    expect(t.out.at(-1)).toBe("login  base    \nabool  custom  \nanint  custom  \n");
  });

  test("add-property posts merge body and returns flattened response", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/meta/schemas/user/default", body: userSchema }]);
    const t = testCtx(srv.url);
    await runTest(["schemas", "user", "add-property", "-n", "abool", "-t", "boolean", "--required", "--output-fields", "name,scope"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({
      definitions: { custom: { id: "#custom", type: "object", properties: { abool: {
        title: "abool", type: "boolean", required: true, mutability: "READ_WRITE", scope: "NONE",
        permissions: [{ principal: "SELF", action: "READ_WRITE" }],
      } } } },
    });
    expect(t.out.at(-1)).toBe("login  base    \nabool  custom  \nanint  custom  \n");
  });

  test("remove-property posts null body and returns message", async () => {
    srv = startServer([{ method: "POST", path: "/api/v1/meta/schemas/user/default", body: {} }]);
    const t = testCtx(srv.url);
    await runTest(["schemas", "user", "remove-property", "-n", "abool"], t.ctx);
    expect(srv.calls[0]!.body).toEqual({ definitions: { custom: { id: "#custom", type: "object", properties: { abool: null } } } });
    expect(t.out.at(-1)).toBe("custom property abool removed from schema default\n");
  });
});

describe("schemas group/app", () => {
  test("group get/properties", async () => {
    srv = startServer([{ method: "GET", path: "/api/v1/meta/schemas/group/default", body: userSchema }]);
    const t = testCtx(srv.url);
    await runTest(["schemas", "group", "get", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(userSchema);
    await runTest(["schemas", "group", "properties", "--output-fields", "name"], t.ctx);
    expect(t.out.at(-1)).toBe("login  \nabool  \nanint  \n");
  });

  test("app get/properties resolves app id", async () => {
    srv = startServer([
      { method: "GET", path: /^\/api\/v1\/apps\/[^/]+$/, status: 404, body: notFound },
      { method: "GET", path: "/api/v1/apps", body: apps },
      { method: "GET", path: "/api/v1/meta/schemas/apps/0oa2/default", body: userSchema },
    ]);
    const t = testCtx(srv.url);
    await runTest(["schemas", "app", "get", "slack", "-j"], t.ctx);
    expect(JSON.parse(t.out.at(-1)!)).toEqual(userSchema);
    await runTest(["schemas", "app", "properties", "slack", "--output-fields", "name"], t.ctx);
    expect(t.out.at(-1)).toBe("login  \nabool  \nanint  \n");
  });
});

describe("linked-objects", () => {
  test("list, add", async () => {
    const link = { primary: { name: "manager", title: "Manager", description: "d", type: "USER" }, associated: { name: "directReports", title: "Direct Reports", type: "USER" } };
    srv = startServer([
      { method: "GET", path: "/api/v1/meta/schemas/user/linkedObjects", body: [link] },
      { method: "POST", path: "/api/v1/meta/schemas/user/linkedObjects", body: link },
    ]);
    const t = testCtx(srv.url);
    await runTest(["linked-objects", "list", "--output-fields", "primary.name,associated.name"], t.ctx);
    expect(t.out.at(-1)).toBe("manager  directReports  \n");
    await runTest(["linked-objects", "add", "--primary-name", "manager", "--primary-title", "Manager", "--primary-description", "d", "--associated-name", "directReports", "--associated-title", "Direct Reports"], t.ctx);
    expect(srv.calls.at(-1)!.body).toEqual(link);
  });
});

describe("users linked/link/unlink", () => {
  test("linked returns raw _links, link PUTs, unlink DELETEs", async () => {
    srv = startServer([
      { method: "GET", path: "/api/v1/users/00u00000000000000001/linkedObjects/manager", body: [{ _links: { self: { href: "https://x/api/v1/users/00u2" } } }] },
      { method: "PUT", path: "/api/v1/users/00u00000000000000001/linkedObjects/manager/00u00000000000000002" },
      { method: "DELETE", path: "/api/v1/users/00u00000000000000001/linkedObjects/manager" },
      ...standardRoutes(),
    ]);
    const t = testCtx(srv.url);
    await runTest(["users", "linked", "bob@x.com", "manager", "--output-fields", "_links.self.href"], t.ctx);
    expect(t.out.at(-1)).toBe("https://x/api/v1/users/00u2  \n");
    await runTest(["users", "link", "bob@x.com", "--to", "alice@x.com", "--rel", "manager"], t.ctx);
    expect(srv.calls.at(-1)!.path).toBe("/api/v1/users/00u00000000000000001/linkedObjects/manager/00u00000000000000002");
    expect(t.out.at(-1)).toBe("user 00u00000000000000001 linked to 00u00000000000000002 via manager\n");
    await runTest(["users", "unlink", "bob@x.com", "manager"], t.ctx);
    expect(t.out.at(-1)).toBe("relationship manager removed from user 00u00000000000000001\n");
  });
});
