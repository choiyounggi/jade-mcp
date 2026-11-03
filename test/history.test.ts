import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import type { JadeClient } from "../src/client.js";
import {
  allowedActions,
  checkQuery,
  commitRemoval,
  fetchApplications,
  monthsBefore,
  parseApplTypePrograms,
  parseHistoryScreen,
  prepareRemoval,
  progressOf,
  searchParams,
  toApplication,
  type ApplicationState,
} from "../src/history.js";
import { parsePage, PageStructureError, type PageContext } from "../src/page.js";
import { SessionExpiredError, type JadeResponse, type Row } from "../src/response.js";
import type { Params } from "../src/viewstate.js";

// 실제 화면의 구조만 본뜬 합성 HTML — 토큰·이름·사번은 가짜다.
const head = (tag: string) => `<script>
var S_PGM_OPEN_TIME = "1${tag}";
var S_ENC_OTP_KEY   = "otp-${tag}";
var S_CSRF_SALT     = "salt-${tag}";
</script>`;

function historyHtml(opts: { dropList?: boolean } = {}): string {
  return `${head("f03")}<script>
function doAction(sAction, p1) { switch(sAction) {
  case "tok-open" : { popOpen({}); } break;
}}
${opts.dropList ? "" : `function drawApplList(listCount)
{
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "tok-list",
  {
    S_EMP_ID      : $("#S_EMP_ID").val(),
    S_EMP_SCH_AUTH_CD : "10",
    S_APPL_TYPE   : $("#S_APPL_TYPE").val()
  }, function(xs) {});
}`}
</script>
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="cls-f03"/>`;
}

const esc = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const td = (v: string) => `<TD><![CDATA[${v}]]></TD>`;

function menuHtml(cols = ["CD_NM", "APPL_TYPE", "PGM_NM", "DSCLASS"]): string {
  const xml =
    `<?xml version="1.0" encoding="utf-8" ?>\n<SHEET><DATA KEY="default">\n<HTR>${cols.map(td).join("\n")}</HTR>\n` +
    `<TR>${td("휴가 신청서")}\n${td("1020")}\n${td("/tam4/vac.jsp")}\n${td("Vac")}</TR>\n` +
    `<TR>${td("재택 근무 신청서")}\n${td("1130")}\n${td("/tam4/remote.jsp")}\n${td("Remote")}</TR>\n</DATA></SHEET>`;
  return `${head("m03")}<div class="hiddenZone">\n  <textarea id="xmlAllApplType" comment="신청서유형관리">\n${esc(xml)}</textarea></div>`;
}

function detailHtml(applId: string, opts: { dropDelete?: boolean } = {}): string {
  return `${head(`d${applId}`)}<script>
var ApplyOtpVal = {
    Sys_appl_common       : "cls-common"
  , getInitInfo           : "tok-init"
  ${opts.dropDelete ? "" : `, delete01              : "tok-delete"`}
  , apprCheck01           : "tok-check"
  , retract               : "tok-retract"
};
</script>
<form id="f1" name="f1">
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="cls-form"/>
<input type="hidden" id="S_DSMETHOD" name="S_DSMETHOD"/>
<input type="hidden" id="S_TARGET_EMP_ID" name="S_TARGET_EMP_ID" />
<input type="hidden" id="S_APPL_MODE" name="S_APPL_MODE" value="APPL" />
<input type="hidden" id="S_APPL_TYPE" name="S_APPL_TYPE" value="1130" />
<input type="hidden" id="S_APPL_ID" name="S_APPL_ID" value="${applId}" />
<input type="hidden" id="S_PROC_FLAG" name="S_PROC_FLAG" />
</form>`;
}

const listRow = (applId: string, statCd: string, statNm: string): Row => ({
  APPL_ID: applId,
  APPL_TYPE: "1130",
  APPL_TYPE_NM: "재택 근무 신청서",
  MODULE_NM: "근태-근태/근무",
  APPL_YMD: "20261102",
  APPL_HMS: "13:34:09",
  APPL_STAT_CD: statCd,
  APPL_STAT_NM: statNm,
  APPL_TXT: "근무일:2026.11.23 월요일 ",
  CARD_TXT: "홍길동(00000000)",
  TRG_ORG_NM: "테스트팀",
  APPL_EMP_NM: "홍길동",
  CMT_CNT: "0",
});

