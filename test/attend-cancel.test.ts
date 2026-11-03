import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import {
  cancelBlockedReason,
  checkCancelPeriod,
  checkCancelReason,
  commitAttendanceCancel,
  listAttendanceCancelCandidates,
  parseCancelPicker,
  prepareAttendanceCancel,
} from "../src/attend-cancel.js";
import type { JadeClient } from "../src/client.js";
import { PageStructureError, type PageContext } from "../src/page.js";
import type { JadeResponse, Row } from "../src/response.js";
import type { Params } from "../src/viewstate.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");
const SECURITY = `var S_PGM_OPEN_TIME = "1"; var S_ENC_OTP_KEY = "k"; var S_CSRF_SALT = "s";`;

// 실제 「취소할 근태/휴가 선택」 팝업의 LoadPage·doAction 배치만 본뜬 합성 HTML
function pickerHtml(opts: { dropSearch?: boolean; dropApplId?: boolean; dropDates?: boolean; empId?: string } = {}): string {
  return `<script>${SECURITY}
function LoadPage()
{
  var arrC = new Array; var col = 0;
  arrC[col++] = {Header:"No|No", Type:"Seq", SaveName:"CSEQ"};
  arrC[col++] = {Header:"선택", Type:"CheckBox", SaveName:"CCHK"};
  arrC[col++] = {Header:"근태/휴가", Type:"Combo", SaveName:"ATTEND_CD"};
  arrC[col++] = {Header:"기간|시작일", Type:"Date", SaveName:"STA_YMD"};
  arrC[col++] = {Header:"기간|종료일", Type:"Date", SaveName:"END_YMD"};
  arrC[col++] = {Header:"APPL_INFO", Type:"Text", SaveName:"APPL_INFO", Hidden:1};
  ${opts.dropApplId ? "" : `arrC[col++] = {Header:"APPL_ID", Type:"Text", SaveName:"APPL_ID", Hidden:1};`}
  setCombo("근무□1010■출장□1060■재택근무□9010", sheet1, "ATTEND_CD", "N");
  ${opts.dropDates ? "" : `inputSetValueAuto("F_SCH_STA_YMD", "20261101");
  inputSetValueAuto("F_SCH_END_YMD", addYmd("20261103", "LOM"));`}
  doAction("${tok("Search")}");
}
function doAction(sAction)
{
  switch(sAction)
  {
    ${opts.dropSearch ? "" : `case "${tok("Search")}":
    {
      if ( ! checkForm("f1") ) return;
      $("#S_SAVENAME").val( concatSaveName(sheet1, "|", "CSEQ,CDELETE,CSTATUS"));
      var paramSub = FormQueryStringEnc(document.f1);
      sheet1.DoSearch("/commonAction.do", paramSub);
    }
    break;`}
    case "${tok("Return")}":
    {
      ModalUtil.returnValue(return_grid);
    }
    break;
  }
}
</script>
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="${tok("PickerClass")}" />
<input type="hidden" id="S_EMP_ID" name=S_EMP_ID value="${opts.empId ?? "E1"}" />`;
}

function formHtml(): string {
  return `<script>${SECURITY}
var ApplyOtpVal = {
    Sys_appl_common : "${tok("Common")}"
  , getInitInfo     : "${tok("Init")}"
  , getCourse       : "${tok("Course")}"
  , searchRetiree   : "${tok("Retiree")}"
  , apply01         : "${tok("Apply")}"
};
</script>
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="${tok("FormClass")}" />
<input type="hidden" id="S_C_CD" name="S_C_CD" value="C" />
<input type="hidden" id="S_BEF_TARGET_EMP_ID" name="S_BEF_TARGET_EMP_ID" />
<input type="hidden" id="S_APPL_INFO" name="S_APPL_INFO"  entry/>
<input type="hidden" id="S_BF_APPL_ID" name="S_BF_APPL_ID" entry />
<input type="hidden" id="S_APPL_TYPE" name="S_APPL_TYPE" value="1132" />
<input type="hidden" id="S_LOGIN_EMP_ID" name="S_LOGIN_EMP_ID" value="E1" />
<input type="hidden" id="S_LOGIN_EMP_NM" name="S_LOGIN_EMP_NM" value="홍길동" />
<input type=text id="S_TARGET_EMP_NM" name="S_TARGET_EMP_NM" value="홍길동"/>
<input type="text" id="S_TARGET_EMP_ID" name="S_TARGET_EMP_ID" value="" />`;
}

