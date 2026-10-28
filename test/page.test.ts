import { describe, expect, it } from "vitest";
import { inputValue, otpToken, PageStructureError, parsePage } from "../src/page.js";
import { loginHtml, mainHtml } from "./fixtures.js";

describe("parsePage", () => {
  it("reads security vars, Page props, OTP maps and hidden inputs from a main screen", () => {
    const ctx = parsePage(mainHtml("A"));
    expect(ctx.openTime).toBe("2000A");
    expect(ctx.otpKey).toBe("otp-A");
    expect(ctx.csrfSalt).toBe("salt-A");
    expect(ctx.hasMaskingVars).toBe(true);
    expect(ctx.page).toMatchObject({ C_CD: "2202010", PGM_ID: "main_A", ENC_T: "", PGM_URL: "/main.jsp" });
    expect(otpToken(ctx, "hunelOtpVal", "getMainInfo")).toBe("tok-getMainInfo-A");
    expect(inputValue(ctx, "S_DSCLASS")).toBe("cls-main-A");
  });

  it("parses the login screen, which has no Page object and an empty OTP key", () => {
    const ctx = parsePage(loginHtml());
    expect(ctx.otpKey).toBe("");
    expect(ctx.csrfSalt).toBe("null");
    expect(ctx.page).toEqual({});
    expect(ctx.hasMaskingVars).toBe(false);
    expect(ctx.inputs.S_NO_LOGIN_CHECK).toBe("Y");
  });

  it("fails closed when the security vars are missing", () => {
    expect(() => parsePage("<html>error page</html>")).toThrow(PageStructureError);
  });

  it("fails closed when a needed token or input is absent or empty", () => {
    const ctx = parsePage(mainHtml());
    expect(() => otpToken(ctx, "hunelOtpVal", "saveSchedule")).toThrow(PageStructureError);
    expect(() => otpToken(ctx, "ApplyOtpVal", "apply01")).toThrow(PageStructureError);
    expect(() => inputValue(ctx, "S_PWD")).toThrow(PageStructureError);
  });
});
