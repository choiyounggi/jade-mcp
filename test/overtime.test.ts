import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import {
  checkResult,
  commitOvertime,
  nextYmd,
  parseOvertimeTokens,
  pickRewardType,
  prepareOvertime,
  resolveOvertimeSpan,
  rewardOptions,
  rewardRequirement,
  toWorkDayInfo,
  type OvertimeRequest,
} from "../src/overtime.js";
import { PageStructureError } from "../src/page.js";
import type { JadeResponse } from "../src/response.js";
import { applicationHtml, empty, fakeClient } from "./fixtures/overtime/fake-client.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");

// 실제 연장 근무 신청서 화면의 doAction2 분기·setComboRewardType 배치만 본뜬 합성 JS
function formScript(opts: { dropCheck?: boolean; dropCombo?: boolean; same?: boolean } = {}): string {
  const t = opts.same ? () => tok("Same") : tok;
  return `
function doAction2(sAction, p1) { switch(sAction) {
  case "${t("Target")}": { Apply.changeTRG(); } break;
  case "${t("WorkType")}": {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("WorkType")}", serializeForm("f1"), function(xs) {
      $("#S_WORK_TYPE").val(xs.GetEtcData("WORK_TYPE"));
      $("#S_WORK_TYPE_CD").val(xs.GetEtcData("WORK_TYPE_CD"));
    });
  } break;
  case "${t("Reward")}": {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Reward")}", serializeForm("f1"), function(xs) {
      $("#S_RW_WORK_TYPE_CD").val(xs.GetEtcData("WORK_TYPE_CD"));
    });
  } break;
  case "${t("Attend")}": {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), "${t("Attend")}", serializeForm("f1"), function(xs) {
      attendHtml += xs.GetEtcData("ATTEND_TXT").trim();
    });
  } break;
  ${opts.dropCheck ? "" : `case "${t("Check")}" : {
    $("#S_TYPE").val(p1);
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) {});
  } break;`}
}}
${opts.dropCombo ? "" : `function setComboRewardType()
{
  ajaxSyncRequestXS("cls-reward", "${t("Combo")}", {S_TARGET_EMP_ID : $("#S_TARGET_EMP_ID").val(), S_STD_YMD: "20261103"}, function(xs) {});
}`}`;
}

const FORM_INPUTS = `<input type="hidden" id="S_TYPE" name="S_TYPE" />
<input type="hidden" id="S_APPL_TYPE" name="S_APPL_TYPE" value="1050" />
<input type="text" class="format" name="F_WORK_YMD" id="F_WORK_YMD" />`;

describe("parseOvertimeTokens", () => {
  it("분기 안의 코드 모양으로 근무유형·근태사항·검증 토큰과 대체/보상 목록 호출을 찾는다", () => {
    expect(parseOvertimeTokens(formScript())).toEqual({
      workType: tok("WorkType"),
      attend: tok("Attend"),
      check: tok("Check"),
      rewardTypes: { dsClass: "cls-reward", method: tok("Combo"), stdYmd: "20261103" },
    });
  });

  it("검증 분기가 없으면 요청을 보내지 않고 멈춘다", () => {
    expect(() => parseOvertimeTokens(formScript({ dropCheck: true }))).toThrow(PageStructureError);
  });

  it("대체/보상 유형 목록 호출이 없으면 멈춘다", () => {
    expect(() => parseOvertimeTokens(formScript({ dropCombo: true }))).toThrow(PageStructureError);
  });

  it("서로 다른 분기가 같은 토큰으로 잡히면 멈춘다", () => {
    expect(() => parseOvertimeTokens(formScript({ same: true }))).toThrow(PageStructureError);
  });
});

