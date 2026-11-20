import { describe, expect, it } from "vitest";
import {
  csvTable,
  delimiterName,
  detectHeader,
  filterRowIndexes,
  isNumeric,
  parseCsv,
  sniffDelimiter,
  sortRowIndexes,
} from "../src/lib/formats/csv";

describe("csv: RFC 4180 parsing", () => {
  it("splits fields and records", () => {
    expect(parseCsv("a,b,c\n1,2,3").rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles CRLF, CR, a final line break and blank lines", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\rb\r").rows).toEqual([["a"], ["b"]]);
    const r = parseCsv("a\n\n\nb\n");
    expect(r.rows).toEqual([["a"], ["b"]]);
    expect(r.lines).toEqual([1, 4]);
  });

  it("reads quoted fields with delimiters, escaped quotes and line breaks", () => {
    const r = parseCsv('name,quote\n"Lovelace, Ada","She said ""hi"""\n"multi\r\nline",x\nlast,"\n"');
    expect(r.rows).toEqual([
      ["name", "quote"],
      ["Lovelace, Ada", 'She said "hi"'],
      ["multi\nline", "x"],
      ["last", "\n"],
    ]);
    expect(r.lines).toEqual([1, 2, 3, 5]);
    expect(r.issues).toEqual([]);
  });

  it("keeps empty fields, including trailing ones", () => {
    expect(parseCsv('a,,c,\n,"",,').rows).toEqual([
      ["a", "", "c", ""],
      ["", "", "", ""],
    ]);
  });

  it("is lenient with stray quotes and reports an unterminated one", () => {
    expect(parseCsv('a"b,c\n"x"y,z').rows).toEqual([
      ['a"b', "c"],
      ["xy", "z"],
    ]);
    const bad = parseCsv('a,b\n1,"open\n2,3');
    expect(bad.issues).toEqual([{ line: 2, message: "Unterminated quoted field" }]);
    expect(bad.rows[1]).toEqual(["1", "open\n2,3"]);
  });

  it("drops a leading BOM and keeps spaces", () => {
    expect(parseCsv("\uFEFFa, b \n1,2").rows[0]).toEqual(["a", " b "]);
  });

  it("parses other delimiters", () => {
    expect(parseCsv("a;b\n1;2", ";").rows[1]).toEqual(["1", "2"]);
    expect(parseCsv("a\tb\n1\t2", "\t").rows[1]).toEqual(["1", "2"]);
    expect(parseCsv('a|"b|c"', "|").rows[0]).toEqual(["a", "b|c"]);
  });
});

describe("csv: sniffing", () => {
  it("picks the delimiter that splits rows consistently", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
    expect(sniffDelimiter("name;price\nApple;1,50\nPear;2,10")).toBe(";");
    expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(sniffDelimiter("a|b|c\n1|2|3")).toBe("|");
    // Commas inside quotes do not count.
    expect(sniffDelimiter('"a,b";c\n"d,e";f')).toBe(";");
    expect(sniffDelimiter("just text\nno delimiters")).toBeNull();
  });

  it("prefers tab for TSV when it ties", () => {
    expect(sniffDelimiter("a,b\tc\n1,2\t3", true)).toBe("\t");
    expect(sniffDelimiter("a,b\tc\n1,2\t3")).toBe(",");
  });

  it("guesses the header row", () => {
    expect(
      detectHeader([
        ["name", "age"],
        ["Ada", "36"],
        ["Alan", "41"],
      ]),
    ).toBe(true);
    expect(
      detectHeader([
        ["1", "2"],
        ["3", "4"],
      ]),
    ).toBe(false);
    expect(
      detectHeader([
        ["name", ""],
        ["a", "b"],
      ]),
    ).toBe(false);
    expect(
      detectHeader([
        ["a", "a"],
        ["b", "c"],
      ]),
    ).toBe(false);
    expect(
      detectHeader([
        ["2026-01-01", "x"],
        ["2026-01-02", "y"],
      ]),
    ).toBe(false);
    // All text: a header when its values do not repeat below.
    expect(
      detectHeader([
        ["city", "country"],
        ["Paris", "France"],
      ]),
    ).toBe(true);
    expect(
      detectHeader([
        ["yes", "no"],
        ["yes", "yes"],
      ]),
    ).toBe(false);
    expect(detectHeader([["only"]])).toBe(true);
    expect(detectHeader([])).toBe(false);
  });

  it("recognizes numbers", () => {
    for (const n of ["1", "-2.5", "1,5", "1e3", ".5", "42%"]) expect(isNumeric(n), n).toBe(true);
    for (const s of ["", "abc", "1.2.3", "1 000"]) expect(isNumeric(s), s).toBe(false);
  });
});

describe("csv: table, sort and filter", () => {
  const text = "name,score,city\nAda,10,London\nalan,9,\nGrace,100,New York\nBob,x2,Paris\n";

  it("shapes a table with columns, padded rows and ragged rows", () => {
    const t = csvTable("a,b\n1,2,3\n4\n5,6");
    expect(t.hasHeader).toBe(true);
    expect(t.columns).toEqual(["a", "b", "Column 3"]);
    expect(t.rows).toEqual([
      ["1", "2", "3"],
      ["4", "", ""],
      ["5", "6", ""],
    ]);
    expect(t.raw).toEqual([3, 1, 2]);
    expect(t.ragged).toEqual([2, 3]);
    expect(t.fields).toBe(2);
    expect(t.lines).toEqual([2, 3, 4]);
    const noHeader = csvTable("1,2\n3,4", { header: false });
    expect(noHeader.columns).toEqual(["Column 1", "Column 2"]);
    expect(noHeader.rows.length).toBe(2);
    expect(csvTable("a\tb\n1\t2", { preferTab: true }).delimiter).toBe("\t");
    expect(delimiterName(";")).toBe("semicolon");
  });

  it("sorts numbers numerically, text naturally, empty cells last", () => {
    const t = csvTable(text);
    const names = (idx: number[]) => idx.map((i) => t.rows[i]![0]);
    expect(names(sortRowIndexes(t.rows, 1, "asc"))).toEqual(["alan", "Ada", "Grace", "Bob"]);
    expect(names(sortRowIndexes(t.rows, 0, "asc"))).toEqual(["Ada", "alan", "Bob", "Grace"]);
    expect(names(sortRowIndexes(t.rows, 0, "desc"))).toEqual(["Grace", "Bob", "alan", "Ada"]);
    expect(names(sortRowIndexes(t.rows, 2, "desc"))).toEqual(["Bob", "Grace", "Ada", "alan"]);
    expect(sortRowIndexes([["a10"], ["a2"], ["a1"]], 0, "asc")).toEqual([2, 1, 0]);
    // Only the given rows, in sorted order.
    expect(sortRowIndexes(t.rows, 1, "asc", [0, 2])).toEqual([0, 2]);
  });

  it("filters rows on any cell, case-insensitively", () => {
    const t = csvTable(text);
    expect(filterRowIndexes(t.rows, "LONDON")).toEqual([0]);
    expect(filterRowIndexes(t.rows, "a")).toEqual([0, 1, 2, 3]);
    expect(filterRowIndexes(t.rows, "  ")).toEqual([0, 1, 2, 3]);
    expect(filterRowIndexes(t.rows, "zzz")).toEqual([]);
  });
});
