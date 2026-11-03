import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import type { JadeClient } from "../src/client.js";
import {
  checkClockRequest,
  commitClockRequest,
  DEFAULT_CLOCK_REASON,
  nextYmd,
  parseClockRequestTokens,
  parseServerToday,
  prepareClockRequest,
  prepareClockRequests,
  roundClockTime,
  type ClockRequest,
} from "../src/clock-request.js";
import { PageStructureError, parsePage, type PageContext } from "../src/page.js";
import type { JadeResponse, Row } from "../src/response.js";
import type { Params } from "../src/viewstate.js";

// 실제 화면 JS 를 그대로 두고 토큰·개인정보만 가짜로 바꾼 축약본
const FORM = readFileSync(new URL("./fixtures/clock-request/form.html", import.meta.url), "utf8");
const T = parseClockRequestTokens(FORM);
const APPLY = parsePage(FORM).otp.ApplyOtpVal!;

const MAIN: PageContext = {
  openTime: "1",
  otpKey: "k",
  csrfSalt: "s",
  hasMaskingVars: false,
  page: {},
  inputs: {},
  otp: { hunelOtpVal: { Sy_main_page: "main-cls", searchAuth: "main-auth" } },
};

const etc = (e: Record<string, string>): JadeResponse => ({ etc: e, datasets: {} });
const data = (rows: Row[]): JadeResponse => ({ etc: {}, datasets: { Data: rows } });

type Overrides = Partial<Record<keyof typeof T | "apply01", (p: Params) => JadeResponse>>;

function fakeClient(over: Overrides = {}, html = FORM) {
  const calls: { method: string; params: Params }[] = [];
  const routes: Record<string, (p: Params) => JadeResponse> = {
    "main-auth": () => etc({ PROFILE_ID: "ESS", MODULE_ID: "m", MENU_ID: "n", ENC_VAL: "e" }),
    [APPLY.getInitInfo!]: () => ({ etc: { S_APPL_TX_TOKEN: "tx-1" }, datasets: { ApplType: [{ APPR_PRS_YN: "Y", APPL_TO_ME: "N", PROC_FLAG: "10" }] } }),
    [APPLY.getCourse!]: () => ({ etc: {}, datasets: { ApprLine: [{ COL2: "P1", COL4: "Y" }], LineDetail: [{ COL3: "90000001", COL4: "결재자", COL5: "팀장", COL10: "10" }] } }),
    [APPLY.searchRetiree!]: () => etc({ RET_STAT: "Y" }),
    [APPLY.apply01!]: over.apply01 ?? (() => etc({ APPL_ID: "A-100" })),
    [T.workType]: over.workType ?? (() => etc({ WORK_TYPE: "선택근무제(IT)", WORK_TYPE_CD: "2021", PLAN_CHK_YN: "N", P_IN_HM: "0930", P_OUT_HM: "1830" })),
    [T.attendText]: over.attendText ?? (() => etc({ ATTEND_TXT: ",계획 : 09:30 ~ 18:30," })),
    [T.attendManage]: over.attendManage ?? (() => data([{ ATTEND_MANAGE: "0040", MAIN_WORK_TYPE_O: "2021" }])),
    [T.calcUnit]: over.calcUnit ?? (() => data([])),
    [T.minStart]: over.minStart ?? (() => data([])),
    [T.planCompare]: over.planCompare ?? ((p) => data([planRow(p)])),
    [T.validate]: over.validate ?? (() => etc({ ERRORCODE: "0", ERRORMESG: "" })),
    [T.planCheck]: over.planCheck ?? (() => etc({ PLAN_CHK_CONFIRM: "OK", CONFIRM: "OK" })),
  };
  const client = {
    withSession: <R>(fn: (main: PageContext) => Promise<R>) => fn(MAIN),
    openScreen: async () => ({ text: html, ctx: parsePage(html) }),
    call: async (_ctx: PageContext, _cls: string, method: string, params: Params = {}) => {
      calls.push({ method, params });
      const route = routes[method];
      if (!route) throw new Error(`unexpected call ${method}`);
      return route(params);
    },
  } as unknown as JadeClient;
  const names = Object.fromEntries([...Object.entries(T), ...Object.entries(APPLY)].map(([k, v]) => [v, k]));
  return { client, calls, called: () => calls.map((c) => names[c.method] ?? c.method) };
}

/** 계획시간 비교: 신청 시각을 조정 시각으로 돌려주고, 이미 찍힌 기록은 비어 있는 날 */
function planRow(p: Params, recorded: Row = { C_IN_YMD: "", C_IN_HM: "", C_OUT_YMD: "", C_OUT_HM: "" }): Row {
  const ymd = String(p.S_WORK_YMD);
  return { ADJ_IN_HM: `${ymd}${p.S_A_IN_HM || "0000"}`, ADJ_OUT_HM: `${ymd}${p.S_A_OUT_HM || "0000"}`, P_IN_HM: "0930", P_OUT_HM: "1830", ...recorded };
}

