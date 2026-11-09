export type NameValidation = { ok: true; name: string } | { ok: false; error: string };

const MAX_LENGTH = 40;
const ALLOWED = /^[\p{L}\p{M}\p{N} '’.-]+$/u;

export function validateName(raw: string): NameValidation {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "Enter a name." };
  if (!/^\p{L}/u.test(trimmed)) return { ok: false, error: "Start the name with a letter." };
  if (!ALLOWED.test(trimmed)) {
    return { ok: false, error: "Use only letters, numbers, spaces and the characters ' ’ - ." };
  }
  const name = trimmed.replace(/ +/g, " ");
  if ([...name].length > MAX_LENGTH) {
    return { ok: false, error: `Use ${MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, name };
}
