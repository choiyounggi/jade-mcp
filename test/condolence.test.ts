import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import { checkCondolenceRequest, parseCondolenceTokens } from "../src/condolence.js";
import { PageStructureError } from "../src/page.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");
const call = (t: string) => `ajaxSyncRequestXS($("#S_DSCLASS").val(), "${tok(t)}", serializeForm("f1"), function(xs) {});`;

// 실제 경조 휴가 신청서 화면의 호출 배치만 본뜬 합성 HTML
function formHtml(opts: { dropRule?: boolean } = {}): string {
  return `<script>
function LoadPage() {
  //법인별 기준정보
  ${call("Standard")}
  if(_xapplStatus == null) { ${call("Types")} }
}
function doAction2(sAction) { switch(sAction) {
  ${opts.dropRule ? "" : `case "${tok("Rule")}" : {
      ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) { _xsStat = []; });
  } break;`}
  case "${tok("Days")}" : {
      /* 21.09.15 시작일자를 제대로 입력하지 않을 경우 */
      ${call("Days")}
  } break;
  case "${tok("Validate")}" : {
      ajaxSyncRequestXS($("#S_DSCLASS").val(), "${tok("Validate")}", chgParam, function(xs) { S_CHK_MSG = xs.GetEtcData("CHK_MSG"); });
  } break;
}}
function chg_con_type( sel ) { ${call("Families")} }
function chg_fam_cd( sel ) {
  //가족관계 변경시 기준정보를 보여준다.
  doAction2('${tok("Rule")}');
  ${call("Birth")}
}
function getRule( sel ) { ${call("LeaveRule")} }
</script>`;
}

describe("parseCondolenceTokens", () => {
  it("maps each server call by the code around it", () => {
    expect(parseCondolenceTokens(formHtml())).toEqual({
      standard: tok("Standard"),
      types: tok("Types"),
      families: tok("Families"),
      rule: tok("Rule"),
      birthCheck: tok("Birth"),
      leaveRule: tok("LeaveRule"),
      validate: tok("Validate"),
      dayCount: tok("Days"),
    });
  });

  it("fails closed when the rule branch is missing", () => {
    expect(() => parseCondolenceTokens(formHtml({ dropRule: true }))).toThrow(PageStructureError);
  });
});

describe("checkCondolenceRequest", () => {
  const ok = { conType: "3010", conDate: "20261120", leaveStart: "20261120", leaveEnd: "20261120", reason: "생일 반차" };

  it("accepts a one-day leave", () => {
    expect(() => checkCondolenceRequest(ok)).not.toThrow();
  });

  it("accepts a request without leave (benefit only)", () => {
    expect(() => checkCondolenceRequest({ conType: "6010", conDate: "20261120", reason: "조사" })).not.toThrow();
  });

  it("rejects a leave end before its start", () => {
    expect(() => checkCondolenceRequest({ ...ok, leaveEnd: "20261119" })).toThrow(ApplicationBlockedError);
  });

  it("rejects only one leave bound", () => {
    expect(() => checkCondolenceRequest({ ...ok, leaveEnd: undefined })).toThrow("함께");
  });

  it("rejects an impossible date (month 13)", () => {
    expect(() => checkCondolenceRequest({ ...ok, conDate: "20261320" })).toThrow("YYYYMMDD");
  });
});
