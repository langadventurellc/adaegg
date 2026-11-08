import { describe, expect, it } from "vitest";
import { PlanSchema } from "./plan.ts";

const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  title: `Title ${key}`,
  contents: "Do it",
  ...over,
});

describe("PlanSchema", () => {
  it("parses a chain and an independent item, applying defaults", () => {
    const plan = PlanSchema.parse({
      items: [item("a"), item("b", { dependsOn: ["a"] }), item("c")],
    });
    expect(plan.summary).toBe("");
    expect(plan.items.map((i) => i.dependsOn)).toEqual([[], ["a"], []]);
  });

  it("accepts an empty list and 8 items", () => {
    expect(PlanSchema.safeParse({ summary: "done", items: [] }).success).toBe(true);
    const eight = Array.from({ length: 8 }, (_, i) => item(`k${i}`));
    expect(PlanSchema.safeParse({ items: eight }).success).toBe(true);
  });

  const rejected: [string, unknown, string?][] = [
    ["duplicate keys", { items: [item("a"), item("a")] }, 'duplicate key "a"'],
    [
      "an unknown dependsOn",
      { items: [item("a", { dependsOn: ["z"] })] },
      'item "a" depends on "z", which is not an earlier item',
    ],
    [
      "a forward dependsOn",
      { items: [item("a", { dependsOn: ["b"] }), item("b")] },
      'item "a" depends on "b", which is not an earlier item',
    ],
    [
      "a self-dependency",
      { items: [item("a", { dependsOn: ["a"] })] },
      'item "a" depends on "a", which is not an earlier item',
    ],
    ["9 items", { items: Array.from({ length: 9 }, (_, i) => item(`k${i}`)) }],
    ["an empty title", { items: [item("a", { title: "" })] }],
    ["a 121-character title", { items: [item("a", { title: "x".repeat(121) })] }],
    ["empty contents", { items: [item("a", { contents: "" })] }],
    ["an uppercase key", { items: [item("Bad_Key")] }],
    ["a leading dash", { items: [item("-a")] }],
  ];
  it.each(rejected)("rejects %s", (_name, input, message) => {
    const result = PlanSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (message && !result.success) expect(result.error.issues[0]?.message).toBe(message);
  });

  it("puts relational issues on items", () => {
    const result = PlanSchema.safeParse({ items: [item("a"), item("a")] });
    expect(!result.success && result.error.issues[0]?.path).toEqual(["items"]);
  });
});
