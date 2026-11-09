# Onboarding names

Onboarding asks the user to name their hatchling and suggests a few names, each from a person who made an important contribution to AI, information theory, computer science, philosophy, post-modern thought, poetry or literature.

## Where it lives

- `src/names/names.ts`: the types (`Region`, `Field`, `NameEntry`) and the list `NAMES`.
- `src/names/suggest.ts`: `pickSuggestions`, the picker.
- `src/names/validate.ts`: `validateName`, which cleans and checks a typed name.

All three are browser-safe: no `node:` imports and no dependencies.

## Rules the tests enforce

`src/names/names.test.ts` checks the real list, and checks that each rule reports a fabricated bad list:

- at least 80 entries, and every `name` unique after lowercasing and stripping diacritics;
- no name "Ada" and no `person` beginning with the word "Ada";
- every entry has a `person`, a `knownFor` of 1 to 90 characters, and a valid `region`, `gender` and `field`;
- women and men are each 40% to 60% of the list;
- no region above 20% of the entries, western Europe at most 15%, and at least 9 regions with 2 or more entries;
- at least 6 entries in each field;
- distinctive names: none is a very common first name;
- every `name` passes `validateName` unchanged.

## How the picker chooses

`pickSuggestions(random, count = 3, exclude = [])` picks a region first, uniformly among the regions that still have an unexcluded entry, then an entry uniformly within that region. A region with many entries is therefore not over-represented. A batch holds at most one entry per region, so when `count` exceeds the number of available regions it returns one per region. Names in `exclude` (names the user already rejected) are never returned; they are compared case-insensitively. It returns `[]` when everything is excluded or `count` is 0 or less. `random` is injected so tests are deterministic with a seeded generator (`src/names/suggest.test.ts`); the UI passes `Math.random`.

## Adding a person

Add an entry to `NAMES` in `src/names/names.ts`, with a `knownFor` of at most 90 characters that you can state correctly (leave the person out if you are unsure). Pick the region where the person's heritage and work are rooted. Then run the tests: the balance test must still pass, so a new western European entry may need a balancing entry elsewhere.

## Why "Ada" is never suggested

The user is asked to name their hatchling. Ada is the name of the system's own agent, so onboarding never offers it. `validateName` still accepts "Ada" if the user types it.
