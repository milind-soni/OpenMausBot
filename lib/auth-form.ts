/** Sign-in and sign-up field checks: the same rules the server applies, shown under each field before submitting. */
export type AuthField = "name" | "email" | "password" | "workspaceName" | "slug";
export type AuthValues = Record<AuthField, string>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The message for one field, or "" when it is fine. */
export function authFieldError(field: AuthField, values: AuthValues, signup: boolean): string {
  const value = values[field];
  switch (field) {
    case "name": return value.trim() ? "" : "Enter your name";
    case "email": return !value.trim() ? "Enter your email" : emailPattern.test(value.trim()) ? "" : "Enter a valid email address";
    case "password": return !value ? signup ? "Choose a password" : "Enter your password" : signup && value.length < 10 ? "Use at least 10 characters" : "";
    case "workspaceName": return value.trim() ? "" : "Enter a workspace name";
    case "slug": return value.length >= 2 ? "" : "Use at least 2 characters";
  }
}

/** Every failing field of `fields`, in order. */
export function authFormErrors(fields: readonly AuthField[], values: AuthValues, signup: boolean) {
  const errors: Partial<Record<AuthField, string>> = {};
  for (const field of fields) {
    const message = authFieldError(field, values, signup);
    if (message) errors[field] = message;
  }
  return errors;
}

/** The field a server error is about, so it shows under that field instead of below the form. */
export function authFieldForServerError(message: string): AuthField | null {
  if (/workspace url/i.test(message)) return "slug";
  if (/^workspace name/i.test(message)) return "workspaceName";
  if (/a valid email|account already exists|email address on your invitation/i.test(message)) return "email";
  if (/password (between|must)|between 10 and 128/i.test(message)) return "password";
  if (/^enter your name/i.test(message)) return "name";
  return null;
}
