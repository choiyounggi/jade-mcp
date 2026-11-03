import { applicationBaseForm, prepareEnvelope, submitApplication, ApplicationBlockedError, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openMenu, openNewApplication } from "./menu.js";
import { caseTokenOf, PageStructureError, type PageContext } from "./page.js";
import type { Row } from "./response.js";
import type { Params } from "./viewstate.js";

const CANCEL_FORM = { type: "1132", name: "근태/근무 취소 신청서", url: "/tam4/tm_day/tm_day_070_m01.jsp" } as const;
// 신청서의 「취소할 근태/휴가 선택」 버튼이 여는 팝업. 신청 메뉴 권한으로 열린다(menu.ts 의 신청 메뉴와 같은 값).
const PICKER = {
  pgmId: "sy_appl_200_m03",
  pgmUrl: "/sys/sy_appl/sy_appl_200_m03.jsp",
  menuNm: "신청",
  popUrl: "/tam4/tm_day/tm_day_070_p01.jsp",
} as const;
// 팝업이 sheet1 의 SaveName 을 이을 때 빼는 열 (concatSaveName 의 세 번째 인자)
const SAVENAME_EXCLUDE = new Set(["CSEQ", "CDELETE", "CSTATUS"]);
// 팝업 sheet1_OnClick 이 선택을 막는 취소 진행 상태. 이미 취소 신청이 진행 중이거나 끝난 원신청이다.
const CANCEL_IN_PROGRESS = new Set(["200", "900"]);
// 신청서 화면 S_NOTE 의 maxbl
const NOTE_MAX_BYTES = 500;

export interface CancelPicker {
  search: string;
  saveName: string;
  /** 근태/휴가 코드 → 이름 (sheet1 ATTEND_CD 콤보) */
  attendNames: Record<string, string>;
  /** 팝업이 처음 열릴 때 채우는 조회 기간 — 서버가 이번 달 1일과 오늘을 박아 보낸다. */
  defaultFrom: string;
  defaultTo: string;
}

