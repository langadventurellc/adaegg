import { expect, test } from "vitest";
import { greeting } from "./greeting.js";

test("greeting names the project", () => {
  expect(greeting("demo")).toBe("Hello from demo");
});
