export const STARTER_REQUESTS: readonly string[] = [
  "Make me a page where I can track my daily water intake.",
  "I want a journal page where I can write a short entry each day and read old ones.",
  "Build me a reading list where I can add books and mark them as finished.",
  "Give me a dashboard that shows my tasks for today and how many are done.",
  "Make a tip calculator that splits a bill between friends.",
  "Build a reminder page where I can write things to do and tick them off.",
  "Make me a habit tracker with a grid of the last 30 days.",
  "I want a page to log my workouts and see my totals for the week.",
  "Build a recipe box where I can save my favourite recipes and search them.",
  "Make me a simple budget page that adds up what I spend each month.",
  "Create a page to keep notes about movies I want to watch.",
  "Build a countdown page for the dates I am looking forward to.",
];

function index(random: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

export function pickStarters(random: () => number, count = 3): string[] {
  const items = [...STARTER_REQUESTS];
  for (let i = items.length - 1; i > 0; i--) {
    const j = index(random, i + 1);
    [items[i], items[j]] = [items[j] as string, items[i] as string];
  }
  return items.slice(0, Math.max(0, Math.min(count, items.length)));
}
