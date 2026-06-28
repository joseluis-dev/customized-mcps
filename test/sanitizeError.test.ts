import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage, sanitizeError } from "../src/security/sanitizeError.js";

describe("sanitizeErrorMessage", () => {
  it("replaces a ${secret:file:...} literal with a masked marker", () => {
    const msg = `Could not read ${"${secret:file:/run/secrets/db_pw}"} for profile "X"`;
    const out = sanitizeErrorMessage(msg);
    expect(out).not.toContain("/run/secrets/db_pw");
    expect(out).toContain("${secret:***}");
  });

  it("masks a DSN-style password= fragment", () => {
    const out = sanitizeErrorMessage("connect failed: Server=db;password=hunter2;");
    expect(out).toContain("password=***");
    expect(out).not.toContain("hunter2");
  });

  it("masks a URI with embedded credentials", () => {
    const out = sanitizeErrorMessage("dial tcp: lookup user:pass@db.example.com");
    expect(out).not.toContain("user:pass@");
    expect(out).toContain("***@");
  });
});

describe("sanitizeError", () => {
  it("preserves error name and masks the message", () => {
    const e = new Error(`oops ${"${secret:file:/etc/pw}"} happened`);
    const out = sanitizeError(e);
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain("/etc/pw");
  });
});
