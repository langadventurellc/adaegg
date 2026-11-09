#!/usr/bin/env node
import { existsSync } from "node:fs";

const installer = new URL("../dist/installer/main.js", import.meta.url);
if (!existsSync(installer)) {
  process.stderr.write("adaegg: the installer is not built yet. Run `pnpm build` first.\n");
  process.exit(1);
}

const { main } = await import(installer.href);
await main();
