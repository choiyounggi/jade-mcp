import { applicationBaseForm, ApplicationBlockedError, prepareEnvelope, submitApplication, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openNewApplication } from "./menu.js";
import { caseTokenOf, PageStructureError } from "./page.js";
import type { Row } from "./response.js";
import type { Params } from "./viewstate.js";

const CLOCK_FORM = { type: "1110", name: "출퇴근시각 등록 요청서", url: "/tam4/tm_day/tm_day_080_m01.jsp" } as const;
export const DEFAULT_CLOCK_REASON = "출/퇴근 시간 미등록으로 인한 등록 신청";

/** 화면의 「출/퇴근시각」 콤보(cbTAM010): 10 출근기록 · 20 퇴근기록 · 30 출퇴근기록. */
export type ClockKind = "in" | "out" | "both";
const IN_OUT_CLASS: Record<ClockKind, string> = { in: "10", out: "20", both: "30" };
const KIND_NAME: Record<ClockKind, string> = { in: "출근기록", out: "퇴근기록", both: "출퇴근기록" };
/** 당일/익일 콤보(cbTM102) 값. 화면 콤보에는 전일이 없다. */
const SAME_DAY = "2";
const NEXT_DAY = "3";
/** 출퇴근 기록 방식이 「근로자가 직접 입력(계획시간과 비교해 인정)」인 근무관리 코드 — 이때만 인정 시각이 따로 생긴다. */
const SWITCH_MANAGE = new Set(["0040", "0050", "0060", "0070"]);

export interface ClockRequest {
  /** 근무일 YYYYMMDD — 신청서 한 장에 하루. */
  date: string;
  kind: ClockKind;
  /** HHMM. kind 가 in·both 일 때 쓴다. */
  inHm?: string;
  /** HHMM. kind 가 out·both 일 때 쓴다. */
  outHm?: string;
  /** 퇴근이 다음 날 새벽이면 true (화면의 퇴근 「익일」). */
  outNextDay?: boolean;
  reason: string;
}

/** 출퇴근시각 등록 요청서 화면 JS 가 부르는 서버 메서드들. 토큰은 화면을 열 때마다 바뀌므로 호출 위치의 코드 모양으로 찾는다. */
export interface ClockRequestTokens {
  workType: string;
  attendText: string;
  validate: string;
  planCheck: string;
  attendManage: string;
  calcUnit: string;
  minStart: string;
  planCompare: string;
}

/** marker 앞에서 마지막으로 나오는 `ajaxSyncRequestXS($("#S_DSCLASS").val(), "<토큰>"` 의 토큰 — 콜백이 읽는 값으로 호출을 고른다. */
function callTokenBefore(html: string, marker: string, what: string): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new PageStructureError(what);
  const token = [...html.slice(0, at).matchAll(/ajaxSyncRequestXS\(\$\("#S_DSCLASS"\)\.val\(\),\s*"([^"]+)"/g)].at(-1)?.[1];
  if (!token) throw new PageStructureError(what);
  return token;
}

export function parseClockRequestTokens(html: string): ClockRequestTokens {
  const tokens: ClockRequestTokens = {
    workType: caseTokenOf(html, '$("#S_WORK_TYPE").val(xs.GetEtcData("WORK_TYPE"));', "근무유형 조회"),
    attendText: caseTokenOf(html, 'xs.GetEtcData("ATTEND_TXT")', "근태사항 조회"),
    // 같은 토큰의 주석 처리된 옛 분기(CHK_MSG)가 앞에 있다 — 살아 있는 분기의 코드로 찾는다.
    validate: caseTokenOf(html, 'S_ERRORCODE = xs.GetEtcData("ERRORCODE");', "신청 검증"),
    planCheck: caseTokenOf(html, 'xs.GetEtcData("PLAN_CHK_CONFIRM")', "근무계획 대비 검증"),
    attendManage: callTokenBefore(html, 'xs.GetCellValue(0, "ATTEND_MANAGE")', "출퇴근 계획 처리방법 조회"),
    calcUnit: callTokenBefore(html, 'xs.GetCellValue(0, "IN_CALC_ROUND")', "출퇴근 처리 단위 조회"),
    minStart: callTokenBefore(html, 'xs.GetCellValue(0, "MIN_STA_HM")', "최소 출근시각 조회"),
    planCompare: callTokenBefore(html, 'xs.GetCellValue(0, "ADJ_IN_HM")', "계획시간 비교"),
  };
  // 위치로 찾은 토큰이 서로 겹치면 화면 구조가 바뀐 것이다 — 엉뚱한 메서드를 부르지 않게 멈춘다.
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) throw new PageStructureError("출퇴근시각 등록 요청서 호출 토큰");
  return tokens;
}

