import { describe, expect, test } from "bun:test";
import { buildPassphrase, generatePassword } from "../src/lib/pwgen";

describe("pwgen", () => {
  test("generatePassword returns n words for en and de", () => {
    expect(generatePassword(4, "en").length).toBe(4);
    expect(generatePassword(2, "de").every((w) => typeof w === "string" && w.length > 0)).toBe(true);
    expect(generatePassword(3, "xx")).toEqual([]);
  });
  test("buildPassphrase grows until minLength, joining all words if unreachable and never empty (ignoring the trailing digit)", () => {
    const strip = (pw: string) => pw.replace(/\d$/, "");
    expect(strip(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 8))).toBe("Aa bb cc");
    // The trailing digit counts toward minLength, so this now stops one word earlier than before.
    expect(strip(buildPassphrase(["aa", "bb", "cc", "dd", "ee", "ff"], 12))).toBe("Aa bb cc dd");
    // Unreachable target: joins every word, including the last one (previously dropped).
    expect(strip(buildPassphrase(["aa", "bb", "cc", "dd"], 99))).toBe("Aa bb cc dd");
    // Exactly 3 (or fewer) words: previously returned "" since the loop never ran.
    expect(strip(buildPassphrase(["aa", "bb", "cc"], 8))).toBe("Aa bb cc");
    expect(strip(buildPassphrase(["aa", "bb"], 8))).toBe("Aa bb");
  });
  test("buildPassphrase satisfies Okta's default password policy: uppercase first letter, trailing digit, min length", () => {
    const cases: [string[], number][] = [
      [["aa", "bb", "cc", "dd", "ee", "ff"], 8],
      [["aa", "bb", "cc", "dd", "ee", "ff"], 12],
      [["aa", "bb", "cc", "dd"], 99],
      [["aa", "bb", "cc"], 8],
      [["aa", "bb"], 8],
    ];
    for (const [words, minLength] of cases) {
      const pw = buildPassphrase(words, minLength);
      expect(pw).toMatch(/^[A-Z]/);
      expect(pw).toMatch(/\d$/);
      expect(pw.length).toBeGreaterThanOrEqual(Math.min(minLength, words.join(" ").length + 1));
    }
  });
});
