import { describe, expect, test } from "bun:test";
import { mapConcurrent } from "../src/lib/concurrency";
import { csvReader, fileReader } from "../src/lib/files";

describe("files", () => {
  test("csvReader reads testdata with header", async () => {
    const rows = await csvReader("testdata/mock_users_one.csv");
    expect(rows.length).toBe(1);
    expect(rows[0]!["profile.login"]).toBeString();
  });
  test("csvReader auto-detects delimiter and drops trailing empty column", async () => {
    const f = `${import.meta.dir}/tmp-semicolon.csv`;
    await Bun.write(f, "profile.login;profile.firstName\na@x;A\n\n");
    expect(await csvReader(f)).toEqual([{ "profile.login": "a@x", "profile.firstName": "A" }]);
    await Bun.write(f, "profile.login,\na@x,\n");
    expect(await csvReader(f)).toEqual([{ "profile.login": "a@x" }]);
  });
  test("fileReader jump/limit", async () => {
    const all = await fileReader("testdata/mock_users_0010.csv");
    expect(all.length).toBe(10);
    expect(await fileReader("testdata/mock_users_0010.csv", { jumpToIndex: 8 })).toEqual(all.slice(8));
    expect(await fileReader("testdata/mock_users_0010.csv", { limit: 3 })).toEqual(all.slice(0, 3));
    expect(await fileReader("testdata/mock_users_0010.csv", { jumpToUser: all[4]!["profile.login"] })).toEqual(all.slice(4));
  });
});

describe("mapConcurrent", () => {
  test("keeps order, limits parallelism, reports progress", async () => {
    let active = 0, maxActive = 0;
    const progress: number[] = [];
    const rv = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5 * (6 - n)));
      active--; return n * 10;
    }, (done) => progress.push(done));
    expect(rv).toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });
});