const both: ClockRequest = { date: "20261102", kind: "both", inHm: "0930", outHm: "1830", reason: DEFAULT_CLOCK_REASON };

describe("parseClockRequestTokens", () => {
  it("실제 화면에서 여덟 호출의 토큰을 서로 다르게 찾는다", () => {
    expect(new Set(Object.values(T)).size).toBe(8);
  });

  it("주석 처리된 옛 검증 분기가 아니라 살아 있는 분기의 토큰을 잡는다", () => {
    const at = FORM.indexOf('S_ERRORCODE = xs.GetEtcData("ERRORCODE");');
    expect(FORM.lastIndexOf(`case "${T.validate}"`, at)).toBeGreaterThan(FORM.indexOf("*/", FORM.indexOf('GetCellValue(0, "CHK_MSG")')));
  });

  it("신청 검증 분기가 없으면 요청 없이 멈춘다", () => {
    expect(() => parseClockRequestTokens(FORM.replace('S_ERRORCODE = xs.GetEtcData("ERRORCODE");', ""))).toThrow(PageStructureError);
  });

  it("계획시간 비교 호출이 없으면 멈춘다", () => {
    expect(() => parseClockRequestTokens(FORM.replaceAll('xs.GetCellValue(0, "ADJ_IN_HM")', ""))).toThrow(PageStructureError);
  });
});

describe("parseServerToday", () => {
  it("화면이 박아 오는 오늘을 읽는다", () => {
    expect(parseServerToday(FORM)).toBe("20261103");
  });

  it("없으면 멈춘다", () => {
    expect(() => parseServerToday("<script></script>")).toThrow(PageStructureError);
  });
});

describe("checkClockRequest", () => {
  it("출퇴근 둘 다 있는 요청을 받는다", () => {
    expect(() => checkClockRequest(both)).not.toThrow();
  });

  it("출근만이면 퇴근 시각이 없어도 된다", () => {
    expect(() => checkClockRequest({ date: "20261102", kind: "in", inHm: "0930", reason: "r" })).not.toThrow();
  });

  it("없는 날짜를 막는다 (경계: 11월 31일)", () => {
    expect(() => checkClockRequest({ ...both, date: "20261131" })).toThrow(ApplicationBlockedError);
  });

  it("필요한 시각이 없거나 틀리면 막는다", () => {
    expect(() => checkClockRequest({ ...both, outHm: undefined })).toThrow("퇴근 시각");
    expect(() => checkClockRequest({ ...both, inHm: "2400" })).toThrow("출근 시각");
  });

  it("빈 사유를 막는다", () => {
    expect(() => checkClockRequest({ ...both, reason: "  " })).toThrow("사유");
  });
});

describe("roundClockTime", () => {
  it("단위가 없으면 그대로 둔다", () => {
    expect(roundClockTime("0903", "", "")).toEqual({ hm: "0903", nextDay: false });
  });

  it("올림·버림을 두 자리 분으로 맞춘다", () => {
    expect(roundClockTime("0903", "올림", "5")).toEqual({ hm: "0905", nextDay: false });
    expect(roundClockTime("1837", "버림", "10")).toEqual({ hm: "1830", nextDay: false });
  });

  it("정각·단위에 맞는 분은 그대로 둔다 (경계)", () => {
    expect(roundClockTime("0900", "올림", "10")).toEqual({ hm: "0900", nextDay: false });
    expect(roundClockTime("0920", "올림", "10")).toEqual({ hm: "0920", nextDay: false });
  });

  it("올림이 시·날짜를 넘기면 다음 시·익일 0시가 된다", () => {
    expect(roundClockTime("0955", "올림", "30")).toEqual({ hm: "1000", nextDay: false });
    expect(roundClockTime("2350", "올림", "30")).toEqual({ hm: "0000", nextDay: true });
  });

  it("해석할 수 없는 단위면 막는다", () => {
    expect(() => roundClockTime("0903", "올림", "0")).toThrow(ApplicationBlockedError);
  });
});

describe("nextYmd", () => {
  it("월말을 넘긴다", () => {
    expect(nextYmd("20261130")).toBe("20261201");
    expect(nextYmd("20261231")).toBe("20270101");
  });
});

