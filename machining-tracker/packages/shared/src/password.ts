// Password policy shown in the UI. Supabase Auth enforces the same minimum (12) and character classes
// (supabase/config.toml: minimum_password_length, password_requirements = lower_upper_letters_digits).
export const PASSWORD_MIN_LENGTH = 12;

export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`At least ${PASSWORD_MIN_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push("A lower-case letter");
  if (!/[A-Z]/.test(password)) problems.push("An upper-case letter");
  if (!/[0-9]/.test(password)) problems.push("A digit");
  if (email) {
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    if (local.length >= 4 && password.toLowerCase().includes(local)) problems.push("Must not contain your email name");
  }
  return problems;
}
