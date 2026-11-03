import { ApplicationBlockedError, applicationBaseForm, initFormFields } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openMenu, type MenuTarget } from "./menu.js";
import { callTokenAfter, otpToken, PageStructureError, type PageContext } from "./page.js";
import { localYmd } from "./remote.js";
import type { JadeResponse, Row } from "./response.js";
import type { Params } from "./viewstate.js";

const APPL_MENU = { pgmId: "sy_appl_200_m03", pgmUrl: "/sys/sy_appl/sy_appl_200_m03.jsp", menuNm: "신청" } as const;
const LIST_SRC = "/sys/sy_appl/sy_appl_200_f03.jsp";
/** 「신청」 메뉴의 「신청내역」 탭 — 메뉴 화면이 탭을 열 때 보내는 값과 같다. */
const HISTORY_TAB: MenuTarget = {
  ...APPL_MENU,
  popUrl: LIST_SRC,
  extra: { S_APPL_VERSION: "APPL_V03", S_APPL_MODE: "", S_APPL_TYPE: "", S_APPL_ID: "", S_MAIN_YN: "N" },
};

/** 신청내역 탭의 상태 체크박스(결재중·반려·최종완료)와 그 코드. 아무것도 고르지 않으면 전체다. */
export const STATUS_FILTERS = { approving: "200", rejected: "300", completed: "900" } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;
export const PAGE_SIZES = [10, 20, 30, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

// sys_appl.js 의 Apply.TempSave. 임시저장 신청서는 결재선과 상관없이 삭제할 수 있다.
const TEMP_SAVE = "100";

export interface HistoryScreen {
  ctx: PageContext;
  dsClass: string;
  search: string;
  schAuthCd: string;
}

/** 신청내역 탭 JS 의 drawApplList 가 부르는 목록 조회 호출. 토큰은 화면마다 바뀌므로 함수 안의 호출 모양으로 찾는다. */
export function parseHistoryScreen(html: string, ctx: PageContext): HistoryScreen {
  const anchor = "function drawApplList";
  const search = callTokenAfter(html, anchor, "신청내역 조회 호출");
  const schAuthCd = /S_EMP_SCH_AUTH_CD\s*:\s*"([^"]*)"/.exec(html.slice(html.indexOf(anchor)))?.[1];
  const dsClass = ctx.inputs.S_DSCLASS;
  if (schAuthCd === undefined || !dsClass) throw new PageStructureError("신청내역 조회 파라미터(S_EMP_SCH_AUTH_CD·#S_DSCLASS)");
  return { ctx, dsClass, search, schAuthCd };
}

export interface HistoryQuery {
  fromYmd?: string;
  toYmd?: string;
  statuses?: StatusFilter[];
  keyword?: string;
  applType?: string;
  page?: number;
  pageSize?: PageSize;
}

export interface CheckedQuery {
  from: string;
  to: string;
  statCds: string[];
  keyword: string;
  applType: string;
  page: number;
  pageSize: PageSize;
}

function isYmd(ymd: string): boolean {
  if (!/^\d{8}$/.test(ymd)) return false;
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
  return ymdOf(d) === ymd;
}

function ymdOf(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 화면의 addYmd(오늘, "M", -n) — 기간을 비워 두면 화면은 6개월 전부터 오늘까지를 조회한다. */
export function monthsBefore(ymd: string, n: number): string {
  return ymdOf(new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1 - n, Number(ymd.slice(6, 8)))));
}

function fmtYmd(ymd: string): string {
  return ymd.length === 8 ? `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}` : ymd;
}

/** 화면의 checkForm(신청일 형식)과 기본값을 재현한다. 화면에 없는 제약은 더하지 않는다. */
export function checkQuery(q: HistoryQuery, today: string): CheckedQuery {
  const from = q.fromYmd || monthsBefore(today, 6);
  const to = q.toYmd || today;
  for (const [label, ymd] of [["시작일", from], ["종료일", to]] as const) {
    if (!isYmd(ymd)) throw new ApplicationBlockedError(`${label}은 YYYYMMDD 형식의 날짜여야 한다: ${ymd}`);
  }
  if (from > to) throw new ApplicationBlockedError(`시작일(${fmtYmd(from)})이 종료일(${fmtYmd(to)})보다 늦다`);
  const page = q.page ?? 1;
  if (!Number.isInteger(page) || page < 1) throw new ApplicationBlockedError("페이지는 1 이상의 정수여야 한다");
  const applType = q.applType ?? "";
  if (!/^\d*$/.test(applType)) throw new ApplicationBlockedError("신청서 유형은 숫자 코드여야 한다");
  // 화면 체크박스가 결재중 → 반려 → 최종완료 순으로 담는다.
  const statCds = [...new Set((q.statuses ?? []).map((s) => STATUS_FILTERS[s]))].sort();
  return { from, to, statCds, keyword: (q.keyword ?? "").trim(), applType, page, pageSize: q.pageSize ?? 20 };
}