describe("prepareClockRequest", () => {
  it("출퇴근기록: 화면 순서로 조회·검증하고 상신은 하지 않는다", async () => {
    const f = fakeClient();
    const plan = await prepareClockRequest(f.client, both);
    expect(f.called()).toEqual([
      "main-auth",
      "getInitInfo",
      "getCourse",
      "workType",
      "attendText",
      "attendManage",
      "calcUnit",
      "minStart",
      "planCompare",
      "validate",
      "planCheck",
      "planCheck",
    ]);
    // 출퇴근기록은 근무계획 검증을 출근(10)·퇴근(20)으로 한 번씩 한다.
    expect(f.calls.filter((c) => c.method === T.planCheck).map((c) => c.params.S_IN_OUT_CLASS)).toEqual(["10", "20"]);
    expect(plan.form).toMatchObject({
      S_IN_OUT_CLASS: "30",
      F_WORK_YMD: "2026.11.02",
      S_WORK_YMD: "20261102",
      F_STA_HM: "09:30",
      S_STA_HM: "0930",
      F_END_HM: "18:30",
      S_END_HM: "1830",
      S_STA_YMD: "20261102",
      S_END_YMD: "20261102",
      S_ADJ_STA_YMD: "20261102",
      S_ADJ_STA_HM: "0930",
      S_ADJ_END_HM: "1830",
      S_SWITCH_YN: "Y",
      S_WORK_TYPE: "선택근무제(IT)",
      S_WORK_TYPE_CD: "2021",
      S_RSN: DEFAULT_CLOCK_REASON,
      S_TARGET_EMP_ID: "10000001",
    });
    expect(plan.preview).toMatchObject({
      date: "2026.11.02",
      kind: "출퇴근기록",
      clockIn: "09:30",
      clockOut: "18:30",
      plannedTime: "09:30 ~ 18:30",
      recognizedTime: "09:30 ~ 18:30",
      attendance: "계획 : 09:30 ~ 18:30",
    });
  });

  it("출근만: 반대쪽 조정 시각은 이미 찍힌 퇴근 기록을 쓰고 근무계획 검증은 한 번이다", async () => {
    const recorded = { C_IN_YMD: "", C_IN_HM: "", C_OUT_YMD: "20261102", C_OUT_HM: "1902" };
    const f = fakeClient({ planCompare: (p) => data([planRow(p, recorded)]) });
    const plan = await prepareClockRequest(f.client, { date: "20261102", kind: "in", inHm: "0930", reason: "r" });
    expect(plan.form).toMatchObject({ S_IN_OUT_CLASS: "10", S_STA_HM: "0930", S_END_HM: "", F_END_HM: "", S_ADJ_END_YMD: "20261102", S_ADJ_END_HM: "1902" });
    expect(plan.preview).toMatchObject({ clockOut: null, recognizedTime: "09:30", currentlyRecorded: { clockIn: "", clockOut: "19:02" } });
    expect(f.calls.filter((c) => c.method === T.planCheck)).toHaveLength(1);
  });

  it("퇴근만·익일: 퇴근일이 다음 날(월말 넘김)이고 최소 출근시각은 보지 않는다", async () => {
    const f = fakeClient();
    const plan = await prepareClockRequest(f.client, { date: "20261030", kind: "out", outHm: "0130", outNextDay: true, reason: "r" });
    expect(plan.form).toMatchObject({ S_IN_OUT_CLASS: "20", S_END_YMD_CLASS: "3", S_END_YMD: "20261031", S_STA_HM: "" });
    expect(plan.preview.clockOut).toBe("01:30 (익일)");
    expect(f.called()).not.toContain("minStart");
  });

  it("출퇴근 처리 단위가 있으면 시각을 맞추고 그 내역을 미리보기에 남긴다", async () => {
    const f = fakeClient({ calcUnit: () => data([{ IN_CALC_ROUND: "올림", IN_CALC_UNIT: "10", OUT_CALC_ROUND: "버림", OUT_CALC_UNIT: "10" }]) });
    const plan = await prepareClockRequest(f.client, { ...both, inHm: "0921", outHm: "1839" });
    expect(plan.form).toMatchObject({ S_STA_HM: "0930", S_END_HM: "1830" });
    expect(plan.preview.adjusted).toHaveLength(2);
    expect(f.calls.find((c) => c.method === T.planCompare)!.params).toMatchObject({ S_A_IN_HM: "0930", S_A_OUT_HM: "1830" });
  });

  it("오늘 이후 날짜는 결재선 조회 전에 막는다", async () => {
    const f = fakeClient();
    await expect(prepareClockRequest(f.client, { ...both, date: "20261104" })).rejects.toThrow("지난 근무일만");
    expect(f.called()).toEqual(["main-auth"]);
  });

  it("오늘(경계)은 신청할 수 있다", async () => {
    await expect(prepareClockRequest(fakeClient().client, { ...both, date: "20261103" })).resolves.toBeDefined();
  });

  it("근무조가 없는 날은 막는다", async () => {
    const f = fakeClient({ workType: () => etc({ PLAN_CHK_YN: "" }) });
    await expect(prepareClockRequest(f.client, both)).rejects.toThrow("근무조");
  });

  it("계획 확인이 필요한데 계획시간이 없으면 막는다", async () => {
    const f = fakeClient({ workType: () => etc({ PLAN_CHK_YN: "Y", P_IN_HM: "", P_OUT_HM: "" }) });
    await expect(prepareClockRequest(f.client, both)).rejects.toThrow("근무계획 시간");
  });

  it("최소 출근시각보다 이르면 막는다", async () => {
    const f = fakeClient({ minStart: () => data([{ MIN_STA_HM: "0700" }]) });
    await expect(prepareClockRequest(f.client, { ...both, inHm: "0659" })).rejects.toThrow("07:00 이후");
  });

  it("퇴근이 출근보다 빠르면 막는다", async () => {
    await expect(prepareClockRequest(fakeClient().client, { ...both, inHm: "1830", outHm: "0930" })).rejects.toThrow("outNextDay");
  });

  it("서버 신청 검증이 오류를 주면 그 메시지로 막는다", async () => {
    const f = fakeClient({ validate: () => etc({ ERRORCODE: "-1", ERRORMESG: "▶이미 신청된 근무일입니다." }) });
    await expect(prepareClockRequest(f.client, both)).rejects.toThrow("이미 신청된 근무일입니다.");
    expect(f.called()).not.toContain("planCheck");
  });

  it("근무계획 대비 검증이 OK 가 아니면 막는다", async () => {
    const f = fakeClient({ planCheck: (p) => etc({ PLAN_CHK_CONFIRM: "OK", CONFIRM: p.S_IN_OUT_CLASS === "20" ? "퇴근 시각을 확인하세요" : "OK" }) });
    await expect(prepareClockRequest(f.client, both)).rejects.toThrow("퇴근 시각을 확인하세요");
  });

  it("화면 구조가 다르면 결재선 조회 없이 멈춘다", async () => {
    const f = fakeClient({}, FORM.replaceAll('xs.GetEtcData("PLAN_CHK_CONFIRM")', ""));
    await expect(prepareClockRequest(f.client, both)).rejects.toThrow(PageStructureError);
    expect(f.called()).toEqual(["main-auth"]);
  });

  it("상신(apply01)은 부르지 않는다", async () => {
    const f = fakeClient();
    await prepareClockRequest(f.client, both);
    expect(f.calls.some((c) => c.method === APPLY.apply01 || c.method === APPLY.save01)).toBe(false);
  });
});

