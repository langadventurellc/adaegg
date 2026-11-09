import { fileURLToPath } from "node:url";
import { countCommits, scanHistory } from "./public-scan.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const findings = scanHistory(root);

for (const f of findings) console.log(`${f.source}: ${f.rule} ${f.sample}`);
if (findings.length === 0) {
  console.log(`history is clean (${countCommits(root)} commits scanned)`);
} else {
  console.log(`${findings.length} finding(s) in history`);
  process.exitCode = 1;
}
