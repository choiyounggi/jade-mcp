import { applicationBaseForm, prepareEnvelope, submitApplication, ApplicationBlockedError, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openNewApplication } from "./menu.js";
import { caseTokenOf, PageStructureError } from "./page.js";
import type { Row } from "./response.js";
import { fetchCalendar } from "./schedule.js";
import type { Params } from "./viewstate.js";

const REMOTE_FORM = { type: "1130", name: "재택 근무 신청서", url: "/tam4/tm_day/tm_day_170_m01.jsp" } as const;
const REMOTE_WORK_NAME = "재택근무제";
/** 근무유형 콤보에 있지만 근무일이 아닌 항목. 「(X)」 유형은 화면의 서버 목록 대체본에서도 빠지는 휴무 계열이다. */
const NON_WORK_NAMES = new Set(["휴일", "선택불가"]);
export const isWorkName = (name: string) => !NON_WORK_NAMES.has(name) && !name.endsWith("(X)");
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_KO: Record<Weekday, string> = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금" };

export interface RemoteWorkTokens {
  orgWorkType: string;
  workTypes: string;
  closeCheck: string;
}

/** 재택 근무 신청서 화면 JS(doAction2)의 호출 토큰. 토큰은 화면을 열 때마다 바뀌므로 분기 안의 코드 모양으로 찾는다. */
export function parseRemoteWorkTokens(html: string): RemoteWorkTokens {
  const tokens: RemoteWorkTokens = {
    orgWorkType: caseTokenOf(html, '$("#S_ORG_WORK_TYPE").val("");', "원근무유형 조회"),
    workTypes: caseTokenOf(html, '$("#S_WORK_TYPE").empty();', "변경근무유형 목록 조회"),
    closeCheck: caseTokenOf(html, 'var msg = xs.GetEtcData("rtnMsg");', "마감 검사"),
  };
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) throw new PageStructureError("재택 근무 신청서 호출 토큰");
  return tokens;
}

/** 화면이 LoadPage 에서 S_WORK_TYPE 에 까는 기본 근무유형 목록(`이름□코드■…`). 서버 목록이 비면 화면도 이것을 쓴다. */
export function parseDefaultWorkTypes(html: string): { code: string; name: string }[] {
  const raw = /setCombo\("([^"]*)",\s*"S_WORK_TYPE"/.exec(html)?.[1];
  if (!raw) throw new PageStructureError("기본 근무유형 목록");
  return raw.split("■").map((item) => {
    const [name = "", code = ""] = item.split("□");
    return { code, name };
  });
}

function ymdOf(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 이 맥의 오늘 YYYYMMDD */
export function localYmd(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/**
 * 그 달에 속한 주(월~금)의 월요일들. 금요일이 그 달에 있는 주가 그 달의 주다 —
 * 첫 평일이 든 주부터, 평일이 다음 달로 넘어가지 않는 주까지와 같다. 첫 주의 월요일은 전달일 수 있다.
 */
export function weeksOfMonth(month: string): Date[] {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(month)) throw new ApplicationBlockedError("월은 YYYYMM 형식이어야 한다");
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(4, 6)) - 1;
  const first = new Date(Date.UTC(year, mon, 1));
  // 1일 이후 첫 금요일이 첫 주의 금요일이다.
  let friday = addDays(first, (5 - first.getUTCDay() + 7) % 7);
  const weeks: Date[] = [];
  while (friday.getUTCMonth() === mon) {
    weeks.push(addDays(friday, -4));
    friday = addDays(friday, 7);
  }
  return weeks;
}

export interface CalendarCell {
  ymd: string;
  workType: string;
  remarks: string[];
}

export interface RemoteWorkSchedule {
  dates: string[];
  skipped: { week: string; reason: string }[];
}

function fmtYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

/**
 * 그 달 각 주의 요청 요일을 고른다. 주중(월~금)에 공휴일이 있거나 휴가 표시가 있는 주는 통째로 뺀다.
 * workNames 는 근무일로 볼 근무유형 이름 — 달력 칸의 근무유형이 이 목록에 없으면(개천절·휴일 등) 쉬는 날이다.
 */