/** drawApplList 의 조회 파라미터. 키 순서가 __viewState 해시 순서다. 대상자(S_EMP_ID) 검색은 쓰지 않는다. */
export function searchParams(screen: HistoryScreen, q: CheckedQuery): Params {
  return {
    S_EMP_ID: "",
    S_EMP_SCH_AUTH_CD: screen.schAuthCd,
    S_APPL_TYPE: q.applType,
    S_STAT_CDS: q.statCds.join(","),
    S_TRG_EMP: "",
    S_APPL_YMD_FR: q.from,
    S_APPL_YMD_TO: q.to,
    S_STARTPAGE: String((q.page - 1) * q.pageSize + 1),
    S_APPL_TXT: q.keyword,
    S_NUM: q.pageSize,
  };
}

export type Progress = "진행중" | "반려" | "완료";

/** sys_appl_list.js 의 setApplStateIcon — 목록 아이콘이 이 세 갈래로 나뉜다. */
export function progressOf(statCd: string): Progress {
  if (statCd === "300" || statCd === "600" || statCd === "620") return "반려";
  if (statCd === "900") return "완료";
  return "진행중";
}

export interface ApplicationRow {
  applId: string;
  applType: string;
  applTypeName: string;
  module: string;
  appliedAt: string;
  statusCode: string;
  statusName: string;
  progress: Progress;
  content: string;
  target: string;
  targetOrg: string;
  applicant: string;
  comments: number;
}

/** 목록 한 줄 — drawApplList 가 그리는 칸과 같은 값. 대상자는 CARD_TXT 가 있으면 그것을 보여 준다. */
export function toApplication(r: Row): ApplicationRow {
  const hms = r.APPL_HMS ?? "";
  const hm = hms.includes(":") ? hms.slice(0, 5) : hms.length >= 4 ? `${hms.slice(0, 2)}:${hms.slice(2, 4)}` : hms;
  const statusCode = r.APPL_STAT_CD ?? "";
  return {
    applId: r.APPL_ID ?? "",
    applType: r.APPL_TYPE ?? "",
    applTypeName: r.APPL_TYPE_NM ?? "",
    module: r.MODULE_NM || "기타",
    appliedAt: `${fmtYmd(r.APPL_YMD ?? "")} ${hm}`.trim(),
    statusCode,
    statusName: r.APPL_STAT_NM ?? "",
    progress: progressOf(statusCode),
    content: (r.APPL_TXT ?? "").trim(),
    target: r.CARD_TXT || r.TRG_EMP || "",
    targetOrg: r.TRG_ORG_NM ?? "",
    applicant: r.APPL_EMP_NM ?? "",
    comments: Number(r.CMT_CNT || 0),
  };
}

