import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import {
  checkCancelRequest,
  commitOvertimeCancel,
  monthRange,
  parseTargetSearch,
  pickCancelTarget,
  prepareOvertimeCancel,
  toOvertimeEntries,
} from "../src/overtime-cancel.js";
import { PageStructureError, parsePage } from "../src/page.js";
import type { JadeResponse, Row } from "../src/response.js";
import { applicationHtml, fakeClient } from "./fixtures/overtime/fake-client.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");
const COLUMNS = ["CCHK", "YMD", "STA_YMD", "STA_HM", "END_YMD", "END_HM", "RSN", "REWARD_TYPE", "REWARD_YMD", "DELETE_YN", "APPL_INFO", "APPL_ID"];

// 실제 「취소할 사전근무 선택」 팝업의 sheet 열 정의·doAction 분기 배치만 본뜬 합성 HTML
function popupHtml(opts: { dropSearch?: boolean; dropColumn?: string; emp?: string } = {}): string {
  const cols = COLUMNS.filter((c) => c !== opts.dropColumn)
    .map((c) => `arrC[col++] = {Header:"${c}", Type:"Text", SaveName:"${c}"};`)
    .join("\n");
  return `<script>
var S_PGM_OPEN_TIME = "3";
var S_ENC_OTP_KEY   = "otp-popup";
var S_CSRF_SALT     = "salt-popup";
function LoadPage() {
${cols}
}
function doAction(sAction) { switch(sAction) {
  ${opts.dropSearch ? "" : `case "${tok("Search")}" : {
    $("#S_SAVENAME").val( concatSaveName(sheet1, "|", "CSEQ,CDELETE,CSTATUS"));
    sheet1.DoSearch("/commonAction.do", paramSub);
  } break;`}
  case "${tok("Return")}" : { ModalUtil.returnValue(return_grid); } break;
}}
</script>
<form id="f1">
<input type="hidden" id="S_DSCLASS"  name="S_DSCLASS" value="cls-popup" />
<input type="hidden" id="S_EMP_ID" name=S_EMP_ID value="${opts.emp ?? "E0001"}" />
</form>`;
}

const row = (over: Row = {}): Row => ({
  APPL_ID: "A1",
  YMD: "20261104",
  STA_YMD: "20261104",
  STA_HM: "0930",
  END_YMD: "20261105",
  END_HM: "0200",
  RSN: "배포 대응",
  REWARD_TYPE: "",
  DELETE_YN: "Y",
  APPL_INFO: "사전근무신청 / 2026.11.04 09:30 ~ 2026.11.05 02:00 취소",
  ...over,
});

describe("parseTargetSearch", () => {
  it("조회 분기 토큰과 팝업 클래스·대상 사번을 찾는다", () => {
    const html = popupHtml();
    expect(parseTargetSearch(html, parsePage(html))).toMatchObject({ dsClass: "cls-popup", search: tok("Search"), empId: "E0001" });
  });

  it("조회 분기가 없으면 요청을 보내지 않고 멈춘다", () => {
    const html = popupHtml({ dropSearch: true });
    expect(() => parseTargetSearch(html, parsePage(html))).toThrow(PageStructureError);
  });

  it("목록 열이 바뀌었으면 멈춘다", () => {
    const html = popupHtml({ dropColumn: "DELETE_YN" });
    expect(() => parseTargetSearch(html, parsePage(html))).toThrow("DELETE_YN");
  });
});

describe("pickCancelTarget", () => {
  it("그날 취소할 수 있는 한 건을 고른다", () => {
    expect(pickCancelTarget(toOvertimeEntries([row(), row({ APPL_ID: "A2", YMD: "20261105" })]), "20261104")).toMatchObject({ applId: "A1" });
  });

  it("DELETE_YN=N 이면 팝업처럼 고르지 않는다", () => {
    expect(() => pickCancelTarget(toOvertimeEntries([row({ DELETE_YN: "N" })]), "20261104")).toThrow("취소를 막고 있다");
  });

  it("그날 신청이 없으면 그 달 신청을 알려 주며 멈춘다 (경계: 목록 0행)", () => {
    expect(() => pickCancelTarget([], "20261104")).toThrow("그 달 신청: 없음");
    expect(() => pickCancelTarget(toOvertimeEntries([row({ YMD: "20261110", STA_YMD: "20261110" })]), "20261104")).toThrow("2026.11.10 09:30");
  });

  it("같은 날 취소할 수 있는 건이 여럿이면 시작 시각으로 고르게 한다", () => {
    const entries = toOvertimeEntries([row(), row({ APPL_ID: "A3", STA_HM: "1900" })]);
    expect(() => pickCancelTarget(entries, "20261104")).toThrow("startHm");
    expect(pickCancelTarget(entries, "20261104", "1900").applId).toBe("A3");
    expect(() => pickCancelTarget(entries, "20261104", "1000")).toThrow(ApplicationBlockedError);
  });
});