describe("resolveOvertimeSpan", () => {
  const ok: OvertimeRequest = { date: "20261104", startHm: "1800", endHm: "2100", reason: "배포 대응" };

  it("종료가 시작보다 늦으면 둘 다 당일이다", () => {
    expect(resolveOvertimeSpan(ok)).toEqual({ staClass: "2", endClass: "2", staYmd: "20261104", endYmd: "20261104" });
  });

  it("종료가 시작보다 이르면 익일 시각으로 본다 (09:30 ~ 익일 02:00)", () => {
    expect(resolveOvertimeSpan({ ...ok, startHm: "0930", endHm: "0200" })).toEqual({
      staClass: "2",
      endClass: "3",
      staYmd: "20261104",
      endYmd: "20261105",
    });
  });

  it("익일이 다음 해로 넘어가도 날짜를 맞게 만든다 (경계: 12월 31일)", () => {
    expect(resolveOvertimeSpan({ ...ok, date: "20261231", startHm: "2200", endHm: "0100" }).endYmd).toBe("20270101");
  });

  it("시작과 종료가 같으면 막는다 (경계: 0분)", () => {
    expect(() => resolveOvertimeSpan({ ...ok, endHm: "1800" })).toThrow(ApplicationBlockedError);
  });

  it("시각 형식이 틀리면 막는다", () => {
    expect(() => resolveOvertimeSpan({ ...ok, endHm: "2460" })).toThrow("HHMM");
  });

  it("사유가 비면 막는다", () => {
    expect(() => resolveOvertimeSpan({ ...ok, reason: "  " })).toThrow("사유");
  });
});

describe("nextYmd", () => {
  it("윤년 2월 말일 다음 날", () => {
    expect(nextYmd("20280228")).toBe("20280229");
    expect(nextYmd("20280229")).toBe("20280301");
  });
});

describe("대체/보상 유형", () => {
  const holiday = toWorkDayInfo({ WORK_TYPE: "휴일", WORK_TYPE_CD: "3010", WORK_DUTIE_YN: "N", SUB_ATTEND_CD: "5010", CHG_HOLI_ASGN_YN: "Y" });

  it("근무일이거나 대체휴가 코드가 없으면 필요 없다", () => {
    expect(rewardRequirement({ ...holiday, workDutieYn: "Y" })).toBe("none");
    expect(rewardRequirement({ ...holiday, subAttendCd: "" })).toBe("none");
  });

  it("휴일대체 지정이 되는 휴일이면 필요하고, 안 되는 휴일이면 화면에서도 신청할 수 없다", () => {
    expect(rewardRequirement(holiday)).toBe("required");
    expect(rewardRequirement({ ...holiday, chgHoliAsgnYn: "N" })).toBe("unavailable");
  });

  it("서버 목록이 비면 화면 기본 목록을 쓴다 (경계: 0행)", () => {
    expect(rewardOptions([])).toEqual([
      { code: "100", name: "연장근무시간(OT) 누적" },
      { code: "200", name: "휴일대체일 지정" },
      { code: "300", name: "휴일대체일 미지정" },
    ]);
    expect(rewardOptions([{ CD: "", CD_NM: "" }])).toHaveLength(3);
  });

  it("서버 목록이 있으면 그것을 쓴다", () => {
    expect(rewardOptions([{ CD: "100", CD_NM: "OT 누적" }])).toEqual([{ code: "100", name: "OT 누적" }]);
  });

  it("유형을 고르지 않았거나 목록에 없거나 대체휴일 날짜가 필요한 유형이면 막는다", () => {
    const options = rewardOptions([]);
    expect(() => pickRewardType(options, undefined)).toThrow("100 연장근무시간(OT) 누적");
    expect(() => pickRewardType(options, "999")).toThrow(ApplicationBlockedError);
    expect(() => pickRewardType(options, "200")).toThrow("지원하지 않는다");
    expect(pickRewardType(options, "300")).toEqual({ code: "300", name: "휴일대체일 미지정" });
  });
});

describe("checkResult", () => {
  const rows = (msg?: string): JadeResponse => ({ etc: {}, datasets: { Data: msg === undefined ? [] : [{ CHK_MSG: msg }] } });

  it("첫 행 CHK_MSG 가 OK 면 통과한다", () => {
    expect(() => checkResult(rows("OK"))).not.toThrow();
  });

  it("서버 메시지로 막는다", () => {
    expect(() => checkResult(rows("▶사전근무 신청은 사전에 신청해야 합니다."))).toThrow("사전근무 신청은 사전에 신청해야 합니다.");
  });

  it("결과 행이 없으면 화면처럼 상신하지 않는다 (경계: 0행)", () => {
    expect(() => checkResult(rows())).toThrow(ApplicationBlockedError);
  });
});