const MAIN: PageContext = {
  openTime: "0",
  otpKey: "m",
  csrfSalt: "m",
  hasMaskingVars: false,
  page: { C_CD: "C" },
  inputs: {},
  otp: { hunelOtpVal: { Sy_main_page: "tok-main", searchAuth: "tok-auth" } },
};

const TRIP: Row = {
  APPL_ID: "100",
  ATTEND_CD: "1060",
  STA_YMD: "20261109",
  END_YMD: "20261110",
  APPL_TXT: "출장 [2026.11.09 ~ 2026.11.10] ",
  NOTE: "",
  DELETE_YN: "Y",
  AF_APPL_STAT_CD: "",
  AF_APPL_STAT_NM: "신청가능",
  APPL_INFO: "출장 [2026.11.09 ~ 2026.11.10] 취소",
};

/** 화면 요청을 메서드 토큰으로 받아 고정 응답을 주는 가짜 JADE. 보낸 호출을 기록한다. */
function fakeClient(rows: () => Row[], opts: { picker?: string; approver?: () => string } = {}) {
  const calls: { method: string; params: Params }[] = [];
  const screens: Params[] = [];
  const respond = (method: string): JadeResponse => {
    switch (method) {
      case "tok-auth":
        return { etc: { PROFILE_ID: "ESS", MODULE_ID: "m", MENU_ID: "menu", ENC_VAL: "enc" }, datasets: {} };
      case tok("Init"):
        return { etc: { S_APPL_TX_TOKEN: "tx" }, datasets: { ApplType: [{ APPR_PRS_YN: "Y", APPL_TO_ME: "N", APPL_TYPE_NM: "근태/근무 취소 신청서" }] } };
      case tok("Course"):
        return { etc: {}, datasets: { ApprLine: [{ COL2: "PATH", COL4: "Y" }], LineDetail: [{ COL3: opts.approver?.() ?? "E9", COL4: "결재자", COL5: "팀장", COL10: "10" }] } };
      case tok("Search"):
        return { etc: {}, datasets: { Data: rows() } };
      case tok("Retiree"):
        return { etc: { RET_STAT: "Y" }, datasets: {} };
      case tok("Apply"):
        return { etc: { APPL_ID: "200" }, datasets: {} };
      default:
        throw new Error(`예상하지 못한 호출 ${method}`);
    }
  };
  const client = {
    withSession: <T>(fn: (main: PageContext) => Promise<T>) => fn(MAIN),
    call: async (_ctx: PageContext, _cls: string, method: string, params: Params = {}) => {
      calls.push({ method, params });
      return respond(method);
    },
    openScreen: async (form: Params) => {
      screens.push(form);
      const { parsePage } = await import("../src/page.js");
      const text = form.X_POP_URL === "/tam4/tm_day/tm_day_070_p01.jsp" ? (opts.picker ?? pickerHtml()) : formHtml();
      return { text, ctx: parsePage(text) };
    },
  };
  return { client: client as unknown as JadeClient, calls, screens };
}