function lastOfMonth(ymd: string): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  return `${ymd.slice(0, 6)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** 취소 대상 팝업 HTML 에서 조회 토큰·SaveName·근태 코드 이름·기본 조회 기간을 읽는다. */
export function parseCancelPicker(html: string): CancelPicker {
  const search = caseTokenOf(html, 'sheet1.DoSearch("/commonAction.do"', "취소 대상 조회");
  const loadAt = html.indexOf("function LoadPage()");
  const doAt = html.indexOf("function doAction(");
  if (loadAt < 0 || doAt < loadAt) throw new PageStructureError("취소 대상 팝업 LoadPage");
  const load = html.slice(loadAt, doAt);

  const columns = [...load.matchAll(/SaveName\s*:\s*"(\w+)"/g)].map((m) => m[1]!);
  if (!columns.includes("APPL_ID") || !columns.includes("APPL_INFO")) throw new PageStructureError("취소 대상 목록 열(APPL_ID·APPL_INFO)");
  const saveName = columns.filter((c) => !SAVENAME_EXCLUDE.has(c)).join("|");

  const combo = /setCombo\("([^"]*)",\s*sheet1,\s*"ATTEND_CD"/.exec(load)?.[1];
  if (combo === undefined) throw new PageStructureError("근태/휴가 코드 목록");
  const attendNames: Record<string, string> = {};
  for (const item of combo.split("■")) {
    const [name = "", code = ""] = item.split("□");
    if (code) attendNames[code] = name;
  }

  const defaultFrom = /inputSetValueAuto\("F_SCH_STA_YMD",\s*"(\d{8})"\)/.exec(load)?.[1];
  const today = /inputSetValueAuto\("F_SCH_END_YMD",\s*addYmd\("(\d{8})",\s*"LOM"\)\)/.exec(load)?.[1];
  if (!defaultFrom || !today) throw new PageStructureError("취소 대상 기본 조회 기간");
  return { search, saveName, attendNames, defaultFrom, defaultTo: lastOfMonth(today) };
}

export interface CancelCandidate {
  applId: string;
  attend: string;
  period: string;
  text: string;
  note: string;
  status: string;
  /** 팝업에서 고를 수 있는 행인지. 못 고르면 blockedReason 에 이유가 있다. */
  selectable: boolean;
  blockedReason?: string;
}

function fmtYmd(ymd: string): string {
  return ymd.length === 8 ? `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}` : ymd;
}

/** 팝업 sheet1_OnClick 의 선택 검사. 고를 수 없으면 이유를, 고를 수 있으면 undefined 를 돌려준다. */
export function cancelBlockedReason(row: Row): string | undefined {
  if (CANCEL_IN_PROGRESS.has(row.AF_APPL_STAT_CD ?? "")) return `이미 취소 신청이 진행 중이거나 끝난 신청이다 (${row.AF_APPL_STAT_NM || row.AF_APPL_STAT_CD})`;
  if (row.DELETE_YN === "N") return "JADE 가 취소 신청을 허용하지 않는 신청이다 (취소신청 가능 N)";
  // 신청서 doValidation 은 S_APPL_INFO 가 비면 상신을 막는다 — 그 값이 이 행의 APPL_INFO 다.
  if (!row.APPL_ID || !row.APPL_INFO) return "원신청 번호나 신청내역이 비어 있다";
  return undefined;
}

export function toCandidate(row: Row, attendNames: Record<string, string>): CancelCandidate {
  const blockedReason = cancelBlockedReason(row);
  const code = row.ATTEND_CD ?? "";
  return {
    applId: row.APPL_ID ?? "",
    attend: attendNames[code] ? `${attendNames[code]} (${code})` : code,
    period: `${fmtYmd(row.STA_YMD ?? "")} ~ ${fmtYmd(row.END_YMD ?? "")}`,
    text: (row.APPL_TXT ?? "").trim(),
    note: (row.NOTE ?? "").trim(),
    status: row.AF_APPL_STAT_NM ?? "",
    selectable: !blockedReason,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export interface CancelSearch {
  from?: string;
  to?: string;
}

export function checkCancelPeriod(req: CancelSearch): void {
  for (const ymd of [req.from, req.to]) {
    if (ymd !== undefined && !/^\d{8}$/.test(ymd)) throw new ApplicationBlockedError("조회 기간은 YYYYMMDD 형식이어야 한다");
  }
  if (req.from && req.to && req.from > req.to) throw new ApplicationBlockedError("조회 시작일이 종료일보다 늦다");
}

interface Picker extends CancelPicker {
  ctx: PageContext;
  dsClass: string;
  /** 팝업이 목록을 조회할 사번 — 로그인 사번과 같음을 확인한 값 */
  empId: string;
}

async function openPicker(client: JadeClient, main: PageContext, emp: string): Promise<Picker> {
  const { text, ctx } = await openMenu(client, main, { ...PICKER, extra: { S_EMP_ID: emp, S_APPL_TYPE: CANCEL_FORM.type, S_PRS_BASE_PGM_YN: "Y" } });
  const dsClass = ctx.inputs.S_DSCLASS;
  if (!dsClass) throw new PageStructureError("취소 대상 팝업 #S_DSCLASS");
  // 팝업이 다른 사번으로 열리면 남의 원신청을 골라 취소 신청서에 싣게 된다.
  const empId = ctx.inputs.S_EMP_ID || emp;
  if (empId !== emp) throw new ApplicationBlockedError("취소 대상 팝업이 다른 사람의 신청 목록을 열었다");
  return { ...parseCancelPicker(text), ctx, dsClass, empId };
}

/** 팝업의 「조회」 — 폼 f1 을 inputAutoUnformat 한 뒤 보내는 것과 같은 순서·필드. */
async function searchCandidates(client: JadeClient, p: Picker, req: CancelSearch): Promise<{ from: string; to: string; rows: Row[] }> {
  const from = req.from ?? p.defaultFrom;
  const to = req.to ?? p.defaultTo;
  if (from > to) throw new ApplicationBlockedError("조회 시작일이 종료일보다 늦다");
  const res = await client.call(p.ctx, p.dsClass, p.search, {
    S_DSCLASS: p.dsClass,
    S_DSMETHOD: p.search,
    S_SAVENAME: p.saveName,
    S_EMP_ID: p.empId,
    S_APPL_TYPE: CANCEL_FORM.type,
    F_SCH_STA_YMD: fmtYmd(from),
    F_SCH_END_YMD: fmtYmd(to),
    S_SCH_STA_YMD: from,
    S_SCH_END_YMD: to,
  });
  return { from, to, rows: Object.values(res.datasets)[0] ?? [] };
}

/** 취소 신청서 팝업이 보여 주는 원신청 목록을 조회한다. 저장하지 않는다. */
export async function listAttendanceCancelCandidates(client: JadeClient, req: CancelSearch = {}) {
  checkCancelPeriod(req);
  return client.withSession(async (main) => {
    const { ctx } = await openNewApplication(client, main, CANCEL_FORM);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const picker = await openPicker(client, main, emp);
    const { from, to, rows } = await searchCandidates(client, picker, req);
    return { period: `${fmtYmd(from)} ~ ${fmtYmd(to)}`, candidates: rows.map((r) => toCandidate(r, picker.attendNames)) };
  });
}

export interface AttendanceCancelRequest extends CancelSearch {
  /** 취소할 원신청 번호 (목록의 applId) */
  applId: string;
  reason: string;
}

export interface AttendanceCancelPlan {
  env: ApplicationEnvelope;
  form: Params;
  preview: {
    applId: string;
    attend: string;
    period: string;
    text: string;
    reason: string;
    approvers: Approver[];
    /** commit 이 같은 행을 다시 찾을 조회 기간 */
    search: { from: string; to: string };
  };
}

export function checkCancelReason(reason: string): void {
  if (!reason.trim()) throw new ApplicationBlockedError("취소 사유가 비어 있다");
  if (Buffer.byteLength(reason, "utf8") > NOTE_MAX_BYTES) throw new ApplicationBlockedError(`취소 사유가 ${NOTE_MAX_BYTES}바이트를 넘는다`);
}

/**
 * 근태/근무 취소 신청서를 상신 직전까지 채운다. 이 신청서는 상신 전 서버 검증 호출이 없고 화면 검증(취소 대상 선택·필수값)만
 * 있으므로, 팝업 목록에서 그 원신청이 고를 수 있는 행인지까지 확인한다. 저장·상신은 하지 않는다.
 */
export async function prepareAttendanceCancel(client: JadeClient, req: AttendanceCancelRequest): Promise<AttendanceCancelPlan> {
  if (!/^\d+$/.test(req.applId)) throw new ApplicationBlockedError("원신청 번호는 숫자여야 한다");
  checkCancelPeriod(req);
  checkCancelReason(req.reason);
  return client.withSession(async (main) => {
    const { ctx } = await openNewApplication(client, main, CANCEL_FORM);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, CANCEL_FORM.type, emp);

    const picker = await openPicker(client, main, emp);
    const { from, to, rows } = await searchCandidates(client, picker, req);
    const row = rows.find((r) => r.APPL_ID === req.applId);
    if (!row) throw new ApplicationBlockedError(`${fmtYmd(from)} ~ ${fmtYmd(to)} 취소 대상 목록에 신청 ${req.applId} 이 없다 — 조회 기간을 확인해야 한다`);
    const blocked = cancelBlockedReason(row);
    if (blocked) throw new ApplicationBlockedError(blocked);
    const candidate = toCandidate(row, picker.attendNames);

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields };
    Object.assign(form, {
      S_TARGET_EMP_ID: emp,
      S_TARGET_EMP_NM: ctx.inputs.S_LOGIN_EMP_NM ?? "",
      S_BEF_TARGET_EMP_ID: emp,
      // 팝업 반환값을 신청서가 받는 자리 (doAction2 의 ModalUtil.open 콜백)
      S_APPL_INFO: row.APPL_INFO ?? "",
      S_BF_APPL_ID: row.APPL_ID ?? "",
      S_NOTE: req.reason,
      S_APPL_DTL_TXT: "",
    });
    if (!form.S_TARGET_EMP_ID || !form.S_TARGET_EMP_NM) throw new PageStructureError("신청 대상자(#S_TARGET_EMP_ID·#S_LOGIN_EMP_NM)");

    return {
      env,
      form,
      preview: {
        applId: candidate.applId,
        attend: candidate.attend,
        period: candidate.period,
        text: candidate.text,
        reason: req.reason,
        approvers: env.approvers,
        search: { from, to },
      },
    };
  });
}

function samePreview(a: AttendanceCancelPlan["preview"], b: AttendanceCancelPlan["preview"]): boolean {
  const line = (p: AttendanceCancelPlan["preview"]) => p.approvers.map((x) => `${x.empId}^${x.type}`).join(",");
  return a.applId === b.applId && a.attend === b.attend && a.period === b.period && a.text === b.text && a.reason === b.reason && line(a) === line(b);
}

/**
 * 승인된 취소 신청서를 상신한다. 서버 검증 호출이 없는 신청서라, 화면을 새로 열어 그 원신청이 아직 고를 수 있는지
 * (그사이 취소 신청이 올라갔는지) 다시 확인하고 미리보기와 같을 때만 보낸다.
 */
export async function commitAttendanceCancel(client: JadeClient, approved: AttendanceCancelPlan["preview"]): Promise<{ applId: string; cancelApplId: string }> {
  const plan = await prepareAttendanceCancel(client, { applId: approved.applId, reason: approved.reason, ...approved.search });
  if (!samePreview(plan.preview, approved)) {
    throw new ApplicationBlockedError(`신청 ${approved.applId} 의 취소 내용이 미리보기 이후 바뀌었다 — prepare 부터 다시 해야 한다`);
  }
  return { applId: approved.applId, cancelApplId: await submitApplication(client, plan.env, plan.form) };
}