/** 화면이 doValidation 에 박아 오는 서버의 오늘 — 이 날 이후는 신청할 수 없다. */
export function parseServerToday(html: string): string {
  const today = /\$\("#S_WORK_YMD"\)\.val\(\)\s*>\s*"(\d{8})"/.exec(html)?.[1];
  if (!today) throw new PageStructureError("신청 가능 기한(오늘 날짜)");
  return today;
}

function isRealYmd(ymd: string): boolean {
  if (!/^\d{8}$/.test(ymd)) return false;
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
  return ymdOf(d) === ymd;
}

function ymdOf(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** setYmd 의 addYmd(…, "D", 1) */
export function nextYmd(ymd: string): string {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + 1));
  return ymdOf(d);
}

const HM = /^([01]\d|2[0-3])[0-5]\d$/;

export function checkClockRequest(req: ClockRequest): void {
  if (!isRealYmd(req.date)) throw new ApplicationBlockedError(`근무일 ${req.date} 은 YYYYMMDD 형식의 실제 날짜여야 한다`);
  if (req.kind !== "out" && !HM.test(req.inHm ?? "")) throw new ApplicationBlockedError(`출근 시각 ${req.inHm ?? "(없음)"} 은 HHMM 형식이어야 한다`);
  if (req.kind !== "in" && !HM.test(req.outHm ?? "")) throw new ApplicationBlockedError(`퇴근 시각 ${req.outHm ?? "(없음)"} 은 HHMM 형식이어야 한다`);
  if (!req.reason.trim()) throw new ApplicationBlockedError("신청 사유가 비어 있다");
}

export interface RoundedTime {
  hm: string;
  nextDay: boolean;
}

/**
 * getInOutCalcUnit 의 출퇴근 처리 단위 맞춤(올림·버림). 분이 0 이거나 이미 단위에 맞으면 그대로 둔다.
 * 화면은 맞춘 분을 자리 맞춤 없이 이어 붙여 한 자리 분(예: 09:05)을 09:50 으로 만드는데, 그건 따르지 않고 두 자리로 쓴다.
 */
export function roundClockTime(hm: string, round: string, unit: string): RoundedTime {
  const same = { hm, nextDay: false };
  if (!round || !unit) return same;
  const u = Number(unit);
  if (!Number.isInteger(u) || u <= 0) throw new ApplicationBlockedError(`출퇴근 처리 단위 「${unit}」 를 해석할 수 없다 — JADE 화면에서 신청해야 한다`);
  const h = Number(hm.slice(0, 2));
  let m = Number(hm.slice(2, 4));
  if (m <= 0 || m % u === 0) return same;
  if (round === "올림") m = Math.floor(m / u + 1) * u;
  else if (round === "버림") m = Math.floor(m / u) * u;
  else return same;
  const total = h * 60 + m;
  if (total >= 24 * 60) return { hm: "0000", nextDay: true };
  return { hm: `${String(Math.floor(total / 60)).padStart(2, "0")}${String(total % 60).padStart(2, "0")}`, nextDay: false };
}

function firstRow(res: { datasets: Record<string, Row[]> }): Row | undefined {
  return Object.values(res.datasets)[0]?.[0];
}

function fmtYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function fmtHm(hm: string): string {
  return `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
}

/** 서버가 주는 시각(HHMM 이거나 YYYYMMDDHHMM…)을 HH:MM 으로. 모르는 모양은 그대로 둔다. */
function showTime(value: string | undefined): string {
  if (!value) return "";
  if (/^\d{4}$/.test(value)) return fmtHm(value);
  if (/^\d{12,14}$/.test(value)) return fmtHm(value.slice(8, 12));
  return value;
}

export interface ClockRequestPreview {
  date: string;
  kind: string;
  clockIn: string | null;
  clockOut: string | null;
  /** 출퇴근 처리 단위로 시각이 바뀐 경우 그 내역. */
  adjusted: string[];
  workType: string;
  plannedTime: string;
  currentlyRecorded: { clockIn: string; clockOut: string };
  /** 계획시간과 비교해 인정되는 시각 — 그런 근무관리 방식일 때만 화면이 보여 준다. */
  recognizedTime: string | null;
  attendance: string;
  reason: string;
  approvers: Approver[];
}

export interface ClockRequestPlan {
  request: ClockRequest;
  env: ApplicationEnvelope;
  form: Params;
  preview: ClockRequestPreview;
}

/** 출퇴근시각 등록 요청서를 상신 직전까지 채우고 화면의 서버 검증(신청 검증·근무계획 대비 검증)까지 통과시킨다. 저장·상신은 하지 않는다. */
export async function prepareClockRequest(client: JadeClient, req: ClockRequest): Promise<ClockRequestPlan> {
  checkClockRequest(req);
  return client.withSession(async (main) => {
    const { text, ctx } = await openNewApplication(client, main, CLOCK_FORM);
    const t = parseClockRequestTokens(text);
    const today = parseServerToday(text);
    if (req.date > today) {
      throw new ApplicationBlockedError(`출퇴근시각 등록은 오늘(${fmtYmd(today)})을 포함한 지난 근무일만 신청할 수 있다 — ${fmtYmd(req.date)} 은 안 된다`);
    }
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, CLOCK_FORM.type, emp);
    const call = (method: string, params: Params) => client.call(ctx, env.dsClass, method, params);
    const day = fmtYmd(req.date);
    const wantIn = req.kind !== "out";
    const wantOut = req.kind !== "in";

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields };
    Object.assign(form, {
      S_TARGET_EMP_ID: emp,
      S_TARGET_EMP_NM: ctx.inputs.S_LOGIN_EMP_NM ?? "",
      S_BEF_TARGET_EMP_ID: emp,
      F_WORK_YMD: day,
      S_WORK_YMD: req.date,
      S_IN_OUT_CLASS: IN_OUT_CLASS[req.kind],
      S_STA_YMD_CLASS: SAME_DAY,
      S_END_YMD_CLASS: wantOut && req.outNextDay ? NEXT_DAY : SAME_DAY,
    });

    // change_date("F_WORK_YMD") → doAction2: 근무유형과 근무계획, 근태사항
    const shift = (await call(t.workType, { ...form, S_DSMETHOD: t.workType })).etc;
    if (!shift.PLAN_CHK_YN) throw new ApplicationBlockedError(`${day} 에 근무조가 없어 출퇴근시각을 등록할 수 없다`);
    if (shift.PLAN_CHK_YN === "Y" && (!shift.P_IN_HM || !shift.P_OUT_HM)) {
      throw new ApplicationBlockedError(`${day} 에 근무계획 시간이 없어 출퇴근시각을 등록할 수 없다 — 근무일정을 먼저 등록해야 한다`);
    }
    Object.assign(form, { S_WORK_TYPE: shift.WORK_TYPE ?? "", S_WORK_TYPE_CD: shift.WORK_TYPE_CD ?? "" });
    const attendance = ((await call(t.attendText, { ...form, S_DSMETHOD: t.attendText })).etc.ATTEND_TXT ?? "").trim().replace(/^,+/, "").replace(/,$/, "");

    // change_date("F_STA_HM"/"F_END_HM"): 근무관리 방식 → 처리 단위 맞춤 → (출근) 최소 출근시각 → 계획시간 비교
    const manage = firstRow(await call(t.attendManage, { S_EMP_ID: emp, S_WORK_YMD: req.date })) ?? {};
    const attendManage = manage.ATTEND_MANAGE ?? "";
    const mainWorkType = manage.MAIN_WORK_TYPE_O ?? "";
    const unit = firstRow(await call(t.calcUnit, { S_WORK_TYPE: mainWorkType })) ?? {};
    Object.assign(form, { S_ATTEND_MANAGE: attendManage, S_MAIN_WORK_TYPE: mainWorkType });

    const adjusted: string[] = [];
    let inHm = "";
    let outHm = "";
    if (wantIn) {
      Object.assign(form, { S_IN_CALC_ROUND: unit.IN_CALC_ROUND ?? "", S_IN_CALC_UNIT: unit.IN_CALC_UNIT ?? "" });
      const r = roundClockTime(req.inHm!, unit.IN_CALC_ROUND ?? "", unit.IN_CALC_UNIT ?? "");
      inHm = r.hm;
      if (r.nextDay) form.S_STA_YMD_CLASS = NEXT_DAY;
      if (inHm !== req.inHm || r.nextDay) adjusted.push(`출근 ${fmtHm(req.inHm!)} → ${fmtHm(inHm)}${r.nextDay ? "(익일)" : ""} (출퇴근 처리 단위 ${unit.IN_CALC_UNIT}분 ${unit.IN_CALC_ROUND})`);

      const minRow = firstRow(await call(t.minStart, { S_EMP_ID: emp, S_WORK_YMD: req.date }));
      const minStart = minRow?.MIN_STA_HM ?? "";
      if (minStart && !/^\d{4}$/.test(minStart)) throw new PageStructureError("최소 출근시각(MIN_STA_HM) 형식");
      form.S_MIN_STA_HM = minStart;
      if (minStart && !r.nextDay && inHm < minStart) throw new ApplicationBlockedError(`출근 시각은 ${fmtHm(minStart)} 이후여야 한다`);
    }
    if (wantOut) {
      Object.assign(form, { S_OUT_CALC_ROUND: unit.OUT_CALC_ROUND ?? "", S_OUT_CALC_UNIT: unit.OUT_CALC_UNIT ?? "" });
      const r = roundClockTime(req.outHm!, unit.OUT_CALC_ROUND ?? "", unit.OUT_CALC_UNIT ?? "");
      outHm = r.hm;
      if (r.nextDay) form.S_END_YMD_CLASS = NEXT_DAY;
      if (outHm !== req.outHm || r.nextDay) adjusted.push(`퇴근 ${fmtHm(req.outHm!)} → ${fmtHm(outHm)}${r.nextDay ? "(익일)" : ""} (출퇴근 처리 단위 ${unit.OUT_CALC_UNIT}분 ${unit.OUT_CALC_ROUND})`);
    }

    // setYmd: 당일/익일 구분을 날짜로
    const staYmd = form.S_STA_YMD_CLASS === NEXT_DAY ? nextYmd(req.date) : req.date;
    const endYmd = form.S_END_YMD_CLASS === NEXT_DAY ? nextYmd(req.date) : req.date;
    if (req.kind === "both" && `${staYmd}${inHm}` > `${endYmd}${outHm}`) throw new ApplicationBlockedError("퇴근 시각이 출근 시각보다 빠르다 — 다음 날 퇴근이면 outNextDay 를 켠다");

    // 화면은 시각을 고친 뒤 칸을 다시 벗어나면 맞춘 시각으로 계획시간을 다시 비교한다 — 그 최종 상태로 보낸다.
    const cmp = firstRow(
      await call(t.planCompare, {
        S_EMP_ID: emp,
        S_WORK_YMD: req.date,
        S_ATTEND_MANAGE: attendManage,
        S_A_IN_HM: inHm,
        S_A_OUT_HM: outHm,
        S_STA_YMD_CLASS: form.S_STA_YMD_CLASS,
        S_END_YMD_CLASS: form.S_END_YMD_CLASS,
      }),
    );
    if (!cmp) throw new ApplicationBlockedError(`${day} 의 계획시간 비교 결과를 JADE 가 주지 않았다`);
    const adjIn = cmp.ADJ_IN_HM ?? "";
    const adjOut = cmp.ADJ_OUT_HM ?? "";
    // 출근만·퇴근만 신청하면 반대쪽 조정 시각은 이미 찍힌 기록을 그대로 쓴다.
    Object.assign(form, {
      S_ADJ_STA_YMD: wantIn ? adjIn.slice(0, 8) : (cmp.C_IN_YMD ?? ""),
      S_ADJ_END_YMD: wantOut ? adjOut.slice(0, 8) : (cmp.C_OUT_YMD ?? ""),
      S_ADJ_STA_HM: wantIn ? adjIn.slice(8, 12) : (cmp.C_IN_HM ?? ""),
      S_ADJ_END_HM: wantOut ? adjOut.slice(8, 12) : (cmp.C_OUT_HM ?? ""),
    });
    // 계획시간이 없으면 인정 시각 없이 신청 시각이 그대로 확정된다.
    const switchYn = SWITCH_MANAGE.has(attendManage) && !(!cmp.P_IN_HM && !cmp.P_OUT_HM) ? "Y" : "N";

    Object.assign(form, {
      S_SWITCH_YN: switchYn,
      F_STA_HM: inHm ? fmtHm(inHm) : "",
      F_END_HM: outHm ? fmtHm(outHm) : "",
      S_STA_YMD: staYmd,
      S_END_YMD: endYmd,
      S_RSN: req.reason,
      S_APPL_DTL_TXT: "",
      // inputAutoUnformat 이 시간 칸(F_*)마다 만드는 숫자형 사본
      S_STA_HM: inHm,
      S_END_HM: outHm,
    });

    await validate(client, env, t, form);

    const recognized = [wantIn ? showTime(adjIn) : "", wantOut ? showTime(adjOut) : ""].filter(Boolean);
    return {
      request: req,
      env,
      form,
      preview: {
        date: day,
        kind: KIND_NAME[req.kind],
        clockIn: inHm ? `${fmtHm(inHm)}${form.S_STA_YMD_CLASS === NEXT_DAY ? " (익일)" : ""}` : null,
        clockOut: outHm ? `${fmtHm(outHm)}${form.S_END_YMD_CLASS === NEXT_DAY ? " (익일)" : ""}` : null,
        adjusted,
        workType: shift.WORK_TYPE ?? "",
        plannedTime: shift.P_IN_HM && shift.P_OUT_HM ? `${showTime(shift.P_IN_HM)} ~ ${showTime(shift.P_OUT_HM)}` : "",
        currentlyRecorded: { clockIn: showTime(cmp.C_IN_HM), clockOut: showTime(cmp.C_OUT_HM) },
        recognizedTime: switchYn === "Y" ? recognized.join(" ~ ") : null,
        attendance,
        reason: req.reason,
        approvers: env.approvers,
      },
    };
  });
}

/** doValidation 의 서버 검증 두 가지: 신청 검증(ERRORCODE), 근무계획 대비 검증(출퇴근기록이면 출근·퇴근 따로 한 번씩). */
async function validate(client: JadeClient, env: ApplicationEnvelope, t: ClockRequestTokens, form: Params): Promise<void> {
  const res = await client.call(env.ctx, env.dsClass, t.validate, { ...form, S_DSMETHOD: t.validate });
  // 화면은 `!= '0'` 로 느슨하게 비교한다 — 숫자 0 으로 와도 통과로 본다.
  if (String(res.etc.ERRORCODE ?? "") !== "0") {
    const msg = (res.etc.ERRORMESG ?? "").replaceAll("▶", "").trim();
    throw new ApplicationBlockedError(msg || "JADE 가 신청 검증 결과를 주지 않았다");
  }
  const classes = form.S_IN_OUT_CLASS === IN_OUT_CLASS.both ? [IN_OUT_CLASS.in, IN_OUT_CLASS.out] : [String(form.S_IN_OUT_CLASS)];
  for (const cls of classes) {
    const r = await client.call(env.ctx, env.dsClass, t.planCheck, { ...form, S_IN_OUT_CLASS: cls, S_DSMETHOD: t.planCheck });
    for (const key of ["PLAN_CHK_CONFIRM", "CONFIRM"]) {
      const msg = r.etc[key] ?? "";
      if (msg !== "OK") throw new ApplicationBlockedError(msg ? msg.trim() : "JADE 가 근무계획 대비 검증 결과를 주지 않았다");
    }
  }
}

export interface ClockRequestBatch {
  plans: ClockRequestPlan[];
  skipped: { date: string; reason: string }[];
}

/** 여러 근무일을 날짜마다 한 장씩 준비한다. 화면이 막는 날은 건너뛰고 그 사유를 돌려준다. */
export async function prepareClockRequests(client: JadeClient, base: Omit<ClockRequest, "date">, dates: string[]): Promise<ClockRequestBatch> {
  if (dates.length === 0) throw new ApplicationBlockedError("근무일을 하나 이상 줘야 한다");
  const batch: ClockRequestBatch = { plans: [], skipped: [] };
  for (const date of [...new Set(dates)].sort()) {
    try {
      batch.plans.push(await prepareClockRequest(client, { ...base, date }));
    } catch (e) {
      if (!(e instanceof ApplicationBlockedError)) throw e;
      batch.skipped.push({ date: isRealYmd(date) ? fmtYmd(date) : date, reason: e.message });
    }
  }
  return batch;
}

export type ClockRequestApproval = Pick<ClockRequestPlan, "request" | "preview">;

/**
 * 승인된 출퇴근시각 등록 요청서 한 장을 상신한다. 여러 날을 미리 준비하면 먼저 연 화면의 요청 값이 낡을 수 있어,
 * 화면을 새로 열어 검증까지 다시 통과시키고 미리보기와 같을 때만 보낸다.
 */
export async function commitClockRequest(client: JadeClient, approved: ClockRequestApproval): Promise<{ date: string; applId: string }> {
  const plan = await prepareClockRequest(client, approved.request);
  if (JSON.stringify(plan.preview) !== JSON.stringify(approved.preview)) {
    throw new ApplicationBlockedError(`${approved.preview.date} 신청 내용이 미리보기 이후 바뀌었다 — prepare 부터 다시 해야 한다`);
  }
  return { date: approved.preview.date, applId: await submitApplication(client, plan.env, plan.form) };
}