interface FakeInit {
  statCd: string;
  delBtn: string;
  retractYn?: string;
}

/** openMenu·call 을 흉내 내는 가짜 클라이언트. 모든 호출을 기록한다. */
function fakeClient(opts: {
  rows?: Row[];
  total?: number;
  init?: Record<string, FakeInit | null>;
  apprYn?: string;
  dropDelete?: boolean;
  history?: string;
  /** 상세 화면이 요청과 다른 신청서 번호로 열리는 경우 — 요청 번호 → 화면의 #S_APPL_ID */
  shownApplId?: Record<string, string>;
  /** 삭제·회수 요청이 서버에 닿은 뒤 나는 오류 */
  writeError?: () => Error;
}) {
  const calls: { cls: string; method: string; params: Params; at: string }[] = [];
  const opened: Params[] = [];
  const main: PageContext = {
    openTime: "",
    otpKey: "",
    csrfSalt: "",
    hasMaskingVars: false,
    page: {},
    inputs: {},
    otp: { hunelOtpVal: { Sy_main_page: "cls-main", searchAuth: "tok-auth" } },
  };
  const ok = (res: Partial<JadeResponse>): JadeResponse => ({ etc: res.etc ?? {}, datasets: res.datasets ?? {} });
  const client = {
    // 실제 JadeClient.withSession 처럼 세션 만료면 fn 을 한 번 더 실행한다.
    withSession: async <T>(fn: (m: PageContext) => Promise<T>) => {
      try {
        return await fn(main);
      } catch (e) {
        if (!(e instanceof SessionExpiredError)) throw e;
        return fn(main);
      }
    },
    openScreen: async (form: Params) => {
      opened.push(form);
      const url = String(form.X_POP_URL);
      const text =
        url === "/sys/sy_appl/sy_appl_200_f03.jsp"
          ? (opts.history ?? historyHtml())
          : url === "/sys/sy_appl/sy_appl_200_m03.jsp"
            ? menuHtml()
            : detailHtml(opts.shownApplId?.[String(form.S_APPL_ID)] ?? String(form.S_APPL_ID), { dropDelete: opts.dropDelete });
      return { text, ctx: parsePage(text) };
    },
    call: async (ctx: PageContext, cls: string, method: string, params: Params = {}) => {
      calls.push({ cls, method, params, at: ctx.openTime });
      switch (method) {
        case "tok-auth":
          return ok({ etc: { PROFILE_ID: "ESS", ENC_VAL: "enc" } });
        case "tok-list": {
          const rows = opts.rows ?? [];
          return ok({ etc: { TOT: String(opts.total ?? rows.length) }, datasets: { Data: rows } });
        }
        case "tok-init": {
          const s = opts.init?.[String(params.S_APPL_ID)];
          if (!s) return ok({ etc: { S_APPL_TX_TOKEN: "tx" }, datasets: { ApplType: [{ APPL_TYPE_NM: "재택 근무 신청서" }] } });
          return ok({
            etc: { S_APPL_TX_TOKEN: `tx-${String(params.S_APPL_ID)}` },
            datasets: {
              ApplInfo: [{ APPL_TYPE: "1130", APPL_STAT_CD: s.statCd, DEL_BTN_YN: s.delBtn, TRG_EMP_ID: "00000000", TRG_EMP_NM: "홍길동" }],
              ApplType: [{ APPL_TYPE_NM: "재택 근무 신청서", INF_USE_YN: "N", PROC_FLAG: "" }],
              ApplRetractYn: [{ SYS_VAL: s.retractYn ?? "N" }],
            },
          });
        }
        case "tok-check":
          return ok({ etc: { APPR_YN: opts.apprYn ?? "N" } });
        case "tok-delete":
          if (opts.writeError) throw opts.writeError();
          return ok({});
        case "tok-retract":
          if (opts.writeError) throw opts.writeError();
          return ok({ etc: { APPL_ID: `${String(params.S_APPL_ID)}9` } });
        default:
          throw new Error(`예상하지 않은 호출: ${method}`);
      }
    },
  };
  return { client: client as unknown as JadeClient, calls, opened };
}

