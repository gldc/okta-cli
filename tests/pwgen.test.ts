import { describe, expect, test } from "bun:test";
import { buildPassphrase, generatePassword } from "../src/lib/pwgen";

describe("pwgen", () => {
  test("generatePassword returns n words for en and de", () => {
    expect(generatePassword(4, "en").length).toBe(4);
    expect(generatePassword(2, "de").every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(generatePassword(3, "xx")).toEqual([]);
  });
  test("buildPassphrase grows until minLength like python loop", () => {
    expect(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 8)).toBe("aa bb cc");
    expect(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 12)).toBe("aa bb cc dd ee");
    expect(buildPassphrase(["aa", "bb", "cc", "dd"], 99)).toBe("aa bb cc");
  });
});
