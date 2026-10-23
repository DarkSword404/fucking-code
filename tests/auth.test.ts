import { describe, expect, test } from "vitest";
import {
  hashPassword,
  hashSessionToken,
  newSessionToken,
  safeEqual,
  verifyPassword,
} from "../apps/api/src/password.js";

describe("password hashing", () => {
  test("verifies the original password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
    expect(verifyPassword("", null)).toBe(false);
  });

  test("produces a different hash for the same password (random salt)", () => {
    expect(hashPassword("same-password")).not.toBe(hashPassword("same-password"));
  });
});

describe("session tokens", () => {
  test("are opaque and hash deterministically", () => {
    const token = newSessionToken();
    expect(token.length).toBeGreaterThan(30);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(token);
  });

  test("constant-time comparison works", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