const WRITE = new Set(["tok-delete", "tok-retract"]);

describe("parseHistoryScreen", () => {
  it("drawApplList 안의 조회 토큰과 조회권한 코드를 찾는다", () => {
    const html = historyHtml();
    expect(parseHistoryScreen(html, parsePage(html))).toMatchObject({ dsClass: "cls-f03", search: "tok-list", schAuthCd: "10" });
  });

  it("목록 조회 함수가 없으면 요청 없이 멈춘다", () => {
    const html = historyHtml({ dropList: true });
    expect(() => parseHistoryScreen(html, parsePage(html))).toThrow(PageStructureError);
  });
});

describe("checkQuery", () => {
  it("기간을 비우면 화면처럼 6개월 전부터 오늘까지, 20건씩 1페이지를 조회한다", () => {
    expect(checkQuery({}, "20261103")).toEqual({
      from: "20260503",
      to: "20261103",
      statCds: [],
      keyword: "",
      applType: "",
      page: 1,
      pageSize: 20,
    });
  });

  it("상태는 화면 체크박스 코드로 바꾸고 화면 순서(200·300·900)로 보낸다", () => {
    expect(checkQuery({ statuses: ["completed", "approving", "approving"] }, "20261103").statCds).toEqual(["200", "900"]);
  });

  it("시작일이 종료일보다 늦거나 없는 날짜면 막는다", () => {
    expect(() => checkQuery({ fromYmd: "20261105", toYmd: "20261101" }, "20261103")).toThrow(ApplicationBlockedError);
    expect(() => checkQuery({ fromYmd: "20260231" }, "20261103")).toThrow(ApplicationBlockedError);
    expect(() => checkQuery({ page: 0 }, "20261103")).toThrow(ApplicationBlockedError);
  });

  it("6개월 전 계산은 연도를 넘긴다", () => {
    expect(monthsBefore("20260315", 6)).toBe("20250915");
  });
});

describe("searchParams", () => {
  it("drawApplList 와 같은 키 순서로 보내고 시작 행 번호를 페이지로 계산한다", () => {
    const html = historyHtml();
    const p = searchParams(parseHistoryScreen(html, parsePage(html)), checkQuery({ page: 3, pageSize: 10, statuses: ["rejected"] }, "20261103"));
    expect(Object.keys(p)).toEqual([
      "S_EMP_ID",
      "S_EMP_SCH_AUTH_CD",
      "S_APPL_TYPE",
      "S_STAT_CDS",
      "S_TRG_EMP",
      "S_APPL_YMD_FR",
      "S_APPL_YMD_TO",
      "S_STARTPAGE",
      "S_APPL_TXT",
      "S_NUM",
    ]);
    expect(p).toMatchObject({ S_STAT_CDS: "300", S_STARTPAGE: "21", S_NUM: 10 });
  });
});

describe("toApplication / progressOf", () => {
  it("목록 한 줄을 화면 칸과 같은 값으로 읽는다", () => {
    expect(toApplication(listRow("1001", "200", "결재중"))).toEqual({
      applId: "1001",
      applType: "1130",
      applTypeName: "재택 근무 신청서",
      module: "근태-근태/근무",
      appliedAt: "2026.11.02 13:34",
      statusCode: "200",
      statusName: "결재중",
      progress: "진행중",
      content: "근무일:2026.11.23 월요일",
      target: "홍길동(00000000)",
      targetOrg: "테스트팀",
      applicant: "홍길동",
      comments: 0,
    });
  });

  it("상태 아이콘 규칙대로 반려·완료·진행중으로 나눈다", () => {
    expect(["300", "600", "620", "900", "200", "100", ""].map(progressOf)).toEqual(["반려", "반려", "반려", "완료", "진행중", "진행중", "진행중"]);
  });

  it("빈 행도 오류 없이 빈 값으로 읽는다", () => {
    expect(toApplication({})).toMatchObject({ applId: "", module: "기타", appliedAt: "", comments: 0 });
  });
});

