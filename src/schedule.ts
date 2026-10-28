import { ApplicationBlockedError } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openMenu } from "./menu.js";
import { PageStructureError, type PageContext } from "./page.js";
import type { Params } from "./viewstate.js";

// 「나의 근태현황」의 「일정등록」 버튼이 여는 팝업. 이 계정 설정(ETC)에서는 결재 없이 바로 저장된다.
const POPUP = {
  pgmId: "ess_tam4_401_m02",
  pgmUrl: "/ess/tam4/ess_tam_401_m02.jsp",
  menuNm: "일정등록",
  popUrl: "/ess/tam4/ess_tam_401_p02.jsp",
} as const;
const CALENDAR_HTML_VSN = "F_TAM4_GET_CALENDAR_HTML_V03";

export interface CalendarDay {
  ymd: string;
  /** 일정을 바꿀 수 있는 날인지 (휴일 등은 N) */
  plannable: boolean;
  workType: string;
  /** "09:00~20:00" 처럼 화면에 보이는 계획 시각. 없으면 빈 문자열 */
  planTime: string;
}

export interface ScheduleTokens {
  ctx: PageContext;
  dsClass: string;
  calendar: string;
  workTypes: string;
  save: string;
}

export interface SchedulePlan {
  tokens: ScheduleTokens;
  month: string;
  dates: string[];
  planTime: string;
  /** 저장 전 근무유형 — 저장이 근무유형까지 바꿨는지 확인하는 기준 */
  workTypesBefore: Record<string, string>;
  form: Params;
  preview: {
    month: string;
    planTime: string;
    dayCount: number;
    dates: string[];
    currentPlans: Record<string, string[]>;
    skipped: string[];
  };
}

/** 팝업 달력 HTML(CAL_HTML)의 날짜 칸을 읽는다. */
export function parseCalendar(html: string): CalendarDay[] {
  const days: CalendarDay[] = [];
  for (const m of html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)) {
    const [, attrs = "", body = ""] = m;
    const ymd = /\bymd=\s*'(\d{8})'/.exec(attrs)?.[1];
    if (!ymd) continue;
    days.push({
      ymd,
      plannable: /\bplanAbleYn='Y'/i.test(attrs),
      workType: /<span class='workItem'><span>([^<]*)<\/span>/.exec(body)?.[1]?.trim() ?? "",
      planTime: /<p class='workTime'>([^<]*)<\/p>/.exec(body)?.[1]?.trim() ?? "",
    });
  }
  return days;
}

/** 팝업 JS 의 호출 토큰. 결재를 거치는 모드(근무유형 변경·신청)면 저장 흐름이 달라 지원하지 않는다. */
export function parseScheduleTokens(html: string, ctx: PageContext): ScheduleTokens {
  const changeOpt = /\$\("#S_WORK_TYPE_CHANGE_OPT"\)\.val\("([^"]*)"\)/.exec(html)?.[1];
  const applMode = /if\(\s*"([^"]*)"\s*==\s*"APPL"\s*\)/.exec(html)?.[1];
  if (changeOpt === undefined || applMode === undefined) throw new PageStructureError("일정등록 모드");
  if (changeOpt !== "ETC" || applMode === "APPL" || ctx.inputs.S_WORK_TYPE_OPT !== "ETC") {
    throw new ApplicationBlockedError("이 계정의 일정등록은 근무유형 변경·신청 방식이라 지원하지 않는다");
  }

  const calendar = /case\s+"([^"]+)"\s*:\s*\{\s*\$\("\.e-cal"\)\.find\('tbody'\)\.html\(""\);/.exec(html)?.[1];
  const save = /id="S_WORK_REG_BTN"\s+onClick="doAction\('([^']+)'\)/.exec(html)?.[1];
  const listAt = html.indexOf("function getWorkTypeChangeOpt()");
  const workTypes = listAt < 0 ? undefined : /ajaxSyncRequestXS\(\$\("#S_DSCLASS"\)\.val\(\),\s*"([^"]+)"/.exec(html.slice(listAt))?.[1];
  const dsClass = ctx.inputs.S_DSCLASS;
  if (!calendar || !save || !workTypes || !dsClass) throw new PageStructureError("일정등록 호출 토큰");
  if (new Set([calendar, save, workTypes]).size !== 3) throw new PageStructureError("일정등록 호출 토큰");
  return { ctx, dsClass, calendar, workTypes, save };
}

