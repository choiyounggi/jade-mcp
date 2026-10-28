import { describe, expect, it } from "vitest";
import { PageStructureError, parsePage } from "../src/page.js";
import { decide, ipCheck, parsePopupTokens, PunchBlockedError } from "../src/punch.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");

// 실제 출퇴근 팝업의 호출 배치만 본뜬 합성 HTML
function popupHtml(opts: { save?: string; sameTokens?: boolean } = {}): string {
  const t = opts.sameTokens ? () => tok("Same") : tok;
  return `<script>
var S_PGM_OPEN_TIME = "1"; var S_ENC_OTP_KEY = "k"; var S_CSRF_SALT = "s";
var SIP = "10.0.0.5";
YE_DAY_OUT_YMDHM_INSERT = "Y";
function LoadPage() {
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Device")}", { S_EMP_ID : "", S_YMD : "" }, function(xs) {
    if( xs.GetCellValue(0, "USE_DEVICE_CD").indexOf("20") == -1 ) {}
  });
}
function doAction(sAction) { switch(sAction) {
  case "${t("Save")}" : {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Time")}", {}, function(xs)
    {
      oracleYmd = xs.GetCellValue(0, "ORACLE_YMD");
    });
    ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Validate")}", serializeForm(), function(xs)
    {
      if(  xs.GetEtcData("ALERT_MSG")  ) {}
    });
  }
  case "${t("IpList")}" : {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), {S_STD_YMD : 1}, function(xs) {
      ipCheckYn.push(xs.GetCellValue(i, "IP_CHECK_YN"));
    });
  }
}}
</script>
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="${tok("Class")}" />
${opts.save === undefined ? `<input type="button" value="저장" onclick="doAction('${t("Save")}');" />` : opts.save}`;
}

describe("parsePopupTokens", () => {
  it("maps each call to its token by the surrounding code structure", () => {
    const html = popupHtml();
    const t = parsePopupTokens(html, parsePage(html));
    expect(t).toMatchObject({
      dsClass: tok("Class"),
      device: tok("Device"),
      serverTime: tok("Time"),
      validate: tok("Validate"),
      ipList: tok("IpList"),
      save: tok("Save"),
      yesterdayOutInsert: "Y",
      sip: "10.0.0.5",
    });
  });

  it("fails closed when the save button is missing", () => {
    const html = popupHtml({ save: "" });
    expect(() => parsePopupTokens(html, parsePage(html))).toThrow(PageStructureError);
  });

  it("fails closed when tokens cannot be told apart", () => {
    const html = popupHtml({ sameTokens: true });
    expect(() => parsePopupTokens(html, parsePage(html))).toThrow(PageStructureError);
  });
});

describe("ipCheck", () => {
  it("allows a listed IP and keeps it when IP_SAVE_YN=Y", () => {
    expect(ipCheck([{ IP_CHECK_YN: "Y", IP_SAVE_YN: "Y", IP_ADDR: "10.0.0.5,10.0.0.6" }], "10.0.0.5")).toEqual({
      allowed: true,
      saveIp: "10.0.0.5",
    });
  });

  it("matches wildcard patterns", () => {
    expect(ipCheck([{ IP_CHECK_YN: "Y", IP_ADDR: "10.0.*.*" }], "10.0.9.9").allowed).toBe(true);
  });

  it("rejects an IP outside the list", () => {
    expect(ipCheck([{ IP_CHECK_YN: "Y", IP_SAVE_YN: "N", IP_ADDR: "10.0.0.6" }], "192.168.0.1")).toEqual({
      allowed: false,
      saveIp: "",
    });
  });

  it("rejects when there are no rules at all", () => {
    expect(ipCheck([], "10.0.0.5").allowed).toBe(false);
  });

  it("allows any IP when the rule does not check", () => {
    expect(ipCheck([{ IP_CHECK_YN: "N", IP_ADDR: "" }], "1.2.3.4").allowed).toBe(true);
  });
});

describe("decide", () => {
  const out = (etc: Record<string, string>) => decide(etc, "out", "202610271806", "Y");

  it("allows a clock-out after the recorded clock-in", () => {
    expect(out({ PLAN_CHK_CONFIRM: "OK", C_IN_YMDHM: "202610270915" })).toEqual({ notices: [] });
  });

  it("blocks a clock-out earlier than the clock-in", () => {
    expect(() => out({ PLAN_CHK_CONFIRM: "OK", C_IN_YMDHM: "202610271900", ALERT_C_IN_YMDHM: "19:00" })).toThrow(
      PunchBlockedError,
    );
  });

  it("blocks at equal timestamps (boundary)", () => {
    expect(() => out({ PLAN_CHK_CONFIRM: "OK", C_IN_YMDHM: "202610271806" })).toThrow(PunchBlockedError);
  });

  it("blocks when the server says CONFIRM is not OK", () => {
    expect(() => out({ PLAN_CHK_CONFIRM: "PLAN_NO_CHECK", CONFIRM: "근무계획을 확인하세요" })).toThrow("근무계획을 확인하세요");
  });

  it("blocks an unknown plan check result", () => {
    expect(() => out({ PLAN_CHK_CONFIRM: "계획 없음" })).toThrow("계획 없음");
  });

  it("blocks a clock-out before any clock-in", () => {
    expect(() => out({ PLAN_CHK_CONFIRM: "OK", TM_NOT_FIRST_OUT: "Y", C_IN_YMDHM: "" })).toThrow("출근 기록을 먼저");
  });

  it("surfaces ALERT_MSG as a notice when the yesterday-out rule is off", () => {
    expect(decide({ ALERT_MSG: "안내", PLAN_CHK_CONFIRM: "OK" }, "in", "202610270900", "N")).toEqual({
      notices: ["안내"],
    });
  });
});
