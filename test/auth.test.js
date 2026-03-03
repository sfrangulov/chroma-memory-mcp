import { describe, it, expect } from "vitest";
import { extractUserEmail } from "../lib/auth.js";

describe("extractUserEmail", () => {
  it("extracts email from auth info", () => {
    const email = extractUserEmail({ email: "user@company.com", token: "t" });
    expect(email).toBe("user@company.com");
  });

  it("returns null if no auth info", () => {
    expect(extractUserEmail(undefined)).toBeNull();
  });

  it("returns null if auth info has no email", () => {
    expect(extractUserEmail({})).toBeNull();
  });

  it("returns null for null auth info", () => {
    expect(extractUserEmail(null)).toBeNull();
  });
});
