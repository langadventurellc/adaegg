export type NameValidation = { ok: true; name: string } | { ok: false; error: string };

const MAX_LENGTH = 40;
const ALLOWED = /^[\p{L}\p{M}\p{Nd} '’.-]+$/u;

export function validateName(raw: string): NameValidation {
  const name = raw.trim().replace(/[^\S\r\n]+/g, " ");
  if (name === "") return { ok: false, error: "Enter a name." };
  if (!/^\p{L}/u.test(name)) return { ok: false, error: "Start the name with a letter." };
  if (!ALLOWED.test(name)) {
    return { ok: false, error: "Use only letters, numbers, spaces and the characters ' ’ - ." };
  }
  if ([...name].length > MAX_LENGTH) {
    return { ok: false, error: `Use ${MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, name };
}