describe("parseCancelPicker", () => {
  it("조회 토큰·SaveName·근태 이름·기본 조회 기간을 읽는다", () => {
    expect(parseCancelPicker(pickerHtml())).toEqual({
      search: tok("Search"),
      saveName: "CCHK|ATTEND_CD|STA_YMD|END_YMD|APPL_INFO|APPL_ID",
      attendNames: { "1010": "근무", "1060": "출장", "9010": "재택근무" },
      defaultFrom: "20261101",
      defaultTo: "20261130",
    });
  });

  it("조회 분기가 없으면 요청을 보내지 않고 멈춘다", () => {
    expect(() => parseCancelPicker(pickerHtml({ dropSearch: true }))).toThrow(PageStructureError);
  });

  it("원신청 번호 열이 없으면 멈춘다", () => {
    expect(() => parseCancelPicker(pickerHtml({ dropApplId: true }))).toThrow(PageStructureError);
  });

  it("기본 조회 기간을 못 찾으면 멈춘다", () => {
    expect(() => parseCancelPicker(pickerHtml({ dropDates: true }))).toThrow(PageStructureError);
  });
});

describe("cancelBlockedReason", () => {
  it("취소 신청 가능한 행은 막지 않는다", () => {
    expect(cancelBlockedReason(TRIP)).toBeUndefined();
  });

  it("취소 진행 중(200)·완료(900) 행은 막는다", () => {
    expect(cancelBlockedReason({ ...TRIP, AF_APPL_STAT_CD: "200", AF_APPL_STAT_NM: "결재중" })).toContain("결재중");
    expect(cancelBlockedReason({ ...TRIP, AF_APPL_STAT_CD: "900" })).toContain("이미 취소");
  });

  it("DELETE_YN=N 이면 막는다", () => {
    expect(cancelBlockedReason({ ...TRIP, DELETE_YN: "N" })).toContain("허용하지 않는");
  });

  it("신청내역이 비면 막는다 (신청서 doValidation)", () => {
    expect(cancelBlockedReason({ ...TRIP, APPL_INFO: "" })).toBeDefined();
  });
});

describe("checkCancelPeriod / checkCancelReason", () => {
  it("형식이 맞는 기간은 통과한다", () => {
    expect(() => checkCancelPeriod({ from: "20261101", to: "20261130" })).not.toThrow();
  });

  it("시작일이 종료일보다 늦으면 막는다", () => {
    expect(() => checkCancelPeriod({ from: "20261201", to: "20261130" })).toThrow(ApplicationBlockedError);
  });

  it("공백뿐인 사유는 막는다", () => {
    expect(() => checkCancelReason("")).toThrow("취소 사유가 비어 있다");
    expect(() => checkCancelReason(" \n\t ")).toThrow("취소 사유가 비어 있다");
  });

  it("사유는 500바이트까지 받는다 (경계)", () => {
    expect(() => checkCancelReason("a".repeat(500))).not.toThrow();
    expect(() => checkCancelReason("a".repeat(501))).toThrow(ApplicationBlockedError);
  });
});