describe("prepareClockRequests", () => {
  it("날짜마다 한 장씩 준비하고 막힌 날은 사유와 함께 건너뛴다", async () => {
    const f = fakeClient();
    const batch = await prepareClockRequests(f.client, { kind: "both", inHm: "0930", outHm: "1830", reason: "r" }, ["20261104", "20261102", "20261102"]);
    expect(batch.plans.map((p) => p.preview.date)).toEqual(["2026.11.02"]);
    expect(batch.skipped).toEqual([{ date: "2026.11.04", reason: expect.stringContaining("지난 근무일만") }]);
  });

  it("날짜가 없으면 막는다", async () => {
    await expect(prepareClockRequests(fakeClient().client, { kind: "in", inHm: "0930", reason: "r" }, [])).rejects.toThrow(ApplicationBlockedError);
  });
});

describe("commitClockRequest", () => {
  it("화면을 새로 열어 미리보기와 같을 때만 상신한다", async () => {
    const plan = await prepareClockRequest(fakeClient().client, both);
    const f = fakeClient();
    await expect(commitClockRequest(f.client, { request: plan.request, preview: plan.preview })).resolves.toEqual({ date: "2026.11.02", applId: "A-100" });
    const apply = f.calls.find((c) => c.method === APPLY.apply01)!;
    expect(apply.params).toMatchObject({ S_APPL_TX_TOKEN: "tx-1", S_APPR_EMP_IDS: "90000001", S_IN_OUT_CLASS: "30", S_STA_HM: "0930", S_END_HM: "1830" });
  });

  it("미리보기 이후 내용이 바뀌었으면 상신하지 않는다", async () => {
    const plan = await prepareClockRequest(fakeClient().client, both);
    const f = fakeClient({ attendText: () => etc({ ATTEND_TXT: "출근 : 09:10" }) });
    await expect(commitClockRequest(f.client, { request: plan.request, preview: plan.preview })).rejects.toThrow("바뀌었다");
    expect(f.calls.some((c) => c.method === APPLY.apply01)).toBe(false);
  });
});