function hhmm(hm: string): string {
  return `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
}

export function checkScheduleRequest(month: string, startHm: string, endHm: string): void {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(month)) throw new ApplicationBlockedError("월은 YYYYMM 형식이어야 한다");
  for (const hm of [startHm, endHm]) {
    if (!/^([01]\d|2[0-3])[0-5]\d$/.test(hm)) throw new ApplicationBlockedError(`시각 ${hm} 은 HHMM 형식이어야 한다`);
  }
  if (startHm >= endHm) throw new ApplicationBlockedError("종료 시각이 시작 시각보다 늦어야 한다 (자정을 넘는 일정은 지원하지 않는다)");
}

async function openPopup(client: JadeClient, main: PageContext): Promise<ScheduleTokens> {
  const empId = main.inputs.S_EMP_ID || main.page.EMP_ID || "";
  const { text, ctx } = await openMenu(client, main, { ...POPUP, extra: { S_EMP_ID: empId } });
  return parseScheduleTokens(text, ctx);
}

async function readCalendar(client: JadeClient, t: ScheduleTokens, month: string): Promise<CalendarDay[]> {
  const res = await client.call(t.ctx, t.dsClass, t.calendar, {
    S_SEL_YM: month,
    S_EMP_ID: t.ctx.inputs.S_EMP_ID ?? "",
    S_GBN: "P",
    S_HTML_VSN: CALENDAR_HTML_VSN,
  });
  const days = parseCalendar(res.etc.CAL_HTML ?? "").filter((d) => d.ymd.startsWith(month));
  if (days.length === 0) throw new PageStructureError(`${month} 달력`);
  return days;
}

/**
 * 한 달의 일정 변경 가능한 날(또는 그중 dates) 전부를 같은 계획 시각으로 바꿀 준비를 한다. 저장하지 않는다.
 * 팝업에서 달을 넘기고 「전체 선택」 뒤 시각을 넣은 것과 같은 요청을 만든다.
 */
export async function prepareSchedule(
  client: JadeClient,
  req: { month: string; startHm: string; endHm: string; dates?: string[] },
): Promise<SchedulePlan> {
  checkScheduleRequest(req.month, req.startHm, req.endHm);
  return client.withSession(async (main) => {
    const t = await openPopup(client, main);
    const empId = t.ctx.inputs.S_EMP_ID;
    if (!empId) throw new PageStructureError("#S_EMP_ID");
    const days = await readCalendar(client, t, req.month);
    const plannable = days.filter((d) => d.plannable).map((d) => d.ymd);
    let dates = plannable;
    if (req.dates?.length) {
      const blocked = req.dates.filter((d) => !plannable.includes(d));
      if (blocked.length) throw new ApplicationBlockedError(`일정을 바꿀 수 없는 날이 있다: ${blocked.join(", ")}`);
      dates = [...new Set(req.dates)].sort();
    }
    if (dates.length === 0) throw new ApplicationBlockedError(`${req.month} 에는 일정을 바꿀 수 있는 날이 없다`);

    // 일정등록(ETC) 화면은 근무유형 콤보를 숨겨 두지만, 달을 넘길 때 그 달 목록의 첫 항목이 선택돼 그대로 전송된다
    // (changeMonth → getWorkTypeChangeOpt). 실제 화면 순서와 같은 값을 보내고, 저장 뒤 근무유형이 그대로인지 확인한다.
    const list = await client.call(t.ctx, t.dsClass, t.workTypes, { S_TARGET_EMP_ID: empId, S_SEL_YM: req.month });
    const workType = /□([^■]*)/.exec(list.etc.S_WORK_TYPE_LIST ?? "")?.[1] ?? "1010";

    const form: Params = {
      S_SAVENAME: "",
      S_EMP_ID: empId,
      S_SEL_YM: req.month,
      S_SEL_YMDS: dates.join(","),
      S_TARGET_YMD: `${req.month}01`,
      S_TOT_CLASS: t.ctx.inputs.S_TOT_CLASS ?? "10",
      S_APPL_YN: "N",
      S_WORK_TYPE_CHANGE_OPT: "ETC",
      S_WORK_TYPE_YMD: "",
      S_WORK_TYPE_CHANGE_CD: "",
      S_WORK_TYPE_PLAN_TIME: "",
      S_TARGET_EMP_ID: empId,
      S_WORK_TYPE_OPT: "ETC",
      S_WORK_TYPE: workType,
      S_STA_CLASS: "2",
      F_STA_HM: hhmm(req.startHm),
      S_END_CLASS: "2",
      F_END_HM: hhmm(req.endHm),
      S_WORK_TYPE_TIME: "",
      S_STA_HM: req.startHm,
      S_END_HM: req.endHm,
    };

    const currentPlans: Record<string, string[]> = {};
    for (const d of days.filter((x) => dates.includes(x.ymd))) (currentPlans[d.planTime || "(없음)"] ??= []).push(d.ymd);
    const planTime = `${hhmm(req.startHm)}~${hhmm(req.endHm)}`;
    return {
      tokens: t,
      month: req.month,
      dates,
      planTime,
      workTypesBefore: Object.fromEntries(days.filter((d) => dates.includes(d.ymd)).map((d) => [d.ymd, d.workType])),
      form,
      preview: {
        month: `${req.month.slice(0, 4)}.${req.month.slice(4)}`,
        planTime,
        dayCount: dates.length,
        dates,
        currentPlans,
        skipped: days.filter((d) => !dates.includes(d.ymd)).map((d) => `${d.ymd} ${d.workType || "-"}`),
      },
    };
  });
}

/** 저장한 뒤 달력을 다시 읽어 고른 날이 모두 새 시각이 되었고 근무유형은 그대로인지 확인한다. */
export async function commitSchedule(client: JadeClient, plan: SchedulePlan) {
  const t = plan.tokens;
  await client.call(t.ctx, t.dsClass, t.save, { ...plan.form, S_DSMETHOD: t.save });
  const after = (await readCalendar(client, t, plan.month)).filter((d) => plan.dates.includes(d.ymd));
  const timeMismatched = after.filter((d) => d.planTime !== plan.planTime).map((d) => `${d.ymd} ${d.planTime || "(없음)"}`);
  const workTypeChanged = after
    .filter((d) => d.workType !== plan.workTypesBefore[d.ymd])
    .map((d) => `${d.ymd} ${plan.workTypesBefore[d.ymd]} → ${d.workType}`);
  return {
    saved: true,
    planTime: plan.planTime,
    dayCount: plan.dates.length,
    verified: timeMismatched.length === 0 && workTypeChanged.length === 0 && after.length === plan.dates.length,
    timeMismatched,
    workTypeChanged,
  };
}