export interface ApplicationList {
  from: string;
  to: string;
  statuses: string[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  items: ApplicationRow[];
}

function toList(res: JadeResponse, q: CheckedQuery): ApplicationList {
  const total = Number(res.etc.TOT || 0);
  const rows = res.datasets.Data ?? [];
  // 건수가 있는데 행을 못 읽으면 빈 목록으로 보고하지 않는다 — 삭제 대상 확인이 이 목록에 기대기 때문이다.
  if (total > 0 && rows.length > 0 && !rows.every((r) => r.APPL_ID)) throw new PageStructureError("신청내역 목록의 APPL_ID");
  if (total > 0 && rows.length === 0 && q.page <= Math.ceil(total / q.pageSize)) throw new PageStructureError("신청내역 목록(Data)");
  return {
    from: fmtYmd(q.from),
    to: fmtYmd(q.to),
    statuses: q.statCds,
    total,
    page: q.page,
    pageSize: q.pageSize,
    pageCount: Math.ceil(total / q.pageSize),
    items: rows.map(toApplication),
  };
}

async function openHistory(client: JadeClient, main: PageContext): Promise<HistoryScreen> {
  const { text, ctx } = await openMenu(client, main, HISTORY_TAB);
  return parseHistoryScreen(text, ctx);
}

async function searchPage(client: JadeClient, screen: HistoryScreen, q: CheckedQuery): Promise<ApplicationList> {
  return toList(await client.call(screen.ctx, screen.dsClass, screen.search, searchParams(screen, q)), q);
}

/** 신청내역 탭의 목록을 조회한다. 저장하지 않는다. */
export async function fetchApplications(client: JadeClient, query: HistoryQuery, today = localYmd()): Promise<ApplicationList> {
  const q = checkQuery(query, today);
  return client.withSession(async (main) => searchPage(client, await openHistory(client, main), q));
}

/**
 * 신청 메뉴 화면(xmlAllApplType)의 신청서 유형 → 화면 URL. 신청내역에서 한 줄을 누르면 화면은 이 URL 로 신청서를 연다.
 * 표는 엔티티로 이스케이프된 XML(SHEET/HTR/TR)이다.
 */
export function parseApplTypePrograms(html: string): Map<string, string> {
  const raw = /<textarea\b[^>]*\bid=["']xmlAllApplType["'][^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1];
  if (raw === undefined) throw new PageStructureError("신청서 유형 목록(xmlAllApplType)");
  const xml = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const cells = (tr: string) => [...tr.matchAll(/<TD>(?:<!\[CDATA\[([\s\S]*?)\]\]>)?<\/TD>/g)].map((m) => m[1] ?? "");
  const header = cells(/<HTR>([\s\S]*?)<\/HTR>/.exec(xml)?.[1] ?? "");
  const typeAt = header.indexOf("APPL_TYPE");
  const pgmAt = header.indexOf("PGM_NM");
  if (typeAt < 0 || pgmAt < 0) throw new PageStructureError("신청서 유형 목록의 APPL_TYPE·PGM_NM 열");
  const map = new Map<string, string>();
  for (const m of xml.matchAll(/<TR>([\s\S]*?)<\/TR>/g)) {
    const row = cells(m[1] ?? "");
    const type = row[typeAt];
    const pgm = row[pgmAt];
    if (type && pgm) map.set(type, pgm);
  }
  return map;
}

export type RemovalAction = "delete" | "retract";
const ACTION_KO: Record<RemovalAction, string> = { delete: "삭제", retract: "회수" };

export interface ApplicationState {
  statusCode: string;
  /** 서버가 정한 「결재 전이라 지울 수 있음」 표시 (ApplInfo.DEL_BTN_YN) */
  delBtnYn: string;
  /** 회사 설정의 회수 기능 사용 여부 (ApplRetractYn.SYS_VAL) */
  retractYn: string;
  infUseYn: string;
  procFlag: string;
}

/**
 * sys_appl.js drawButton 의 신청(APPL) 모드 버튼 규칙. 임시저장은 삭제만, 결재 전(DEL_BTN_YN=Y)은 삭제와
 * (회사가 회수 기능을 쓰면) 회수가 보인다. 외부 결재만 쓰는 유형(INF_USE_YN=Y·PROC_FLAG=20)은 임시저장 삭제만 된다.
 */
export function allowedActions(s: ApplicationState): Record<RemovalAction, boolean> {
  const temp = s.statusCode === TEMP_SAVE;
  const beforeAppr = s.delBtnYn === "Y";
  if (s.infUseYn === "Y" && s.procFlag === "20") return { delete: temp, retract: false };
  return { delete: temp || beforeAppr, retract: s.retractYn === "Y" && !temp && beforeAppr };
}

function blockReason(s: ApplicationState, action: RemovalAction): string {
  if (action === "retract" && s.retractYn !== "Y") return "이 회사 JADE 설정에서는 회수 기능을 쓰지 않는다(화면에 회수 버튼이 없다) — 삭제만 할 수 있다";
  if (action === "retract" && s.statusCode === TEMP_SAVE) return "임시저장 신청서는 회수할 것이 없다 — 삭제만 할 수 있다";
  if (s.infUseYn === "Y" && s.procFlag === "20") return "외부 결재로 처리되는 신청서라 임시저장 상태에서만 지울 수 있다";
  return "결재가 이미 진행됐거나 끝난 신청서라 JADE 화면에 삭제·회수 버튼이 없다";
}

export interface ApplicationDetail {
  ctx: PageContext;
  dsClass: string;
  common: string;
  txToken: string;
  /** 상세 화면 f1 을 serializeForm 한 것과 같은 값 */
  form: Params;
  state: ApplicationState;
}

function detailTarget(pgm: string, applType: string, applId: string, statCd: string): MenuTarget {
  return {
    ...APPL_MENU,
    popUrl: pgm,
    // 신청내역 탭에서 한 줄을 눌렀을 때 화면이 보내는 값과 같은 순서다.
    extra: {
      S_TITEL_NM: "신청서작성",
      S_APPL_TYPE: applType,
      S_APPL_ID: applId,
      S_APPL_STAT_CD: statCd,
      S_APPL_MODE: "APPL",
      S_APPL_VERSION: "APPL_V03",
      S_LIST_SRC: LIST_SRC,
    },
  };
}

/** 신청서 상세 화면을 열고 Apply.init 이 받는 신청서 정보(getInitInfo)로 상태를 읽는다. 저장하지 않는다. */
export async function inspectApplication(
  client: JadeClient,
  main: PageContext,
  target: { applId: string; applType: string; statusCode: string; pgm: string },
): Promise<ApplicationDetail> {
  const { ctx } = await openMenu(client, main, detailTarget(target.pgm, target.applType, target.applId, target.statusCode));
  if (ctx.inputs.S_APPL_ID !== target.applId) throw new PageStructureError("상세 화면의 #S_APPL_ID");
  const dsClass = ctx.inputs.S_DSCLASS;
  if (!dsClass) throw new PageStructureError("#S_DSCLASS");
  const common = otpToken(ctx, "ApplyOtpVal", "Sys_appl_common");
  const init = await client.call(ctx, common, otpToken(ctx, "ApplyOtpVal", "getInitInfo"), {
    S_APPL_TYPE: target.applType,
    S_APPL_ID: target.applId,
  });
  const info = init.datasets.ApplInfo?.[0];
  if (!info) throw new ApplicationBlockedError(`신청서 ${target.applId} 의 정보를 JADE 가 주지 않았다 — 이미 삭제됐을 수 있다`);
  const typeRow = init.datasets.ApplType?.[0];
  const txToken = init.etc.S_APPL_TX_TOKEN;
  if (!typeRow || !txToken || info.APPL_STAT_CD === undefined || info.DEL_BTN_YN === undefined) {
    throw new PageStructureError("신청서 정보(ApplInfo.APPL_STAT_CD·DEL_BTN_YN·ApplType·S_APPL_TX_TOKEN)");
  }
  if (info.APPL_TYPE && info.APPL_TYPE !== target.applType) {
    throw new ApplicationBlockedError(`신청서 ${target.applId} 의 유형이 목록(${target.applType})과 다르다(${info.APPL_TYPE})`);
  }

  // Apply.init 이 신청서 정보로 채우는 hidden 필드 — 화면 폼에 있는 것만 채운다(serializeForm 은 폼 안의 입력만 보낸다).
  const form: Params = { ...applicationBaseForm(ctx), ...initFormFields(typeRow) };
  const fill: Params = { S_TARGET_EMP_ID: info.TRG_EMP_ID, S_TARGET_EMP_NM: info.TRG_EMP_NM, S_BEF_TARGET_EMP_ID: info.TRG_EMP_ID };
  for (const [k, v] of Object.entries(fill)) if (k in form) form[k] = v ?? "";

  return {
    ctx,
    dsClass,
    common,
    txToken,
    form,
    state: {
      statusCode: info.APPL_STAT_CD,
      delBtnYn: info.DEL_BTN_YN,
      retractYn: init.datasets.ApplRetractYn?.[0]?.SYS_VAL ?? "",
      infUseYn: typeRow.INF_USE_YN || "N",
      procFlag: typeRow.PROC_FLAG || "N",
    },
  };
}

/** 화면 버튼 규칙과 그 동작의 호출 토큰을 확인한다. 삭제는 doDelete(true) 처럼 결재 진행 여부(apprCheck01)도 서버에 묻는다. */
export async function checkRemoval(client: JadeClient, d: ApplicationDetail, action: RemovalAction): Promise<void> {
  if (!allowedActions(d.state)[action]) throw new ApplicationBlockedError(blockReason(d.state, action));
  otpToken(d.ctx, "ApplyOtpVal", action === "delete" ? "delete01" : "retract");
  if (action !== "delete") return;
  const check = await client.call(d.ctx, d.common, otpToken(d.ctx, "ApplyOtpVal", "apprCheck01"), d.form);
  if (check.etc.APPR_YN === "Y") throw new ApplicationBlockedError("결재가 진행되어 삭제할 수 없다");
}

export interface RemovalTarget {
  applId: string;
  applType: string;
  statusCode: string;
  pgm: string;
}

export interface RemovalPlan {
  action: RemovalAction;
  targets: RemovalTarget[];
  preview: {
    action: string;
    meaning: string;
    applications: Pick<ApplicationRow, "applId" | "appliedAt" | "applTypeName" | "statusName" | "content">[];
    blocked: { applId: string; reason: string }[];
  };
}

const MEANING: Record<RemovalAction, string> = {
  delete: "신청서를 지운다. 되돌릴 수 없고, 다시 하려면 새로 신청해야 한다.",
  retract: "결재 요청을 거둬들인다. 신청서는 지워지지 않고 JADE 가 회수한 신청서 번호를 돌려준다.",
};

const MAX_TARGETS = 20;
const SEARCH_PAGE: PageSize = 50;
const MAX_SEARCH_PAGES = 20;

/** 신청내역에서 대상 신청서들을 찾는다. 화면처럼 기간 안을 50건씩 넘겨 보며 찾는다. */
async function findRows(client: JadeClient, screen: HistoryScreen, ids: string[], q: CheckedQuery): Promise<Map<string, ApplicationRow>> {
  const found = new Map<string, ApplicationRow>();
  for (let page = 1; page <= MAX_SEARCH_PAGES && found.size < ids.length; page++) {
    const list = await searchPage(client, screen, { ...q, page, pageSize: SEARCH_PAGE });
    for (const item of list.items) if (ids.includes(item.applId)) found.set(item.applId, item);
    if (page >= list.pageCount) break;
  }
  return found;
}

/**
 * 신청서 여러 장의 삭제(또는 회수)를 준비한다: 신청내역에서 다시 찾고, 상세 화면을 열어 화면 버튼 규칙과 서버 검사를
 * 통과하는지 본다. 지우지 않는다. 막힌 신청서는 사유와 함께 blocked 로 돌려주고, 하나도 안 되면 멈춘다.
 */
export async function prepareRemoval(
  client: JadeClient,
  req: { applIds: string[]; action: RemovalAction; fromYmd?: string; toYmd?: string },
  today = localYmd(),
): Promise<RemovalPlan> {
  const ids = [...new Set(req.applIds.map((id) => id.trim()))];
  if (!ids.length) throw new ApplicationBlockedError("신청서 번호(APPL_ID)가 비어 있다");
  if (ids.length > MAX_TARGETS) throw new ApplicationBlockedError(`한 번에 ${MAX_TARGETS}건까지 준비할 수 있다`);
  const bad = ids.filter((id) => !/^\d+$/.test(id));
  if (bad.length) throw new ApplicationBlockedError(`신청서 번호는 숫자여야 한다: ${bad.join(", ")}`);
  const q = checkQuery({ fromYmd: req.fromYmd, toYmd: req.toYmd }, today);

  return client.withSession(async (main) => {
    const rows = await findRows(client, await openHistory(client, main), ids, q);
    const missing = ids.filter((id) => !rows.has(id));
    if (missing.length) {
      throw new ApplicationBlockedError(
        `신청내역(${fmtYmd(q.from)}~${fmtYmd(q.to)})에서 찾지 못한 신청서: ${missing.join(", ")} — 기간(fromYmd·toYmd)을 넓히거나 번호를 확인해야 한다`,
      );
    }
    const programs = parseApplTypePrograms((await openMenu(client, main, APPL_MENU)).text);

    const plan: RemovalPlan = {
      action: req.action,
      targets: [],
      preview: { action: ACTION_KO[req.action], meaning: MEANING[req.action], applications: [], blocked: [] },
    };
    for (const id of ids) {
      const row = rows.get(id)!;
      try {
        const pgm = programs.get(row.applType);
        if (!pgm) throw new ApplicationBlockedError(`신청서 유형 ${row.applType}(${row.applTypeName}) 의 화면을 신청 메뉴에서 찾지 못했다`);
        const target = { applId: id, applType: row.applType, statusCode: row.statusCode, pgm };
        const detail = await inspectApplication(client, main, target);
        await checkRemoval(client, detail, req.action);
        plan.targets.push({ ...target, statusCode: detail.state.statusCode });
        plan.preview.applications.push({
          applId: id,
          appliedAt: row.appliedAt,
          applTypeName: row.applTypeName,
          statusName: row.statusName,
          content: row.content,
        });
      } catch (e) {
        if (!(e instanceof ApplicationBlockedError)) throw e;
        plan.preview.blocked.push({ applId: id, reason: e.message });
      }
    }
    if (!plan.targets.length) {
      throw new ApplicationBlockedError(
        `${ACTION_KO[req.action]}할 수 있는 신청서가 없다: ${plan.preview.blocked.map((b) => `${b.applId} ${b.reason}`).join(" / ")}`,
      );
    }
    return plan;
  });
}

export interface RemovalResult {
  applId: string;
  result: "삭제됨" | "회수됨" | "건너뜀" | "실패" | "확인 필요";
  reason?: string;
  /** 회수 응답의 신청서 번호 */
  newApplId?: string;
}

/**
 * 승인된 계획대로 한 장씩 삭제·회수한다. 장마다 상세 화면을 새로 열어 중복요청 방지 토큰을 받고 버튼 규칙·서버 검사를
 * 다시 통과한 뒤, 상태가 미리보기 때와 같을 때만 보낸다. 한 장이 막혀도 나머지는 계속한다.
 */
export async function commitRemoval(client: JadeClient, plan: RemovalPlan): Promise<{ action: string; results: RemovalResult[] }> {
  const results: RemovalResult[] = [];
  for (const t of plan.targets) {
    let sent = false;
    try {
      const d = await client.withSession(async (main) => {
        const d = await inspectApplication(client, main, t);
        if (d.state.statusCode !== t.statusCode) {
          throw new ApplicationBlockedError(`상태가 미리보기 이후 바뀌었다(${t.statusCode} → ${d.state.statusCode}) — prepare 부터 다시 해야 한다`);
        }
        await checkRemoval(client, d, plan.action);
        return d;
      });
      // 삭제·회수 요청은 withSession 밖에서 한 번만 보낸다 — 안에서 보내면 세션 만료 재시도가 같은 요청을 다시 보낸다.
      sent = true;
      if (plan.action === "delete") {
        // Apply.doDelete: { S_APPL_TX_TOKEN } 를 먼저 두고 폼을 덧붙인다 — 키 순서가 __viewState 해시 순서다.
        await client.call(d.ctx, d.dsClass, otpToken(d.ctx, "ApplyOtpVal", "delete01"), { S_APPL_TX_TOKEN: d.txToken, ...d.form });
        results.push({ applId: t.applId, result: "삭제됨" });
      } else {
        const res = await client.call(d.ctx, d.common, otpToken(d.ctx, "ApplyOtpVal", "retract"), { S_APPL_ID: t.applId });
        results.push({ applId: t.applId, result: "회수됨", newApplId: res.etc.APPL_ID ?? "" });
      }
    } catch (e) {
      const reason = (e as Error).message;
      // 요청을 보낸 뒤의 오류는 서버 반영 여부를 알 수 없다 — 재시도로 겹치지 않게 확인을 먼저 요구한다.
      if (sent) results.push({ applId: t.applId, result: "확인 필요", reason: `${reason} — jade_applications 로 실제 상태를 확인해야 한다` });
      else results.push({ applId: t.applId, result: e instanceof ApplicationBlockedError ? "건너뜀" : "실패", reason });
    }
  }
  return { action: ACTION_KO[plan.action], results };
}