describe("prepareOvertime / commitOvertime", () => {
  const screens = { "/tam4/tm_day/tm_day_100_m01.jsp": applicationHtml(formScript(), FORM_INPUTS) };
  const weekday = (holiday = false) => (method: string): JadeResponse | undefined => {
    if (method === tok("WorkType")) {
      return holiday
        ? { etc: { WORK_TYPE: "휴일", WORK_TYPE_CD: "3010", WORK_DUTIE_YN: "N", SUB_ATTEND_CD: "5010", CHG_HOLI_ASGN_YN: "Y" }, datasets: {} }
        : { etc: { WORK_TYPE: "선택근무제", WORK_TYPE_CD: "2021", WORK_DUTIE_YN: "Y", WORK_YN: "Y" }, datasets: {} };
    }
    if (method === tok("Attend")) return { etc: { ATTEND_TXT: ",계획 : 09:00 ~ 18:00," }, datasets: {} };
    if (method === tok("Combo")) return { etc: {}, datasets: { Data: [] } };
    if (method === tok("Check")) return { etc: {}, datasets: { Data: [{ CHK_MSG: "OK" }] } };
    return undefined;
  };
  const req: OvertimeRequest = { date: "20261104", startHm: "0930", endHm: "0200", reason: "배포 대응" };

  it("화면 순서대로 채우고 검증까지만 부른다 — 상신(apply01)은 부르지 않는다", async () => {
    const { client, calls } = fakeClient(screens, weekday());
    const plan = await prepareOvertime(client, req);

    expect(calls.map((c) => c.method)).toEqual(["tok-searchAuth", "tok-getInitInfo", "tok-getCourse", tok("WorkType"), tok("Attend"), tok("Check")]);
    expect(plan.form).toMatchObject({
      S_WORK_YMD: "20261104",
      F_WORK_YMD: "2026.11.04",
      S_STA_YMD_CLASS: "2",
      S_END_YMD_CLASS: "3",
      S_STA_YMD: "20261104",
      S_END_YMD: "20261105",
      S_STA_HM: "0930",
      F_END_HM: "02:00",
      S_WORK_TYPE_CD: "2021",
      S_REWARD_TYPE: "",
      S_RSN: "배포 대응",
      S_TYPE: "BF_APPL",
    });
    expect(plan.preview).toMatchObject({ time: "2026.11.04 09:30 ~ 2026.11.05 02:00", attendance: "계획 : 09:00 ~ 18:00", rewardType: null });
  });

  it("휴일이면 대체/보상 유형 목록을 별도 클래스로 조회하고 고른 유형을 싣는다", async () => {
    const { client, calls } = fakeClient(screens, weekday(true));
    const plan = await prepareOvertime(client, { ...req, rewardType: "100" });
    expect(calls.find((c) => c.method === tok("Combo"))).toMatchObject({ dsClass: "cls-reward", params: { S_TARGET_EMP_ID: "E0001", S_STD_YMD: "20261103" } });
    expect(plan.form.S_REWARD_TYPE).toBe("100");
  });

  it("휴일인데 대체/보상 유형이 없으면 검증 전에 멈춘다", async () => {
    const { client, calls } = fakeClient(screens, weekday(true));
    await expect(prepareOvertime(client, req)).rejects.toThrow("rewardType");
    expect(calls.some((c) => c.method === tok("Check"))).toBe(false);
  });

  it("서버 검증이 막으면 그 메시지로 멈춘다", async () => {
    const { client } = fakeClient(screens, (m) => (m === tok("Check") ? { etc: {}, datasets: { Data: [{ CHK_MSG: "마감된 기간입니다." }] } } : weekday()(m)));
    await expect(prepareOvertime(client, req)).rejects.toThrow("마감된 기간입니다.");
  });

  it("근무유형을 못 받으면 멈춘다", async () => {
    const { client } = fakeClient(screens, (m) => (m === tok("WorkType") ? empty() : weekday()(m)));
    await expect(prepareOvertime(client, req)).rejects.toThrow(ApplicationBlockedError);
  });

  it("commit 은 검증을 다시 통과한 뒤 결재선에 상신한다", async () => {
    const { client, calls } = fakeClient(screens, weekday());
    const plan = await prepareOvertime(client, req);
    calls.length = 0;
    expect(await commitOvertime(client, plan)).toEqual({ applId: "APPL-NEW" });
    expect(calls.map((c) => c.method)).toEqual([tok("Check"), "tok-searchRetiree", "tok-apply01"]);
    expect(calls.at(-1)?.params).toMatchObject({ S_TEMP_APPR: "PATH-1", S_APPR_EMP_IDS: "E0002", S_TYPE: "BF_APPL", S_END_YMD: "20261105" });
  });
});
