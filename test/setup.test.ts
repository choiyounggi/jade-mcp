import { describe, expect, it } from "vitest";
import { LoginError } from "../src/client.js";
import { buildConfig, canRetryPassword, DEFAULTS, generateFingerprint, isFingerprint, registrationTargets } from "../src/setup.js";

describe("canRetryPassword", () => {
  it("로그인 실패는 비밀번호를 다시 받아 본다", () => {
    expect(canRetryPassword(new LoginError("로그인 실패: 아이디 또는 비밀번호가 맞지 않습니다"))).toBe(true);
  });

  it("2차 인증·비밀번호 초기화 상태는 다시 넣어도 안 되므로 묻지 않는다", () => {
    expect(canRetryPassword(new LoginError("2차 인증이 켜진 계정이라 자동 로그인을 할 수 없다"))).toBe(false);
    expect(canRetryPassword(new LoginError("비밀번호 초기화 상태다 — 브라우저에서 비밀번호를 다시 설정해야 한다"))).toBe(false);
  });

  it("네트워크 오류처럼 로그인과 무관한 실패는 묻지 않는다", () => {
    expect(canRetryPassword(new Error("fetch failed"))).toBe(false);
    expect(canRetryPassword(new LoginError("로그인 사전 확인 실패: fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)"))).toBe(false);
    expect(canRetryPassword(new LoginError("로그인 뒤 메인 화면을 받지 못했다"))).toBe(false);
  });
});

describe("registrationTargets", () => {
  it("기본 설정에 등록한다", () => {
    expect(registrationTargets({})).toEqual([null]);
  });

  it("다른 설정 폴더를 쓰는 셸이면 그곳에도 등록한다", () => {
    expect(registrationTargets({ CLAUDE_CONFIG_DIR: "/Users/me/profiles/a/home" })).toEqual([null, "/Users/me/profiles/a/home"]);
  });

  it("CLAUDE_CONFIG_DIR 가 공백뿐이면 기본에만 등록한다", () => {
    expect(registrationTargets({ CLAUDE_CONFIG_DIR: "  " })).toEqual([null]);
  });
});

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
