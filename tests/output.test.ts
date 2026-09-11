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
