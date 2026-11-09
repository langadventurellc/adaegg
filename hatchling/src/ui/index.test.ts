import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"), "utf8");

describe("index.html", () => {
  it("has the product title, a noscript notice, the app root and the module script", () => {
    expect(html).toContain("<title>Ada Egg</title>");
    expect(html).toMatch(/<noscript>[^<]*JavaScript[^<]*<\/noscript>/);
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('src="/src/ui/main.ts"');
  });
});