describe("parseApplTypePrograms", () => {
  it("신청서 유형별 화면 URL 을 읽는다", () => {
    expect(parseApplTypePrograms(menuHtml())).toEqual(
      new Map([
        ["1020", "/tam4/vac.jsp"],
        ["1130", "/tam4/remote.jsp"],
      ]),
    );
  });

  it("유형 목록이 없거나 PGM_NM 열이 없으면 멈춘다", () => {
    expect(() => parseApplTypePrograms("<html></html>")).toThrow(PageStructureError);
    expect(() => parseApplTypePrograms(menuHtml(["CD_NM", "APPL_TYPE", "URL", "DSCLASS"]))).toThrow(PageStructureError);
  });
});

describe("allowedActions", () => {
  const s = (o: Partial<ApplicationState>): ApplicationState => ({
    statusCode: "200",
    delBtnYn: "Y",
    retractYn: "N",
    infUseYn: "N",
    procFlag: "N",
    ...o,
  });

  it("결재 전(DEL_BTN_YN=Y) 신청서는 삭제할 수 있고, 회수는 회사가 회수 기능을 쓸 때만 된다", () => {
    expect(allowedActions(s({}))).toEqual({ delete: true, retract: false });
    expect(allowedActions(s({ retractYn: "Y" }))).toEqual({ delete: true, retract: true });
  });

  it("임시저장은 삭제만, 결재가 진행된 신청서는 둘 다 안 된다", () => {
    expect(allowedActions(s({ statusCode: "100", delBtnYn: "N", retractYn: "Y" }))).toEqual({ delete: true, retract: false });
    expect(allowedActions(s({ statusCode: "900", delBtnYn: "N", retractYn: "Y" }))).toEqual({ delete: false, retract: false });
  });

  it("외부 결재만 쓰는 유형은 임시저장일 때만 지울 수 있다", () => {
    expect(allowedActions(s({ infUseYn: "Y", procFlag: "20", retractYn: "Y" }))).toEqual({ delete: false, retract: false });
    expect(allowedActions(s({ infUseYn: "Y", procFlag: "20", statusCode: "100" }))).toEqual({ delete: true, retract: false });
  });
});

describe("fetchApplications", () => {
  it("신청내역 탭을 열고 목록을 화면 칸으로 돌려준다", async () => {
    const { client, calls, opened } = fakeClient({ rows: [listRow("1001", "200", "결재중")], total: 41 });
    const list = await fetchApplications(client, { statuses: ["approving"], pageSize: 20, page: 2 }, "20261103");
    expect(opened[0]).toMatchObject({ X_POP_URL: "/sys/sy_appl/sy_appl_200_f03.jsp", S_MAIN_YN: "N" });
    expect(calls.at(-1)).toMatchObject({ cls: "cls-f03", method: "tok-list", params: { S_STAT_CDS: "200", S_STARTPAGE: "21" } });
    expect(list).toMatchObject({ total: 41, page: 2, pageCount: 3, statuses: ["200"], from: "2026.05.03", to: "2026.11.03" });
    expect(list.items[0]).toMatchObject({ applId: "1001", progress: "진행중" });
  });

  it("건수가 있는데 행을 못 읽으면 빈 목록으로 보고하지 않고 멈춘다", async () => {
    const { client } = fakeClient({ rows: [], total: 5 });
    await expect(fetchApplications(client, {}, "20261103")).rejects.toThrow(PageStructureError);
  });
});

