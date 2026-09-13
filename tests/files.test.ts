import { describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { mapConcurrent } from "../src/lib/concurrency";
import { cellValue, csvReader, excelReader, fileReader } from "../src/lib/files";

// Builds a minimal, valid .xlsx (a zip of a few small OOXML parts) with one header row and one
// data row: "profile.login" -> "a@x", "profile.title" -> a blank cell. No dependency added —
// fflate is already installed as read-excel-file's own zip dependency.
function buildXlsx(): Uint8Array {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="str"><v>profile.login</v></c><c r="B1" t="str"><v>profile.title</v></c></row>
<row r="2"><c r="A2" t="str"><v>a@x</v></c><c r="B2"/></row>
</sheetData>
</worksheet>`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  }, { level: 0 });
}

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
    expect(await fileReader("testdata/mock_users_0010.csv", { jumpToUser: all[4]!["profile.login"] ?? undefined })).toEqual(all.slice(4));
  });
  test("excelReader keeps blank cells as null, not ''", async () => {
    const f = `${import.meta.dir}/tmp-blank.xlsx`;
    await Bun.write(f, buildXlsx());
    expect(await excelReader(f)).toEqual([{ "profile.login": "a@x", "profile.title": null }]);
  });
  test("cellValue formats Date as ISO 8601 and numbers/booleans via String()", () => {
    expect(cellValue(null)).toBeNull();
    expect(cellValue(undefined)).toBeNull();
    expect(cellValue(new Date("2024-01-15T00:00:00.000Z"))).toBe("2024-01-15T00:00:00.000Z");
    expect(cellValue(42)).toBe("42");
    expect(cellValue(true)).toBe("true");
    expect(cellValue("already a string")).toBe("already a string");
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
