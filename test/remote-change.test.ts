import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import type { JadeClient } from "../src/client.js";
import { parsePage, PageStructureError, type PageContext } from "../src/page.js";
import {
  checkRevertRequest,
  commitRemoteWorkRevert,
  pickRevertWorkType,
  prepareRemoteWorkRevert,
  remoteRevertReason,
} from "../src/remote-change.js";
import type { JadeResponse, Row } from "../src/response.js";
import type { Params } from "../src/viewstate.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");

// 재택 근무 신청서 화면의 doAction2 분기 배치와 신청서 공통 토큰만 본뜬 합성 HTML
function formHtml(opts: { dropClose?: boolean } = {}): string {
  return `<script>
var S_PGM_OPEN_TIME = "1"; var S_ENC_OTP_KEY = "k"; var S_CSRF_SALT = "s";
var ApplyOtpVal = {
    Sys_appl_common : "${tok("Common")}"
  , getInitInfo     : "${tok("Init")}"
  , getCourse       : "${tok("Course")}"
  , searchRetiree   : "${tok("Retiree")}"
  , apply01         : "${tok("Apply")}"
};
function LoadPage() {
  setCombo("선택근무제□2020■선택근무제(IT)□2021■재택근무제□2040■휴일□3010", "S_WORK_TYPE", null, "N");
}
function doAction2(sAction, p1) { switch(sAction) {
  case "${tok("Org")}": {
    $("#S_ORG_WORK_TYPE").val("");
  } break;
  ${opts.dropClose ? "" : `case "${tok("Close")}" : {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) {
      var msg = xs.GetEtcData("rtnMsg");
    });
  } break;`}
  case "${tok("List")}": {
    $("#S_WORK_TYPE").empty();
  } break;
}}
</script>
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="${tok("FormClass")}" />
<input type="hidden" id="S_APPL_TYPE" name="S_APPL_TYPE" value="1130" />
<input type="hidden" id="S_LOGIN_EMP_ID" name="S_LOGIN_EMP_ID" value="E1" />
<input type="hidden" id="S_LOGIN_EMP_NM" name="S_LOGIN_EMP_NM" value="홍길동" />`;
}

const MAIN: PageContext = {
  openTime: "0",
  otpKey: "m",
  csrfSalt: "m",
  hasMaskingVars: false,
  page: {},
  inputs: {},
  otp: { hunelOtpVal: { Sy_main_page: "tok-main", searchAuth: "tok-auth" } },
};

const LIST: Row[] = [
  { CD: "2020", CD_NM: "선택근무제" },
  { CD: "2021", CD_NM: "선택근무제(IT)" },
];

