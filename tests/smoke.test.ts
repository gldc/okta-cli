import { expect, test } from "bun:test";
import { VERSION } from "../src/version";

test("version is 19.0.0", () => {
  expect(VERSION).toBe("19.0.0");
});