export function planRemoteWorkDates(
  month: string,
  weekday: Weekday,
  calendar: CalendarCell[],
  workNames: Set<string>,
  today: string,
): RemoteWorkSchedule {
  const byYmd = new Map(calendar.map((c) => [c.ymd, c]));
  const offset = WEEKDAYS.indexOf(weekday);
  const result: RemoteWorkSchedule = { dates: [], skipped: [] };
  for (const monday of weeksOfMonth(month)) {
    const days = [0, 1, 2, 3, 4].map((i) => ymdOf(addDays(monday, i)));
    const week = `${fmtYmd(days[0]!)} ~ ${fmtYmd(days[4]!)}`;
    const target = days[offset]!;
    const cells = days.map((ymd) => byYmd.get(ymd));
    const missing = days.filter((_, i) => !cells[i]);
    if (missing.length) {
      result.skipped.push({ week, reason: `달력 정보 없음 (${missing.map(fmtYmd).join(", ")})` });
      continue;
    }
    const holidays = cells.filter((c) => !workNames.has(c!.workType));
    if (holidays.length) {
      result.skipped.push({ week, reason: `공휴일·휴일 포함 (${holidays.map((c) => `${fmtYmd(c!.ymd)} ${c!.workType || "근무유형 없음"}`).join(", ")})` });
      continue;
    }
    const leaves = cells.filter((c) => c!.remarks.some((r) => /휴가|반차/.test(r)));
    if (leaves.length) {
      result.skipped.push({ week, reason: `휴가 포함 (${leaves.map((c) => `${fmtYmd(c!.ymd)} ${c!.remarks.join("·")}`).join(", ")})` });
      continue;
    }
    const cell = byYmd.get(target)!;
    if (target <= today) {
      result.skipped.push({ week, reason: `${fmtYmd(target)} 은 오늘이거나 지난 날짜` });
      continue;
    }
    if (cell.workType === REMOTE_WORK_NAME) {
      result.skipped.push({ week, reason: `${fmtYmd(target)} 은 이미 재택근무제` });
      continue;
    }
    result.dates.push(target);
  }
  return result;
}

/** 신청 사유 — "11월 2일 재택근무 신청드립니다." */
export function remoteWorkReason(ymd: string): string {
  return `${Number(ymd.slice(4, 6))}월 ${Number(ymd.slice(6, 8))}일 재택근무 신청드립니다.`;
}

export interface RemoteWorkPlan {
  env: ApplicationEnvelope;
  tokens: RemoteWorkTokens;
  form: Params;
  preview: {
    date: string;
    orgWorkType: string;
    workType: string;
    reason: string;
    approvers: Approver[];
  };
}

function firstDataset(res: { datasets: Record<string, Row[]> }): Row[] {
  return Object.values(res.datasets)[0] ?? [];
}

async function closeCheck(client: JadeClient, env: ApplicationEnvelope, method: string, form: Params): Promise<void> {
  const res = await client.call(env.ctx, env.dsClass, method, { ...form, S_DSMETHOD: method });
  const msg = res.etc.rtnMsg ?? "";
  if (msg !== "OK") throw new ApplicationBlockedError(msg ? msg.trim() : "JADE 가 마감 검사 결과를 주지 않았다");
}

/** 하루치 재택 근무 신청서를 상신 직전까지 채우고 마감 검사까지 통과시킨다. 저장·상신은 하지 않는다. */
export async function prepareRemoteWork(client: JadeClient, req: { date: string; reason: string }): Promise<RemoteWorkPlan> {
  if (!/^\d{8}$/.test(req.date)) throw new ApplicationBlockedError("날짜는 YYYYMMDD 형식이어야 한다");
  if (!req.reason.trim()) throw new ApplicationBlockedError("신청 사유가 비어 있다");
  // 화면은 지난 날짜를 브라우저(checkWordymd)에서만 막으므로 여기서도 막는다.
  if (req.date <= localYmd()) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 은 오늘이거나 지난 날짜다`);
  return client.withSession(async (main) => {
    const { text, ctx } = await openNewApplication(client, main, REMOTE_FORM);
    const t = parseRemoteWorkTokens(text);
    const defaults = parseDefaultWorkTypes(text);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, REMOTE_FORM.type, emp);
    const call = (method: string, params: Params) => client.call(ctx, env.dsClass, method, params);

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields };
    Object.assign(form, {
      S_TARGET_EMP_ID: emp,
      S_TARGET_EMP_NM: ctx.inputs.S_LOGIN_EMP_NM ?? "",
      S_BEF_TARGET_EMP_ID: emp,
      F_WORK_YMD: fmtYmd(req.date),
      S_WORK_YMD: req.date,
    });

    const org = (await call(t.orgWorkType, { ...form, S_DSMETHOD: t.orgWorkType })).etc.WORK_TYPE ?? "";
    if (!org) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 의 원근무유형을 JADE 가 주지 않았다 — 근무일이 아닐 수 있다`);
    const orgName = defaults.find((w) => w.code === org)?.name ?? org;
    if (!isWorkName(orgName)) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 은 ${orgName} 이라 재택근무를 신청할 수 없다`);

    // 화면은 서버 목록이 0행일 때만 기본 목록을 쓴다 — 행이 있는데 못 읽으면 기본 목록으로 바꿔치지 않고 멈춘다.
    const raw = firstDataset(await call(t.workTypes, { S_WORK_YMD: req.date, S_EMP_ID: emp }));
    const listed = raw.filter((r) => r.CD).map((r) => ({ code: r.CD ?? "", name: r.CD_NM ?? "" }));
    if (raw.length && !listed.length) throw new PageStructureError("변경근무유형 목록(CD·CD_NM)");
    const options = raw.length ? listed : defaults;
    const remote = options.find((w) => w.name === REMOTE_WORK_NAME);
    if (!remote) {
      throw new ApplicationBlockedError(`${fmtYmd(req.date)} 에 고를 수 있는 변경근무유형에 ${REMOTE_WORK_NAME} 가 없다: ${options.map((w) => w.name).join(", ")}`);
    }
    if (remote.code === org) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 은 이미 ${REMOTE_WORK_NAME} 다`);

    Object.assign(form, { S_ORG_WORK_TYPE: org, S_WORK_TYPE: remote.code, S_RSN: req.reason, S_APPL_DTL_TXT: "" });
    await closeCheck(client, env, t.closeCheck, form);

    return {
      env,
      tokens: t,
      form,
      preview: {
        date: fmtYmd(req.date),
        orgWorkType: orgName,
        workType: `${remote.name} (${remote.code})`,
        reason: req.reason,
        approvers: env.approvers,
      },
    };
  });
}