describe("monthRange / checkCancelRequest", () => {
  it("근무일이 든 달의 1일 ~ 말일 (경계: 윤년 2월)", () => {
    expect(monthRange("20280215")).toEqual({ sta: "20280201", end: "20280229" });
    expect(monthRange("20261231")).toEqual({ sta: "20261201", end: "20261231" });
  });

  it("날짜·시각 형식과 빈 사유를 막는다", () => {
    expect(() => checkCancelRequest({ date: "2026114", reason: "x" })).toThrow("YYYYMMDD");
    expect(() => checkCancelRequest({ date: "20261104", startHm: "930", reason: "x" })).toThrow("HHMM");
    expect(() => checkCancelRequest({ date: "20261104", reason: " " })).toThrow("사유");
  });
});

describe("prepareOvertimeCancel / commitOvertimeCancel", () => {
  const CANCEL_INPUTS = `<input type="hidden" id="S_BF_APPL_ID" name="S_BF_APPL_ID" entry />
<input type="hidden" id="S_APPL_STAT_CD" name="S_APPL_STAT_CD" value="100" />
<input type="text" name="S_APPL_INFO" id="S_APPL_INFO" readonly="readonly" entry />`;
  const screens = {
    "/tam4/tm_day/tm_day_075_m01.jsp": applicationHtml("function doValidation() {}", CANCEL_INPUTS),
    "/tam4/tm_day/tm_day_075_p01.jsp": popupHtml(),
  };
  const listing = (rows: Row[]) => (method: string): JadeResponse | undefined =>
    method === tok("Search") ? { etc: {}, datasets: { Data: rows } } : undefined;

  it("팝업 목록을 그 달 기간으로 조회해 고른 신청을 신청내역·원 신청번호로 싣는다 — 상신은 하지 않는다", async () => {
    const { client, calls } = fakeClient(screens, listing([row()]));
    const plan = await prepareOvertimeCancel(client, { date: "20261104", reason: "일정 변경" });

    expect(calls.map((c) => c.method)).toEqual(["tok-searchAuth", "tok-getInitInfo", "tok-getCourse", "tok-searchAuth", tok("Search")]);
    expect(calls.at(-1)).toMatchObject({ dsClass: "cls-popup", params: { S_EMP_ID: "E0001", S_SCH_STA_YMD: "20261101", S_SCH_END_YMD: "20261130" } });
    expect(plan.form).toMatchObject({ S_BF_APPL_ID: "A1", S_APPL_INFO: row().APPL_INFO, S_NOTE: "일정 변경", S_APPL_STAT_CD: "100" });
    expect(plan.preview.target).toBe("2026.11.04 09:30 ~ 2026.11.05 02:00");
  });

  it("팝업이 다른 사번 목록을 열면 멈춘다", async () => {
    const { client } = fakeClient({ ...screens, "/tam4/tm_day/tm_day_075_p01.jsp": popupHtml({ emp: "E9999" }) }, listing([row()]));
    await expect(prepareOvertimeCancel(client, { date: "20261104", reason: "일정 변경" })).rejects.toThrow("다른 사람");
  });

  it("commit 은 목록을 다시 조회해 아직 취소 가능할 때만 상신한다", async () => {
    let rows = [row()];
    const { client, calls } = fakeClient(screens, (m) => listing(rows)(m));
    const plan = await prepareOvertimeCancel(client, { date: "20261104", reason: "일정 변경" });

    rows = [row({ DELETE_YN: "N" })];
    await expect(commitOvertimeCancel(client, plan)).rejects.toThrow("prepare 부터");
    expect(calls.some((c) => c.method === "tok-apply01")).toBe(false);

    rows = [row()];
    expect(await commitOvertimeCancel(client, plan)).toEqual({ applId: "APPL-NEW" });
    expect(calls.at(-1)).toMatchObject({ method: "tok-apply01", params: { S_BF_APPL_ID: "A1", S_TEMP_APPR: "PATH-1" } });
  });
});
