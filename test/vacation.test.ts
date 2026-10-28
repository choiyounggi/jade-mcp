import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import { PageStructureError } from "../src/page.js";
import { checkVacationRequest, parseVacationTokens } from "../src/vacation.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");

// 실제 휴가 신청서 화면의 호출 배치만 본뜬 합성 HTML
function formHtml(opts: { dropValidate?: boolean; same?: boolean } = {}): string {
  const t = opts.same ? () => tok("Same") : tok;
  return `<script>
function LoadPage() {
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Types")}", { S_APPL_TYPE: $("#S_APPL_TYPE").val() }, function(xs) {});
}
function doAction2(sAction) { switch(sAction) {
  case "${t("Rows")}" : {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) { createAttedTr(xs, true, true); });
  } break;
  ${opts.dropValidate ? "" : `case "${t("Validate")}" : {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) {
      S_CHK_MSG = xs.GetEtcData("CHK_MSG");
      ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Days")}", serializeForm("f1"), function(xss) {});
    });
  } break;`}
  case "${t("UseTime")}": {
      var sel_ymd   = arguments[1];
  } break;
}}
function getRule( sel ) {
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Quota")}", serializeForm("f1"), function(xs) {});
  enableInput("F_END_YMD", true);
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Rules")}", {S_APPL_TYPE : "1020"}, function(rv) {});
}
function ddct_check() {
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Deduct")}", serializeForm("f1"), function(xs) {});
}
</script>`;
}

describe("parseVacationTokens", () => {
  it("maps each server call by the code around it", () => {
    expect(parseVacationTokens(formHtml())).toEqual({
      types: tok("Types"),
      quota: tok("Quota"),
      rules: tok("Rules"),
      rows: tok("Rows"),
      useTime: tok("UseTime"),
      validate: tok("Validate"),
      dayCount: tok("Days"),
      deductOrder: tok("Deduct"),
    });
  });

  it("fails closed when the validation branch is missing", () => {
    expect(() => parseVacationTokens(formHtml({ dropValidate: true }))).toThrow(PageStructureError);
  });

  it("fails closed when tokens cannot be told apart", () => {
    expect(() => parseVacationTokens(formHtml({ same: true }))).toThrow(PageStructureError);
  });
});

describe("checkVacationRequest", () => {
  const ok = { attendClass: "4010", date: "20261106", startHm: "1500", endHm: "1900", reason: "개인 사유" };

  it("accepts a same-day time range", () => {
    expect(() => checkVacationRequest(ok)).not.toThrow();
  });

  it("rejects an end time not after the start (boundary: equal)", () => {
    expect(() => checkVacationRequest({ ...ok, endHm: "1500" })).toThrow(ApplicationBlockedError);
  });

  it("rejects an invalid clock value", () => {
    expect(() => checkVacationRequest({ ...ok, startHm: "2460" })).toThrow("HHMM");
  });

  it("rejects a blank reason", () => {
    expect(() => checkVacationRequest({ ...ok, reason: "   " })).toThrow("사유");
  });
});