describe("prepareAttendanceCancel", () => {
  it("팝업 목록의 행을 신청서 S_APPL_INFO·S_BF_APPL_ID 에 싣고, 상신은 하지 않는다", async () => {
    const { client, calls, screens } = fakeClient(() => [TRIP]);
    const plan = await prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소", from: "20261101", to: "20261130" });

    expect(plan.form).toMatchObject({ S_APPL_INFO: TRIP.APPL_INFO, S_BF_APPL_ID: "100", S_NOTE: "일정 취소", S_TARGET_EMP_ID: "E1", S_BEF_TARGET_EMP_ID: "E1" });
    expect(plan.preview).toMatchObject({ applId: "100", attend: "출장 (1060)", period: "2026.11.09 ~ 2026.11.10", search: { from: "20261101", to: "20261130" } });
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
    const search = calls.find((c) => c.method === tok("Search"))!.params;
    expect(search).toMatchObject({ S_EMP_ID: "E1", S_APPL_TYPE: "1132", S_SCH_STA_YMD: "20261101", F_SCH_END_YMD: "2026.11.30" });
    expect(screens.at(-1)).toMatchObject({ X_POP_URL: "/tam4/tm_day/tm_day_070_p01.jsp", S_APPL_TYPE: "1132", S_EMP_ID: "E1" });
  });

  it("사유가 공백뿐이면 화면을 열기 전에 막는다", async () => {
    const { client, calls, screens } = fakeClient(() => [TRIP]);
    await expect(prepareAttendanceCancel(client, { applId: "100", reason: "   " })).rejects.toThrow("취소 사유가 비어 있다");
    expect(calls).toEqual([]);
    expect(screens).toEqual([]);
  });

  it("팝업이 로그인 사번과 다른 사번으로 열리면 목록 조회 없이 멈춘다", async () => {
    const { client, calls } = fakeClient(() => [TRIP], { picker: pickerHtml({ empId: "E2" }) });
    await expect(prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" })).rejects.toThrow("다른 사람의 신청 목록");
    await expect(listAttendanceCancelCandidates(client)).rejects.toThrow("다른 사람의 신청 목록");
    expect(calls.map((c) => c.method)).not.toContain(tok("Search"));
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });

  it("목록에 없는 원신청이면 막는다", async () => {
    const { client } = fakeClient(() => [TRIP]);
    await expect(prepareAttendanceCancel(client, { applId: "999", reason: "일정 취소" })).rejects.toThrow("목록에 신청 999");
  });

  it("고를 수 없는 행이면 막는다", async () => {
    const { client } = fakeClient(() => [{ ...TRIP, DELETE_YN: "N" }]);
    await expect(prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" })).rejects.toThrow("허용하지 않는");
  });

  it("목록이 비어 있어도 요청 없이 막는다 (경계)", async () => {
    const { client, calls } = fakeClient(() => []);
    await expect(prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" })).rejects.toThrow("목록에 신청 100");
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });
});

describe("listAttendanceCancelCandidates", () => {
  it("기간을 주지 않으면 팝업 기본 기간으로 조회하고 고를 수 있는지 함께 알려 준다", async () => {
    const { client } = fakeClient(() => [TRIP, { ...TRIP, APPL_ID: "101", DELETE_YN: "N" }]);
    const r = await listAttendanceCancelCandidates(client);
    expect(r.period).toBe("2026.11.01 ~ 2026.11.30");
    expect(r.candidates.map((c) => [c.applId, c.selectable])).toEqual([["100", true], ["101", false]]);
  });
});

describe("commitAttendanceCancel", () => {
  it("다시 연 화면이 미리보기와 같으면 apply01 로 상신한다", async () => {
    const { client, calls } = fakeClient(() => [TRIP]);
    const plan = await prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" });
    const r = await commitAttendanceCancel(client, plan.preview);
    expect(r).toEqual({ applId: "100", cancelApplId: "200" });
    const apply = calls.filter((c) => c.method === tok("Apply"));
    expect(apply).toHaveLength(1);
    expect(apply[0]!.params).toMatchObject({ S_BF_APPL_ID: "100", S_TEMP_APPR: "PATH", S_APPL_TX_TOKEN: "tx" });
  });

  it("그사이 취소 신청이 올라간 원신청이면 상신하지 않는다", async () => {
    let state = "";
    const { client, calls } = fakeClient(() => [{ ...TRIP, AF_APPL_STAT_CD: state }]);
    const plan = await prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" });
    state = "200";
    await expect(commitAttendanceCancel(client, plan.preview)).rejects.toThrow(ApplicationBlockedError);
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });

  it("원신청의 기간이 미리보기 뒤 바뀌었으면 고를 수 있는 행이어도 상신하지 않는다", async () => {
    let end = "20261110";
    const { client, calls } = fakeClient(() => [{ ...TRIP, END_YMD: end }]);
    const plan = await prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" });
    end = "20261111";
    await expect(commitAttendanceCancel(client, plan.preview)).rejects.toThrow("미리보기 이후 바뀌었다");
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });

  it("결재선이 미리보기 뒤 바뀌었으면 상신하지 않는다", async () => {
    let approver = "E9";
    const { client, calls } = fakeClient(() => [TRIP], { approver: () => approver });
    const plan = await prepareAttendanceCancel(client, { applId: "100", reason: "일정 취소" });
    approver = "E8";
    await expect(commitAttendanceCancel(client, plan.preview)).rejects.toThrow("미리보기 이후 바뀌었다");
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });
});
