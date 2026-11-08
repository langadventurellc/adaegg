import { describe, expect, it } from "vitest";
import { nextRun, parseCron } from "./cron.ts";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const next = (expr: string, after: Date) => nextRun(parseCron(expr), after);

describe("nextRun", () => {
  it("gives the next minute for * * * * *", () => {
    expect(next("* * * * *", at(2026, 1, 1, 10, 5))).toEqual(at(2026, 1, 1, 10, 6));
  });

  it("handles a daily time before, after and across a month end", () => {
    expect(next("17 3 * * *", at(2026, 1, 1, 2, 0))).toEqual(at(2026, 1, 1, 3, 17));
    expect(next("17 3 * * *", at(2026, 1, 1, 3, 17))).toEqual(at(2026, 1, 2, 3, 17));
    expect(next("17 3 * * *", at(2026, 1, 31, 4, 0))).toEqual(at(2026, 2, 1, 3, 17));
  });

  it("supports lists, ranges and steps", () => {
    expect(next("5,20,40 * * * *", at(2026, 1, 1, 10, 21))).toEqual(at(2026, 1, 1, 10, 40));
    expect(next("0 9-11 * * *", at(2026, 1, 1, 11, 0))).toEqual(at(2026, 1, 2, 9, 0));
    expect(next("*/15 * * * *", at(2026, 1, 1, 10, 16))).toEqual(at(2026, 1, 1, 10, 30));
    expect(next("*/15 * * * *", at(2026, 1, 1, 10, 46))).toEqual(at(2026, 1, 1, 11, 0));
    expect(next("10-40/10 * * * *", at(2026, 1, 1, 10, 11))).toEqual(at(2026, 1, 1, 10, 20));
    expect(next("10-40/10 * * * *", at(2026, 1, 1, 10, 40))).toEqual(at(2026, 1, 1, 11, 10));
  });

  it("accepts month and weekday names in any case", () => {
    expect(next("0 0 1 JAN *", at(2026, 3, 1))).toEqual(at(2027, 1, 1));
    expect(next("0 0 1 mar-may *", at(2026, 5, 1))).toEqual(at(2027, 3, 1));
    // 2026-01-05 is a Monday.
    expect(next("0 0 * * Mon", at(2026, 1, 1))).toEqual(at(2026, 1, 5));
    expect(next("0 0 * * fri", at(2026, 1, 1))).toEqual(at(2026, 1, 2));
  });

  it("treats 0 and 7 as Sunday", () => {
    // 2026-01-04 is a Sunday.
    expect(next("0 0 * * 0", at(2026, 1, 1))).toEqual(at(2026, 1, 4));
    expect(next("0 0 * * 7", at(2026, 1, 1))).toEqual(at(2026, 1, 4));
    expect(next("0 0 * * sun", at(2026, 1, 1))).toEqual(at(2026, 1, 4));
  });

  it("runs on either day field when both are restricted", () => {
    // 15th, or any Monday (2026-01-05 is a Monday).
    expect(next("0 0 15 * mon", at(2026, 1, 1))).toEqual(at(2026, 1, 5));
    expect(next("0 0 15 * mon", at(2026, 1, 12))).toEqual(at(2026, 1, 15));
  });

  it("needs only the restricted day field to match", () => {
    expect(next("0 0 15 * *", at(2026, 1, 1))).toEqual(at(2026, 1, 15));
    expect(next("0 0 * * mon", at(2026, 1, 6))).toEqual(at(2026, 1, 12));
    // `*/2` starts with `*`, so day of week is unrestricted and both must match.
    expect(next("0 0 10 * */2", at(2026, 1, 1))).toEqual(at(2026, 1, 10) /* a Saturday */);
  });

  it("returns null when no day exists", () => {
    expect(next("0 0 31 2 *", at(2026, 1, 1))).toBeNull();
  });

  it("is strictly after its input", () => {
    expect(next("30 10 * * *", at(2026, 1, 1, 10, 30))).toEqual(at(2026, 1, 2, 10, 30));
    const withSeconds = new Date(2026, 0, 1, 10, 29, 45, 500);
    expect(next("30 10 * * *", withSeconds)).toEqual(at(2026, 1, 1, 10, 30));
    const onMinuteWithSeconds = new Date(2026, 0, 1, 10, 30, 10);
    expect(next("30 10 * * *", onMinuteWithSeconds)).toEqual(at(2026, 1, 2, 10, 30));
  });
});

describe("parseCron errors", () => {
  it("names the field count", () => {
    expect(() => parseCron("* * * *")).toThrow("expected 5 fields, got 4");
  });

  it("names out of range fields", () => {
    expect(() => parseCron("60 * * * *")).toThrow("cron minute field '60': out of range 0-59");
    expect(() => parseCron("* 24 * * *")).toThrow("cron hour field '24': out of range 0-23");
    expect(() => parseCron("* * 0 * *")).toThrow("day of month");
    expect(() => parseCron("* * * 13 *")).toThrow("month field '13'");
    expect(() => parseCron("* * * * 8")).toThrow("day of week field '8'");
  });

  it("rejects non-numeric values, reversed ranges and bad steps", () => {
    expect(() => parseCron("a-b * * * *")).toThrow("cron minute field 'a-b'");
    expect(() => parseCron("* * * foo *")).toThrow("cron month field 'foo'");
    expect(() => parseCron("5-1 * * * *")).toThrow("cron minute field '5-1'");
    expect(() => parseCron("*/0 * * * *")).toThrow("cron minute field '*/0'");
    expect(() => parseCron("*/x * * * *")).toThrow("cron minute field '*/x'");
    expect(() => parseCron("5/10 * * * *")).toThrow("cron minute field '5/10'");
  });

  it("rejects macros", () => {
    expect(() => parseCron("@daily")).toThrow(/macros like @daily are not supported/);
  });
});