function samePreview(a: RemoteWorkPlan["preview"], b: RemoteWorkPlan["preview"]): boolean {
  const line = (p: RemoteWorkPlan["preview"]) => p.approvers.map((x) => `${x.empId}^${x.type}`).join(",");
  return a.date === b.date && a.orgWorkType === b.orgWorkType && a.workType === b.workType && a.reason === b.reason && line(a) === line(b);
}

/**
 * 승인된 재택 근무 신청서 한 건을 상신한다. 여러 날을 미리 준비하면 먼저 연 화면의 요청 값이 낡을 수 있어,
 * 그 날짜 화면을 새로 열어 마감 검사까지 다시 통과시키고 미리보기와 같을 때만 보낸다.
 */
export async function commitRemoteWork(client: JadeClient, approved: RemoteWorkPlan["preview"]): Promise<{ date: string; applId: string }> {
  const ymd = approved.date.replaceAll(".", "");
  const plan = await prepareRemoteWork(client, { date: ymd, reason: approved.reason });
  if (!samePreview(plan.preview, approved)) {
    throw new ApplicationBlockedError(`${approved.date} 신청 내용이 미리보기 이후 바뀌었다 — prepare 부터 다시 해야 한다`);
  }
  return { date: approved.date, applId: await submitApplication(client, plan.env, plan.form) };
}

export interface RemoteWorkBatch {
  month: string;
  weekday: string;
  plans: RemoteWorkPlan[];
  skipped: { week: string; reason: string }[];
}

/**
 * 한 달의 요청 요일 재택근무를 날짜마다 한 건씩 준비한다. 신청서는 하루에 한 장이라 날짜별로 따로 상신한다.
 * 첫 주가 전달에서 시작하면 전달 달력도 읽는다.
 */
export async function prepareMonthlyRemoteWork(client: JadeClient, req: { month: string; weekday: Weekday }, today: string): Promise<RemoteWorkBatch> {
  const weeks = weeksOfMonth(req.month);
  const months = [...new Set(weeks.flatMap((m) => [m, addDays(m, 4)]).map((d) => ymdOf(d).slice(0, 6)))];
  const calendar: CalendarCell[] = [];
  for (const m of months) calendar.push(...(await fetchCalendar(client, m)));

  const workNames = await client.withSession(async (main) => {
    const { text } = await openNewApplication(client, main, REMOTE_FORM);
    return new Set(parseDefaultWorkTypes(text).map((w) => w.name).filter(isWorkName));
  });
  const schedule = planRemoteWorkDates(req.month, req.weekday, calendar, workNames, today);

  const plans: RemoteWorkPlan[] = [];
  const skipped = [...schedule.skipped];
  for (const date of schedule.dates) {
    try {
      plans.push(await prepareRemoteWork(client, { date, reason: remoteWorkReason(date) }));
    } catch (e) {
      if (!(e instanceof ApplicationBlockedError)) throw e;
      skipped.push({ week: fmtYmd(date), reason: e.message });
    }
  }
  return { month: req.month, weekday: WEEKDAY_KO[req.weekday], plans, skipped };
}

export { WEEKDAYS };
