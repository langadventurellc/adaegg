import { NAMES, type NameEntry, REGIONS, type Region } from "./names.ts";

function index(random: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

export function pickSuggestions(random: () => number, count = 3, exclude: readonly string[] = []): NameEntry[] {
  const excluded = new Set(exclude.map((n) => n.toLowerCase()));
  const byRegion = new Map<Region, NameEntry[]>();
  for (const region of REGIONS) {
    const entries = NAMES.filter((e) => e.region === region && !excluded.has(e.name.toLowerCase()));
    if (entries.length > 0) byRegion.set(region, entries);
  }
  const picked: NameEntry[] = [];
  while (picked.length < count && byRegion.size > 0) {
    const regions = [...byRegion.keys()];
    const region = regions[index(random, regions.length)] as Region;
    const entries = byRegion.get(region) as NameEntry[];
    picked.push(entries[index(random, entries.length)] as NameEntry);
    byRegion.delete(region);
  }
  return picked;
}
