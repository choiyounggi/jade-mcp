import { applicationBaseForm, prepareEnvelope, submitApplication, ApplicationBlockedError, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openMenu, openNewApplication } from "./menu.js";
import { caseTokenOf, PageStructureError, type PageContext } from "./page.js";
import type { Row } from "./response.js";
import type { Params } from "./viewstate.js";

const CANCEL_FORM = { type: "1060", name: "연장 근무 취소 신청서", url: "/tam4/tm_day/tm_day_075_m01.jsp" } as const;
/** 「취소할 사전근무 선택」 버튼이 ModalUtil.open 으로 여는 팝업. 신청 메뉴 권한으로 연다. */
const TARGET_POPUP = { pgmId: "sy_appl_200_m03", pgmUrl: "/sys/sy_appl/sy_appl_200_m03.jsp", menuNm: "신청", popUrl: "/tam4/tm_day/tm_day_075_p01.jsp" } as const;
/** 팝업 sheet1 의 SaveName — concatSaveName(sheet1, "|", "CSEQ,CDELETE,CSTATUS") 가 만드는 값과 같다. */
const TARGET_SAVENAME = "CCHK|YMD|STA_YMD|STA_HM|END_YMD|END_HM|RSN|REWARD_TYPE|REWARD_YMD|DELETE_YN|APPL_INFO|APPL_ID";

export interface OvertimeCancelRequest {
  /** 취소할 연장근무의 근무일 YYYYMMDD */
  date: string;
  /** 같은 날 취소할 수 있는 신청이 여러 건이면 근무 시작 시각 HHMM 으로 고른다. */
  startHm?: string;
  reason: string;
}

/** 팝업 목록 한 행 — 연장근무 신청 한 건 */
export interface OvertimeEntry {
  applId: string;
  ymd: string;
  staYmd: string;
  staHm: string;
  endYmd: string;
  endHm: string;
  reason: string;
  rewardType: string;
  /** 팝업이 체크를 막는지 — DELETE_YN=N 이면 「취소할 수 없는 신청」 */
  cancellable: boolean;
  /** 취소 신청서의 「신청내역」 칸에 그대로 들어가는 문구 */
  info: string;
}

export interface TargetSearch {
  ctx: PageContext;
  dsClass: string;
  search: string;
  empId: string;
}

/** 팝업의 조회 분기(sheet1.DoSearch)와 그 화면 클래스. */
export function parseTargetSearch(html: string, ctx: PageContext): TargetSearch {
  const search = caseTokenOf(html, "sheet1.DoSearch(", "취소 대상 조회");
  const dsClass = ctx.inputs.S_DSCLASS;
  const empId = ctx.inputs.S_EMP_ID;
  if (!dsClass) throw new PageStructureError("#S_DSCLASS");
  if (!empId) throw new PageStructureError("#S_EMP_ID");
  // 팝업 열 때 넘긴 열 목록과 화면 sheet 의 열이 어긋나면 조회 결과를 잘못 읽게 된다.
  for (const col of TARGET_SAVENAME.split("|")) {
    if (!html.includes(`SaveName:"${col}"`)) throw new PageStructureError(`취소 대상 목록 열 ${col}`);
  }
  return { ctx, dsClass, search, empId };
}

export function toOvertimeEntries(rows: Row[]): OvertimeEntry[] {
  return rows.map((r) => ({
    applId: r.APPL_ID ?? "",
    ymd: r.YMD ?? "",
    staYmd: r.STA_YMD ?? "",
    staHm: r.STA_HM ?? "",
    endYmd: r.END_YMD ?? "",
    endHm: r.END_HM ?? "",
    reason: r.RSN ?? "",
    rewardType: r.REWARD_TYPE ?? "",
    cancellable: r.DELETE_YN !== "N",
    info: r.APPL_INFO ?? "",
  }));
}

function fmtYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function fmtHm(hm: string): string {
  return `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
}

function describeEntry(e: OvertimeEntry): string {
  return `${fmtYmd(e.staYmd)} ${fmtHm(e.staHm)} ~ ${fmtYmd(e.endYmd)} ${fmtHm(e.endHm)}${e.cancellable ? "" : " (취소 불가)"}`;
}

/** 팝업 기본 조회 기간과 같은 꼴 — 근무일이 든 달의 1일 ~ 말일. */
export function monthRange(ymd: string): { sta: string; end: string } {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { sta: `${ymd.slice(0, 6)}01`, end: `${ymd.slice(0, 6)}${String(last).padStart(2, "0")}` };
}

export function checkCancelRequest(req: OvertimeCancelRequest): void {
  if (!/^\d{8}$/.test(req.date)) throw new ApplicationBlockedError("날짜는 YYYYMMDD 형식이어야 한다");
  if (req.startHm !== undefined && !/^([01]\d|2[0-3])[0-5]\d$/.test(req.startHm)) {
    throw new ApplicationBlockedError(`시각 ${req.startHm} 은 HHMM 형식이어야 한다`);
  }
  if (!req.reason.trim()) throw new ApplicationBlockedError("취소 사유가 비어 있다");
}

/**
 * 팝업 목록에서 취소할 한 건을 고른다. 팝업은 DELETE_YN=N 행의 체크를 막으므로 그런 행은 고르지 않는다.
 * 같은 날 취소할 수 있는 건이 여럿이면 시작 시각으로 좁히고, 그래도 여럿이면 멈춘다.
 */
export function pickCancelTarget(entries: OvertimeEntry[], date: string, startHm?: string): OvertimeEntry {
  const sameDay = entries.filter((e) => e.ymd === date);
  const month = entries.length ? entries.map(describeEntry).join(", ") : "없음";
  if (!sameDay.length) throw new ApplicationBlockedError(`${fmtYmd(date)} 의 연장근무 신청이 없다. 그 달 신청: ${month}`);
  const timed = startHm ? sameDay.filter((e) => e.staHm === startHm) : sameDay;
  if (!timed.length) throw new ApplicationBlockedError(`${fmtYmd(date)} ${fmtHm(startHm ?? "")} 에 시작하는 연장근무 신청이 없다: ${sameDay.map(describeEntry).join(", ")}`);
  const open = timed.filter((e) => e.cancellable);
  if (!open.length) throw new ApplicationBlockedError(`${fmtYmd(date)} 의 연장근무 신청은 JADE 가 취소를 막고 있다: ${timed.map(describeEntry).join(", ")}`);
  if (open.length > 1) throw new ApplicationBlockedError(`${fmtYmd(date)} 에 취소할 수 있는 신청이 여러 건이다 — startHm 으로 골라야 한다: ${open.map(describeEntry).join(", ")}`);
  const target = open[0]!;
  if (!target.applId || !target.info) throw new PageStructureError("취소 대상 목록(APPL_ID·APPL_INFO)");
  return target;
}

export interface OvertimeCancelPlan {
  env: ApplicationEnvelope;
  target: TargetSearch;
  range: { sta: string; end: string };
  form: Params;
  preview: {
    target: string;
    applInfo: string;
    originalReason: string;
    reason: string;
    approvers: Approver[];
  };
}

async function searchTargets(client: JadeClient, t: TargetSearch, range: { sta: string; end: string }): Promise<OvertimeEntry[]> {
  // 팝업 f1 을 FormQueryStringEnc 로 보낸 것과 같은 필드. 조회 기간은 inputAutoUnformat 이 S_ 사본을 만든다.
  const res = await client.call(t.ctx, t.dsClass, t.search, {
    S_DSCLASS: t.dsClass,
    S_DSMETHOD: t.search,
    S_SAVENAME: TARGET_SAVENAME,
    S_EMP_ID: t.empId,
    F_SCH_STA_YMD: fmtYmd(range.sta),
    F_SCH_END_YMD: fmtYmd(range.end),
    S_SCH_STA_YMD: range.sta,
    S_SCH_END_YMD: range.end,
  });
  return toOvertimeEntries(Object.values(res.datasets)[0] ?? []);
}

/**
 * 연장 근무 취소 신청서를 상신 직전까지 채운다. 이 화면은 서버 검증 호출이 없고(doValidation 은 신청내역 칸만 본다),
 * 취소 가능 여부는 대상 팝업 목록의 DELETE_YN 으로 판정한다. 저장·상신은 하지 않는다.
 */
export async function prepareOvertimeCancel(client: JadeClient, req: OvertimeCancelRequest): Promise<OvertimeCancelPlan> {
  checkCancelRequest(req);
  return client.withSession(async (main) => {
    const { ctx } = await openNewApplication(client, main, CANCEL_FORM);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, CANCEL_FORM.type, emp);

    const popup = await openMenu(client, main, { ...TARGET_POPUP, extra: { S_EMP_ID: emp } });
    const target = parseTargetSearch(popup.text, popup.ctx);
    if (target.empId !== emp) throw new ApplicationBlockedError("취소 대상 팝업이 다른 사람의 신청 목록을 열었다");
    const range = monthRange(req.date);
    const picked = pickCancelTarget(await searchTargets(client, target, range), req.date, req.startHm);

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields };
    Object.assign(form, {
      S_TARGET_EMP_ID: emp,
      S_TARGET_EMP_NM: ctx.inputs.S_LOGIN_EMP_NM ?? "",
      S_BEF_TARGET_EMP_ID: emp,
      S_BF_APPL_ID: picked.applId,
      S_APPL_INFO: picked.info,
      S_NOTE: req.reason,
      S_APPL_DTL_TXT: "",
    });

    return {
      env,
      target,
      range,
      form,
      preview: {
        target: describeEntry(picked),
        applInfo: picked.info,
        originalReason: picked.reason,
        reason: req.reason,
        approvers: env.approvers,
      },
    };
  });
}

/**
 * 준비된 연장 근무 취소 신청서를 상신한다. 미리보기 뒤에 원 신청이 취소·결재되어 상태가 바뀌었을 수 있어
 * 대상 목록을 다시 조회해 그 신청이 아직 취소 가능할 때만 보낸다.
 */
export async function commitOvertimeCancel(client: JadeClient, plan: OvertimeCancelPlan): Promise<{ applId: string }> {
  const entries = await searchTargets(client, plan.target, plan.range);
  const still = entries.find((e) => e.applId === plan.form.S_BF_APPL_ID);
  if (!still?.cancellable) throw new ApplicationBlockedError("취소하려던 연장근무 신청을 더는 취소할 수 없다 — prepare 부터 다시 해야 한다");
  return { applId: await submitApplication(client, plan.env, plan.form) };
}
