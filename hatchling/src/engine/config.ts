import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  schema: z.literal(1),
  baseBranch: z.string().min(1).default("main"),
  checks: z.string().default("npm run check"),
  // An empty string skips the setup step.
  setup: z.string().default("npm ci"),
  checksTimeoutMinutes: z.number().positive().default(20),
  maxConcurrentRuns: z.number().int().positive().default(1),
  // Model aliases for the agent nodes, by the role a node names in its `model`.
  models: z
    .object({
      implement: z.string().default("sonnet"),
      review: z.string().default("sonnet"),
      chat: z.string().default("sonnet"),
    })
    .default({ implement: "sonnet", review: "sonnet", chat: "sonnet" }),
  // Port 0 means the OS picks a free port. 4747 avoids 3000, 4317 (OpenTelemetry), 5173 (Vite) and 8080.
  ui: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(0).max(65535).default(4747),
    })
    .default({ enabled: true, port: 4747 }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(root: string): Config {
  const file = join(root, "adaegg.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${file}: not valid JSON`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    throw new Error(`invalid ${file}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
