import { describe, expect, test } from "bun:test";
import { buildPassphrase, generatePassword } from "../src/lib/pwgen";

describe("pwgen", () => {
  test("generatePassword returns n words for en and de", () => {
    expect(generatePassword(4, "en").length).toBe(4);
    expect(generatePassword(2, "de").every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(generatePassword(3, "xx")).toEqual([]);
  });
  test("buildPassphrase grows until minLength, joining all words if unreachable and never empty", () => {
    expect(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 8)).toBe("aa bb cc");
    expect(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 12)).toBe("aa bb cc dd ee");
    // Unreachable target: joins every word, including the last one (previously dropped).
    expect(buildPassphrase(["aa", "bb", "cc", "dd"], 99)).toBe("aa bb cc dd");
    // Exactly 3 (or fewer) words: previously returned "" since the loop never ran.
    expect(buildPassphrase(["aa", "bb", "cc"], 8)).toBe("aa bb cc");
    expect(buildPassphrase(["aa", "bb"], 8)).toBe("aa bb");
  });
});
