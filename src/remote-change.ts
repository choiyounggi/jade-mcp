import { applicationBaseForm, prepareEnvelope, submitApplication, ApplicationBlockedError, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openNewApplication } from "./menu.js";
import { PageStructureError } from "./page.js";
import { isWorkName, localYmd, parseDefaultWorkTypes, parseRemoteWorkTokens } from "./remote.js";
import type { Row } from "./response.js";
import type { Params } from "./viewstate.js";

// 재택 취소는 근태/근무 취소 신청서(1132)가 아니라 같은 재택 근무 신청서로 그날 근무유형을 되돌리는 신청이다 —
// 1132 의 취소 대상 목록에는 승인된 재택 근무 신청서가 나오지 않는다.
const REMOTE_FORM = { type: "1130", name: "재택 근무 신청서", url: "/tam4/tm_day/tm_day_170_m01.jsp" } as const;
const REMOTE_WORK_NAME = "재택근무제";
export const DEFAULT_REVERT_WORK_TYPE = "선택근무제(IT)";

function fmtYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

/** 신청 사유 — "11월 9일 재택근무 취소 신청드립니다." */
export function remoteRevertReason(ymd: string): string {
  return `${Number(ymd.slice(4, 6))}월 ${Number(ymd.slice(6, 8))}일 재택근무 취소 신청드립니다.`;
}

export interface WorkTypeOption {
  code: string;
  name: string;
}

/**
 * 재택인 날의 변경근무유형 목록에서 되돌릴 근무유형을 고른다. 원근무유형이 재택근무제가 아니면 되돌릴 것이 없다.
 * 원래 근무유형은 서버가 알려 주지 않으므로(원근무유형 칸이 이미 재택근무제다) 이름으로 지정받는다.
 */
export function pickRevertWorkType(orgName: string, options: WorkTypeOption[], wanted: string): WorkTypeOption {
  if (orgName !== REMOTE_WORK_NAME) throw new ApplicationBlockedError(`이날 근무유형이 ${orgName || "없음"} 이라 되돌릴 재택근무가 없다 — 결재 대기 중인 재택 신청은 아직 반영되지 않았다`);
  if (wanted === REMOTE_WORK_NAME || !isWorkName(wanted)) throw new ApplicationBlockedError(`${wanted} 로는 되돌릴 수 없다`);
  const option = options.find((w) => w.name === wanted);
  if (!option) throw new ApplicationBlockedError(`고를 수 있는 변경근무유형에 ${wanted} 가 없다: ${options.map((w) => w.name).join(", ")}`);
  return option;
}

export interface RemoteRevertRequest {
  /** YYYYMMDD */
  date: string;
  /** 되돌릴 근무유형 이름. 기본 선택근무제(IT) */
  workType?: string;
  reason?: string;
}

export interface RemoteRevertPlan {
  env: ApplicationEnvelope;
  form: Params;
  preview: {
    date: string;
    orgWorkType: string;
    workType: string;
    reason: string;
    approvers: Approver[];
  };
}

export function checkRevertRequest(req: RemoteRevertRequest, today: string): void {
  if (!/^\d{8}$/.test(req.date)) throw new ApplicationBlockedError("날짜는 YYYYMMDD 형식이어야 한다");
  // 화면 checkWordymd 는 오늘보다 앞선 날짜만 막는다 — 오늘 재택 취소는 서버 마감 검사가 판정한다.
  if (req.date < today) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 은 지난 날짜다`);
  if (req.reason !== undefined && !req.reason.trim()) throw new ApplicationBlockedError("신청 사유가 비어 있다");
}

function firstDataset(res: { datasets: Record<string, Row[]> }): Row[] {
  return Object.values(res.datasets)[0] ?? [];
}

/** 재택근무로 바꾼 날을 다른 근무유형으로 되돌리는 재택 근무 신청서를 상신 직전까지 채우고 마감 검사까지 통과시킨다. */
export async function prepareRemoteWorkRevert(client: JadeClient, req: RemoteRevertRequest, today = localYmd()): Promise<RemoteRevertPlan> {
  checkRevertRequest(req, today);
  const wanted = req.workType ?? DEFAULT_REVERT_WORK_TYPE;
  const reason = req.reason ?? remoteRevertReason(req.date);
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

    // 화면처럼 서버 목록이 0행일 때만 기본 목록을 쓴다.
    const raw = firstDataset(await call(t.workTypes, { S_WORK_YMD: req.date, S_EMP_ID: emp }));
    const listed = raw.filter((r) => r.CD).map((r) => ({ code: r.CD ?? "", name: r.CD_NM ?? "" }));
    if (raw.length && !listed.length) throw new PageStructureError("변경근무유형 목록(CD·CD_NM)");
    const target = pickRevertWorkType(orgName, raw.length ? listed : defaults, wanted);

    Object.assign(form, { S_ORG_WORK_TYPE: org, S_WORK_TYPE: target.code, S_RSN: reason, S_APPL_DTL_TXT: "" });
    const close = await call(t.closeCheck, { ...form, S_DSMETHOD: t.closeCheck });
    const msg = close.etc.rtnMsg ?? "";
    if (msg !== "OK") throw new ApplicationBlockedError(msg ? msg.trim() : "JADE 가 마감 검사 결과를 주지 않았다");

    return {
      env,
      form,
      preview: { date: fmtYmd(req.date), orgWorkType: orgName, workType: `${target.name} (${target.code})`, reason, approvers: env.approvers },
    };
  });
}

function samePreview(a: RemoteRevertPlan["preview"], b: RemoteRevertPlan["preview"]): boolean {
  const line = (p: RemoteRevertPlan["preview"]) => p.approvers.map((x) => `${x.empId}^${x.type}`).join(",");
  return a.date === b.date && a.orgWorkType === b.orgWorkType && a.workType === b.workType && a.reason === b.reason && line(a) === line(b);
}

/** 승인된 재택 취소(근무유형 되돌리기) 한 건을 상신한다. 화면을 새로 열어 마감 검사를 다시 통과하고 미리보기와 같을 때만 보낸다. */
export async function commitRemoteWorkRevert(client: JadeClient, approved: RemoteRevertPlan["preview"]): Promise<{ date: string; applId: string }> {
  const workType = approved.workType.replace(/\s*\([^()]*\)$/, "");
  const plan = await prepareRemoteWorkRevert(client, { date: approved.date.replaceAll(".", ""), workType, reason: approved.reason });
  if (!samePreview(plan.preview, approved)) {
    throw new ApplicationBlockedError(`${approved.date} 재택 취소 내용이 미리보기 이후 바뀌었다 — prepare 부터 다시 해야 한다`);
  }
  return { date: approved.date, applId: await submitApplication(client, plan.env, plan.form) };
}