describe("prepareRemoval", () => {
  const rows = [listRow("1001", "200", "결재중"), listRow("1002", "900", "최종완료")];
  const init = { "1001": { statCd: "200", delBtn: "Y" }, "1002": { statCd: "900", delBtn: "N" } };

  it("목록에서 다시 찾고 상세 화면 규칙·결재 진행 검사를 통과한 것만 대상으로 잡는다 — 지우지 않는다", async () => {
    const { client, calls, opened } = fakeClient({ rows, init });
    const plan = await prepareRemoval(client, { applIds: ["1001", "1002"], action: "delete" }, "20261103");
    expect(plan.targets).toEqual([{ applId: "1001", applType: "1130", statusCode: "200", pgm: "/tam4/remote.jsp" }]);
    expect(plan.preview.applications.map((a) => a.applId)).toEqual(["1001"]);
    expect(plan.preview.blocked).toEqual([{ applId: "1002", reason: expect.stringContaining("삭제·회수 버튼이 없다") }]);
    expect(calls.some((c) => WRITE.has(c.method))).toBe(false);
    expect(calls.filter((c) => c.method === "tok-check").map((c) => c.cls)).toEqual(["cls-common"]);
    // 신청내역에서 한 줄을 누를 때와 같은 값으로 상세 화면을 연다
    expect(opened.find((o) => o.S_APPL_ID === "1001")).toMatchObject({
      X_POP_URL: "/tam4/remote.jsp",
      S_APPL_STAT_CD: "200",
      S_APPL_MODE: "APPL",
      S_LIST_SRC: "/sys/sy_appl/sy_appl_200_f03.jsp",
    });
  });

  it("결재가 진행됐다고 서버가 답하면 막는다", async () => {
    const { client } = fakeClient({ rows, init, apprYn: "Y" });
    await expect(prepareRemoval(client, { applIds: ["1001"], action: "delete" }, "20261103")).rejects.toThrow(/결재가 진행되어/);
  });

  it("회사가 회수 기능을 안 쓰면 회수는 막는다", async () => {
    const { client } = fakeClient({ rows, init });
    await expect(prepareRemoval(client, { applIds: ["1001"], action: "retract" }, "20261103")).rejects.toThrow(/회수 기능을 쓰지 않는다/);
  });

  it("기간 안 목록에 없는 번호와 잘못된 번호는 막는다", async () => {
    const { client } = fakeClient({ rows, init });
    await expect(prepareRemoval(client, { applIds: ["1003"], action: "delete" }, "20261103")).rejects.toThrow(/찾지 못한 신청서: 1003/);
    await expect(prepareRemoval(client, { applIds: ["A1"], action: "delete" }, "20261103")).rejects.toThrow(ApplicationBlockedError);
    await expect(prepareRemoval(client, { applIds: [], action: "delete" }, "20261103")).rejects.toThrow(ApplicationBlockedError);
  });

  it("상세 화면에 삭제 토큰이 없으면 요청 없이 멈춘다", async () => {
    const { client, calls } = fakeClient({ rows, init, dropDelete: true });
    await expect(prepareRemoval(client, { applIds: ["1001"], action: "delete" }, "20261103")).rejects.toThrow(PageStructureError);
    expect(calls.some((c) => c.method === "tok-check" || WRITE.has(c.method))).toBe(false);
  });
});

