import { describe, it, expect } from "vitest";
import {
  normalizeInstagramHandle,
  isValidInstagramHandle,
  instagramProfileUrl,
} from "./instagram";

describe("normalizeInstagramHandle", () => {
  it("returns null for empty, whitespace, null, and undefined", () => {
    expect(normalizeInstagramHandle("")).toBeNull();
    expect(normalizeInstagramHandle("   ")).toBeNull();
    expect(normalizeInstagramHandle(null)).toBeNull();
    expect(normalizeInstagramHandle(undefined)).toBeNull();
  });

  it("strips a leading @ and surrounding whitespace", () => {
    expect(normalizeInstagramHandle("  @storyjammic ")).toBe("storyjammic");
  });

  it("leaves a bare handle unchanged, including underscores and periods", () => {
    expect(normalizeInstagramHandle("__playspace__")).toBe("__playspace__");
    expect(normalizeInstagramHandle("courtney.black")).toBe("courtney.black");
  });

  it("extracts the handle from a profile URL", () => {
    expect(
      normalizeInstagramHandle("https://www.instagram.com/skintag_openmic/"),
    ).toBe("skintag_openmic");
    expect(normalizeInstagramHandle("instagram.com/storyjammic?hl=en")).toBe(
      "storyjammic",
    );
  });

  it("returns invalid input as-is (validation is a separate step)", () => {
    expect(normalizeInstagramHandle("my handle")).toBe("my handle");
  });
});

describe("isValidInstagramHandle", () => {
  it("accepts 1-30 letters, digits, periods, underscores", () => {
    expect(isValidInstagramHandle("a")).toBe(true);
    expect(isValidInstagramHandle("a".repeat(30))).toBe(true);
  });

  it("rejects @, spaces, URLs, and 31+ chars", () => {
    expect(isValidInstagramHandle("@a")).toBe(false);
    expect(isValidInstagramHandle("a b")).toBe(false);
    expect(isValidInstagramHandle("instagram.com/a")).toBe(false);
    expect(isValidInstagramHandle("a".repeat(31))).toBe(false);
  });
});

describe("instagramProfileUrl", () => {
  it("builds the canonical profile URL", () => {
    expect(instagramProfileUrl("storyjammic")).toBe(
      "https://www.instagram.com/storyjammic/",
    );
  });
});
