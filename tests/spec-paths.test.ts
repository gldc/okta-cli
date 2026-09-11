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
