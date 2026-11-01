import { describe, expect, it } from "vitest";
import { authFieldError, authFieldForServerError, authFormErrors, type AuthValues } from "./auth-form";

const values = (patch: Partial<AuthValues> = {}): AuthValues => ({ name: "Ada", email: "ada@example.com", password: "long-enough-1", workspaceName: "Acme", slug: "acme", ...patch });

describe("auth form fields", () => {
  it("accepts a complete sign-up", () => {
    expect(authFormErrors(["name", "email", "password", "workspaceName", "slug"], values(), true)).toEqual({});
  });
  it("names each empty required field", () => {
    const empty = values({ name: " ", email: "", password: "", workspaceName: "", slug: "" });
    expect(authFormErrors(["name", "email", "password", "workspaceName", "slug"], empty, true)).toEqual({
      name: "Enter your name", email: "Enter your email", password: "Choose a password", workspaceName: "Enter a workspace name", slug: "Use at least 2 characters",
    });
    expect(authFieldError("password", empty, false)).toBe("Enter your password");
  });
  it("checks the email format and the sign-up password length", () => {
    expect(authFieldError("email", values({ email: "ada@example" }), true)).toBe("Enter a valid email address");
    expect(authFieldError("password", values({ password: "short" }), true)).toBe("Use at least 10 characters");
    // Sign-in takes any password; the server answers for wrong ones.
    expect(authFieldError("password", values({ password: "short" }), false)).toBe("");
  });
  it("maps server errors to their field", () => {
    expect(authFieldForServerError("That workspace URL is already taken")).toBe("slug");
    expect(authFieldForServerError("Choose a different workspace URL (at least 2 characters)")).toBe("slug");
    expect(authFieldForServerError("Workspace name must be between 1 and 60 characters")).toBe("workspaceName");
    expect(authFieldForServerError("An account already exists. Sign in instead.")).toBe("email");
    expect(authFieldForServerError("Enter a valid email address")).toBe("email");
    expect(authFieldForServerError("Use a password between 10 and 128 characters")).toBe("password");
    expect(authFieldForServerError("Enter your name")).toBe("name");
    expect(authFieldForServerError("Invalid email or password")).toBeNull();
    expect(authFieldForServerError("Too many signup attempts. Try again in 15 minutes.")).toBeNull();
  });
});
