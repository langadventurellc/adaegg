// A small crontab(5) expression parser and next-run search. Pure, no dependency.

export type CronSchedule = {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  // 0 to 6, Sunday is 0 (7 is folded into 0).
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldSpec = { label: string; min: number; max: number; names?: string[]; nameBase?: number };

const MINUTE: FieldSpec = { label: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { label: "hour", min: 0, max: 23 };
const DOM: FieldSpec = { label: "day of month", min: 1, max: 31 };
const MONTH: FieldSpec = { label: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 };
const DOW: FieldSpec = { label: "day of week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 };

function parseValue(spec: FieldSpec, text: string, whole: string): number {
  const fail = (why: string): never => {
    throw new Error(`cron ${spec.label} field '${whole}': ${why}`);
  };
  let value: number;
  if (/^\d+$/.test(text)) {
    value = Number(text);
  } else {
    const index = spec.names?.indexOf(text.toLowerCase()) ?? -1;
    if (index < 0) return fail(`'${text}' is not a number${spec.names ? " or name" : ""}`);
    value = index + (spec.nameBase ?? 0);
  }
  if (value < spec.min || value > spec.max) return fail(`out of range ${spec.min}-${spec.max}`);
  return value;
}

function parseField(spec: FieldSpec, text: string): number[] {
  const fail = (why: string): never => {
    throw new Error(`cron ${spec.label} field '${text}': ${why}`);
  };
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (part === "") return fail("empty list item");
    const pieces = part.split("/");
    if (pieces.length > 2) return fail("too many '/'");
    const [base, stepText] = pieces as [string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return fail(`step '${stepText}' is not a number`);
      step = Number(stepText);
      if (step === 0) return fail("step must be at least 1");
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes("-")) {
      const ends = base.split("-");
      const [from, to] = ends;
      if (ends.length !== 2 || from === undefined || to === undefined) return fail(`bad range '${base}'`);
      lo = parseValue(spec, from, text);
      hi = parseValue(spec, to, text);
      if (lo > hi) return fail(`reversed range '${base}'`);
    } else {
      lo = parseValue(spec, base, text);
      // "n/step" is not crontab syntax: steps follow `*` or a range.
      if (stepText !== undefined) return fail("a step needs '*' or a range before it");
      hi = lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim();
  if (trimmed.startsWith("@")) {
    throw new Error(`cron expression '${trimmed}': macros like @daily are not supported; use five fields`);
  }
  const fields = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression '${trimmed}': expected 5 fields, got ${fields.length}`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const days = parseField(DOW, dow).map((d) => (d === 7 ? 0 : d));
  return {
    minutes: parseField(MINUTE, minute),
    hours: parseField(HOUR, hour),
    daysOfMonth: parseField(DOM, dom),
    months: parseField(MONTH, month),
    daysOfWeek: [...new Set(days)].sort((a, b) => a - b),
    domRestricted: !dom.startsWith("*"),
    dowRestricted: !dow.startsWith("*"),
  };
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const domOk = schedule.daysOfMonth.includes(date.getDate());
  const dowOk = schedule.daysOfWeek.includes(date.getDay());
  return schedule.domRestricted && schedule.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

const MINUTE_MS = 60_000;

// Move to `target` (a jump forward), or one minute on if DST made it not move forward.
function advance(cursor: Date, target: Date): Date {
  return target.getTime() > cursor.getTime() ? target : new Date(cursor.getTime() + MINUTE_MS);
}

export function nextRun(schedule: CronSchedule, after: Date): Date | null {
  const limit = new Date(
    after.getFullYear() + 5,
    after.getMonth(),
    after.getDate(),
    after.getHours(),
    after.getMinutes(),
  ).getTime();
  // The minute containing `after`, plus one: strictly after it.
  let cursor = new Date(after.getTime() - after.getSeconds() * 1000 - after.getMilliseconds() + MINUTE_MS);

  while (cursor.getTime() <= limit) {
    const y = cursor.getFullYear();
    const mo = cursor.getMonth();
    const d = cursor.getDate();
    const h = cursor.getHours();
    const mi = cursor.getMinutes();
    if (!schedule.months.includes(mo + 1)) {
      cursor = advance(cursor, new Date(y, mo + 1, 1));
    } else if (!dayMatches(schedule, cursor)) {
      cursor = advance(cursor, new Date(y, mo, d + 1));
    } else if (!schedule.hours.includes(h)) {
      cursor = advance(cursor, new Date(y, mo, d, h + 1));
    } else {
      const minute = schedule.minutes.find((m) => m >= mi);
      if (minute === undefined) {
        cursor = advance(cursor, new Date(y, mo, d, h + 1));
      } else {
        return new Date(cursor.getTime() + (minute - mi) * MINUTE_MS);
      }
    }
  }
  return null;
}