function fakeClient(state: { org: string; rtnMsg: string; html?: string; approver?: string; list?: Row[] }) {
  const calls: { method: string; params: Params }[] = [];
  const respond = (method: string): JadeResponse => {
    switch (method) {
      case "tok-auth":
        return { etc: { PROFILE_ID: "ESS" }, datasets: {} };
      case tok("Init"):
        return { etc: { S_APPL_TX_TOKEN: "tx" }, datasets: { ApplType: [{ APPR_PRS_YN: "Y", APPL_TO_ME: "N" }] } };
      case tok("Course"):
        return { etc: {}, datasets: { ApprLine: [{ COL2: "PATH", COL4: "Y" }], LineDetail: [{ COL3: state.approver ?? "E9", COL4: "결재자", COL5: "팀장", COL10: "10" }] } };
      case tok("Org"):
        return { etc: { WORK_TYPE: state.org }, datasets: {} };
      case tok("List"):
        return { etc: {}, datasets: { Data: state.list ?? LIST } };
      case tok("Close"):
        return { etc: { rtnMsg: state.rtnMsg }, datasets: {} };
      case tok("Retiree"):
        return { etc: { RET_STAT: "Y" }, datasets: {} };
      case tok("Apply"):
        return { etc: { APPL_ID: "300" }, datasets: {} };
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
    openScreen: async () => {
      const text = state.html ?? formHtml();
      return { text, ctx: parsePage(text) };
    },
  };
  return { client: client as unknown as JadeClient, calls };
}

const OPTIONS = [
  { code: "2020", name: "선택근무제" },
  { code: "2021", name: "선택근무제(IT)" },
];

describe("pickRevertWorkType", () => {
  it("재택인 날에서 지정한 근무유형을 고른다", () => {
    expect(pickRevertWorkType("재택근무제", OPTIONS, "선택근무제(IT)")).toEqual({ code: "2021", name: "선택근무제(IT)" });
  });

  it("재택이 아닌 날은 되돌릴 것이 없다", () => {
    expect(() => pickRevertWorkType("선택근무제(IT)", OPTIONS, "선택근무제(IT)")).toThrow("되돌릴 재택근무가 없다");
  });

  it("목록에 없거나 재택·휴무 계열인 유형은 고르지 않는다", () => {
    expect(() => pickRevertWorkType("재택근무제", OPTIONS, "고정근무제")).toThrow(ApplicationBlockedError);
    expect(() => pickRevertWorkType("재택근무제", [...OPTIONS, { code: "2040", name: "재택근무제" }], "재택근무제")).toThrow(ApplicationBlockedError);
    expect(() => pickRevertWorkType("재택근무제", OPTIONS, "휴일")).toThrow(ApplicationBlockedError);
  });

  it("목록이 비면 막는다 (경계)", () => {
    expect(() => pickRevertWorkType("재택근무제", [], "선택근무제(IT)")).toThrow(ApplicationBlockedError);
  });
});

describe("checkRevertRequest", () => {
  it("오늘은 화면처럼 받는다 (경계)", () => {
    expect(() => checkRevertRequest({ date: "20261103" }, "20261103")).not.toThrow();
  });

  it("지난 날짜와 틀린 형식은 막는다", () => {
    expect(() => checkRevertRequest({ date: "20261102" }, "20261103")).toThrow("지난 날짜");
    expect(() => checkRevertRequest({ date: "2026119" }, "20261103")).toThrow("YYYYMMDD");
  });

  it("빈 사유는 막는다", () => {
    expect(() => checkRevertRequest({ date: "20261109", reason: " " }, "20261103")).toThrow("사유");
  });
});

describe("remoteRevertReason", () => {
  it("월·일을 앞자리 0 없이 쓴다", () => {
    expect(remoteRevertReason("20261109")).toBe("11월 9일 재택근무 취소 신청드립니다.");
  });
});

describe("prepareRemoteWorkRevert", () => {
  it("재택인 날을 선택근무제(IT) 로 되돌리는 신청서를 마감 검사까지 채우고 상신하지 않는다", async () => {
    const { client, calls } = fakeClient({ org: "2040", rtnMsg: "OK" });
    const plan = await prepareRemoteWorkRevert(client, { date: "20261109" }, "20261103");
    expect(plan.form).toMatchObject({ S_WORK_YMD: "20261109", S_ORG_WORK_TYPE: "2040", S_WORK_TYPE: "2021", S_RSN: "11월 9일 재택근무 취소 신청드립니다." });
    expect(plan.preview).toMatchObject({ date: "2026.11.09", orgWorkType: "재택근무제", workType: "선택근무제(IT) (2021)" });
    expect(calls.map((c) => c.method)).toContain(tok("Close"));
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });

  it("마감 검사가 OK 가 아니면 그 메시지로 막는다", async () => {
    const { client } = fakeClient({ org: "2040", rtnMsg: " 마감된 일자입니다. " });
    await expect(prepareRemoteWorkRevert(client, { date: "20261109" }, "20261103")).rejects.toThrow("마감된 일자입니다.");
  });

  it("마감 검사 분기가 없으면 요청 없이 멈춘다", async () => {
    const { client, calls } = fakeClient({ org: "2040", rtnMsg: "OK", html: formHtml({ dropClose: true }) });
    await expect(prepareRemoteWorkRevert(client, { date: "20261109" }, "20261103")).rejects.toThrow(PageStructureError);
    // 화면을 열려면 메뉴 권한 조회(searchAuth)는 먼저 간다 — 그 뒤 신청서 호출이 하나도 없어야 한다.
    expect(calls.map((c) => c.method)).toEqual(["tok-auth"]);
  });
});

describe("commitRemoteWorkRevert", () => {
  it("미리보기와 같으면 apply01 로 상신한다", async () => {
    const { client, calls } = fakeClient({ org: "2040", rtnMsg: "OK" });
    const plan = await prepareRemoteWorkRevert(client, { date: "29991109" });
    expect(await commitRemoteWorkRevert(client, plan.preview)).toEqual({ date: "2999.11.09", applId: "300" });
    expect(calls.filter((c) => c.method === tok("Apply"))[0]!.params).toMatchObject({ S_WORK_TYPE: "2021", S_ORG_WORK_TYPE: "2040" });
  });

  it("그사이 재택이 아니게 됐으면 상신하지 않는다", async () => {
    const state = { org: "2040", rtnMsg: "OK" };
    const { client, calls } = fakeClient(state);
    const plan = await prepareRemoteWorkRevert(client, { date: "29991109" });
    state.org = "2021";
    await expect(commitRemoteWorkRevert(client, plan.preview)).rejects.toThrow(ApplicationBlockedError);
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });

  it("마감 검사는 통과해도 결재선이 미리보기와 달라졌으면 상신하지 않는다", async () => {
    const state = { org: "2040", rtnMsg: "OK", approver: "E9" };
    const { client, calls } = fakeClient(state);
    const plan = await prepareRemoteWorkRevert(client, { date: "29991109" });
    state.approver = "E8";
    await expect(commitRemoteWorkRevert(client, plan.preview)).rejects.toThrow("미리보기 이후 바뀌었다");
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });

  it("같은 이름의 근무유형이 다른 코드로 바뀌었으면 상신하지 않는다", async () => {
    const state: { org: string; rtnMsg: string; list?: Row[] } = { org: "2040", rtnMsg: "OK" };
    const { client, calls } = fakeClient(state);
    const plan = await prepareRemoteWorkRevert(client, { date: "29991109" });
    state.list = [{ CD: "2099", CD_NM: "선택근무제(IT)" }];
    await expect(commitRemoteWorkRevert(client, plan.preview)).rejects.toThrow("미리보기 이후 바뀌었다");
    expect(calls.map((c) => c.method)).not.toContain(tok("Apply"));
  });
});