describe("commitRemoval", () => {
  const rows = [listRow("1001", "200", "결재중"), listRow("1004", "200", "결재중")];

  it("상세 화면을 새로 열어 받은 토큰을 맨 앞에 두고 화면 폼과 함께 delete01 을 부른다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const { client } = fakeClient({ rows, init });
    const plan = await prepareRemoval(client, { applIds: ["1001"], action: "delete" }, "20261103");
    const second = fakeClient({ rows, init });
    expect(await commitRemoval(second.client, plan)).toEqual({ action: "삭제", results: [{ applId: "1001", result: "삭제됨" }] });
    const del = second.calls.find((c) => c.method === "tok-delete")!;
    expect(del.cls).toBe("cls-form");
    expect(Object.keys(del.params)[0]).toBe("S_APPL_TX_TOKEN");
    expect(del.params).toMatchObject({ S_APPL_TX_TOKEN: "tx-1001", S_APPL_ID: "1001", S_APPL_TYPE: "1130", S_TARGET_EMP_ID: "00000000" });
    expect(del.params).not.toHaveProperty("S_DSCLASS");
  });

  it("미리보기 뒤 상태가 바뀐 신청서는 보내지 않고 건너뛰며 나머지는 계속한다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" }, "1004": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001", "1004"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init: { "1001": { statCd: "900", delBtn: "N" }, "1004": { statCd: "200", delBtn: "Y" } } });
    const out = await commitRemoval(later.client, plan);
    expect(out.results).toEqual([
      { applId: "1001", result: "건너뜀", reason: expect.stringContaining("바뀌었다") },
      { applId: "1004", result: "삭제됨" },
    ]);
    expect(later.calls.filter((c) => c.method === "tok-delete").map((c) => c.params.S_APPL_ID)).toEqual(["1004"]);
  });

  it("이미 지워진 신청서는 건너뛴다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init: { "1001": null } });
    expect((await commitRemoval(later.client, plan)).results[0]).toMatchObject({ result: "건너뜀", reason: expect.stringContaining("이미 삭제") });
    expect(later.calls.some((c) => WRITE.has(c.method))).toBe(false);
  });

  it("회수는 공통 클래스의 retract 를 신청서 번호만으로 부르고 돌려받은 번호를 알려 준다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y", retractYn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "retract" }, "20261103");
    const later = fakeClient({ rows, init });
    expect(await commitRemoval(later.client, plan)).toEqual({ action: "회수", results: [{ applId: "1001", result: "회수됨", newApplId: "10019" }] });
    const r = later.calls.find((c) => c.method === "tok-retract")!;
    expect(r).toMatchObject({ cls: "cls-common", params: { S_APPL_ID: "1001" } });
    expect(Object.keys(r.params)).toEqual(["S_APPL_ID"]);
    expect(later.calls.some((c) => c.method === "tok-delete" || c.method === "tok-check")).toBe(false);
  });

  it("상세 화면이 다른 신청서 번호로 열리면 delete01 을 보내지 않는다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init, shownApplId: { "1001": "1999" } });
    expect((await commitRemoval(later.client, plan)).results).toEqual([{ applId: "1001", result: "실패", reason: expect.stringContaining("S_APPL_ID") }]);
    expect(later.calls.some((c) => WRITE.has(c.method))).toBe(false);
  });

  it("상태코드는 그대로여도 미리보기 뒤 결재가 시작됐으면(DEL_BTN_YN=N) 보내지 않는다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init: { "1001": { statCd: "200", delBtn: "N" } } });
    expect((await commitRemoval(later.client, plan)).results).toEqual([{ applId: "1001", result: "건너뜀", reason: expect.stringContaining("버튼이 없다") }]);
    expect(later.calls.some((c) => WRITE.has(c.method))).toBe(false);
  });

  it("상태코드는 그대로여도 서버가 결재 진행(APPR_YN=Y)이라 답하면 보내지 않는다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init, apprYn: "Y" });
    expect((await commitRemoval(later.client, plan)).results).toEqual([{ applId: "1001", result: "건너뜀", reason: "결재가 진행되어 삭제할 수 없다" }]);
    expect(later.calls.some((c) => WRITE.has(c.method))).toBe(false);
  });

  it("delete01 을 보낸 뒤 오류가 나면 실패가 아니라 확인 필요로 알린다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init, writeError: () => new Error("응답을 받지 못했다") });
    expect((await commitRemoval(later.client, plan)).results).toEqual([
      { applId: "1001", result: "확인 필요", reason: expect.stringContaining("jade_applications 로 실제 상태를 확인") },
    ]);
    expect(later.calls.filter((c) => c.method === "tok-delete")).toHaveLength(1);
  });

  it("삭제 요청 뒤 세션이 끊겨도 세션 재시도로 delete01 을 다시 보내지 않는다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "delete" }, "20261103");
    const later = fakeClient({ rows, init, writeError: () => new SessionExpiredError() });
    expect((await commitRemoval(later.client, plan)).results[0]).toMatchObject({ applId: "1001", result: "확인 필요" });
    expect(later.calls.filter((c) => c.method === "tok-delete")).toHaveLength(1);
  });

  it("회수 요청 뒤 세션이 끊겨도 세션 재시도로 retract 를 다시 보내지 않는다", async () => {
    const init = { "1001": { statCd: "200", delBtn: "Y", retractYn: "Y" } };
    const plan = await prepareRemoval(fakeClient({ rows, init }).client, { applIds: ["1001"], action: "retract" }, "20261103");
    const later = fakeClient({ rows, init, writeError: () => new SessionExpiredError() });
    expect((await commitRemoval(later.client, plan)).results[0]).toMatchObject({ applId: "1001", result: "확인 필요" });
    expect(later.calls.filter((c) => c.method === "tok-retract")).toHaveLength(1);
  });
});
