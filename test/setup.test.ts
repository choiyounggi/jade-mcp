import { describe, expect, it } from "vitest";
import { buildConfig, DEFAULTS, generateFingerprint, isFingerprint } from "../src/setup.js";

describe("buildConfig", () => {
  it("fills defaults around the required answers", () => {
    const config = buildConfig({ companyCode: "1000", userId: "user", fingerprint: "1a2b3c" });
    expect(config).toEqual({
      baseUrl: DEFAULTS.baseUrl,
      companyCode: "1000",
      userId: "user",
      keychainService: DEFAULTS.keychainService,
      fingerprint: "1a2b3c",
      userAgent: DEFAULTS.userAgent,
    });
  });

  it("keeps previous values for blank answers", () => {
    const config = buildConfig({ companyCode: "", userId: "" }, { companyCode: "1000", userId: "old", fingerprint: "abc" });
    expect(config).toMatchObject({ companyCode: "1000", userId: "old", fingerprint: "abc" });
  });

  it("generates a fingerprint when none is given", () => {
    expect(isFingerprint(buildConfig({ companyCode: "1000", userId: "user" }).fingerprint)).toBe(true);
  });

  it("rejects a missing user id", () => {
    expect(() => buildConfig({ companyCode: "1000" })).toThrow("아이디");
  });

  it("rejects a non-https address", () => {
    expect(() => buildConfig({ baseUrl: "http://example.com", companyCode: "1", userId: "u" })).toThrow("https");
  });

  it("rejects a fingerprint that is not a browser hash", () => {
    expect(() => buildConfig({ companyCode: "1", userId: "u", fingerprint: "not-hex!" })).toThrow("핑거프린트");
  });
});

describe("generateFingerprint", () => {
  it("looks like getJadeFP output", () => {
    for (let i = 0; i < 20; i++) expect(isFingerprint(generateFingerprint())).toBe(true);
  });
});
