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
