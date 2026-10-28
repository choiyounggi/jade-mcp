import type { JadeClient } from "./client.js";
import { otpToken, PageStructureError, type PageContext } from "./page.js";
import type { JadeResponse, Row } from "./response.js";
import type { Params } from "./viewstate.js";

export class ApplicationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationBlockedError";
  }
}

export interface Approver {
  empId: string;
  name: string;
  title: string;
  /** 결재 유형 코드. 20·30·60 은 결재자가 아니고, 40·50 은 참조자다. */
  type: string;
}

/** 신청서 공통부(sys_appl.js 의 Apply)가 상신에 쓰는 값 — 새 신청서를 열 때 서버가 정해 준다. */
export interface ApplicationEnvelope {
  ctx: PageContext;
  dsClass: string;
  txToken: string;
  pathId: string;
  approvers: Approver[];
  infSendAppl: string;
  /** 신청서 공통 hidden 필드 — 화면이 열릴 때 sys_appl.js 가 신청서 유형 설정으로 채운다. */
  formFields: Params;
}

/** sys_appl.js 의 init 이 ApplType 행으로 채우는 hidden 필드와 그 기본값. */
export function initFormFields(typeRow: Row): Params {
  const or = (key: string, fallback: string) => typeRow[key] || fallback;
  return {
    S_INF_USE_YN: or("INF_USE_YN", "N"),
    S_BTN_CHG_YN: or("BTN_CHG_YN", "N"),
    S_PROC_FLAG: or("PROC_FLAG", "10"),
    S_PROC_TYPE: or("PROC_TYPE", "10"),
    S_AUTO_CHG_NO: or("AUTO_CHG_NO", "N"),
    S_AUTO_COMPLE_NO: or("AUTO_COMPLE_NO", "N"),
    S_APPL_TYPE_NM: typeRow.APPL_TYPE_NM ?? "",
    S_ONLY_APPL_TYPE_APPR_YN: or("ONLY_APPL_TYPE_APPR_YN", "N"),
    S_APPL_INSERT_REFER_YN: or("APPL_INSERT_REFER_YN", "N"),
    S_APPR_INSERT_REFER_YN: or("APPR_INSERT_REFER_YN", "N"),
    S_APPR_DELETE_REFER_YN: or("APPR_DELETE_REFER_YN", "N"),
    S_APPR_LINE_EDIT_YN: or("APPR_LINE_EDIT_YN", "N"),
  };
}

const NOT_APPROVER = new Set(["20", "30", "40", "50", "60"]);
const REFERENCE = new Set(["40", "50"]);

/** getCourse 의 LineDetail 행 → 결재자. COL3=사번, COL4=이름, COL5=직책, COL10=결재 유형 (sys_appl.js 의 makeLineDetail 과 같은 해석). */
export function toApprovers(rows: Row[]): Approver[] {
  return rows
    .filter((r) => r.COL3)
    .map((r) => ({ empId: r.COL3 ?? "", name: r.COL4 ?? "", title: r.COL5 ?? "", type: r.COL10 ?? "" }));
}

/** Apply.doApply 의 결재자 검증. 막혀야 하는 경우 사유를 던진다. */
export function checkApprovers(approvers: Approver[], applType: Row, selfEmpId: string): void {
  const deciders = approvers.filter((a) => !NOT_APPROVER.has(a.type));
  if (applType.APPR_PRS_YN === "Y" && deciders.length === 0) {
    throw new ApplicationBlockedError("결재선에 결재자가 없다 — JADE 에서 결재선을 먼저 확인해야 한다");
  }
  if (applType.APPL_TO_ME !== "Y" && deciders.some((a) => a.empId === selfEmpId)) {
    throw new ApplicationBlockedError("자신을 결재자로 둘 수 없는 신청서다");
  }
}

/** 새 신청서의 공통부를 준비한다: 중복요청 방지 토큰, 기본 결재선. */
export async function prepareEnvelope(
  client: JadeClient,
  ctx: PageContext,
  applType: string,
  targetEmpId: string,
): Promise<ApplicationEnvelope> {
  const common = otpToken(ctx, "ApplyOtpVal", "Sys_appl_common");
  const init = await client.call(ctx, common, otpToken(ctx, "ApplyOtpVal", "getInitInfo"), { S_APPL_TYPE: applType, S_APPL_ID: "" });
  const typeRow = init.datasets.ApplType?.[0];
  const txToken = init.etc.S_APPL_TX_TOKEN;
  if (!typeRow || !txToken) throw new PageStructureError("신청서 초기 정보(ApplType·S_APPL_TX_TOKEN)");

  const course = await client.call(ctx, common, otpToken(ctx, "ApplyOtpVal", "getCourse"), {
    S_COURSE: "TEMP",
    S_APPL_MODE: "APPL",
    S_APPL_TYPE: applType,
    S_APPL_ID: "",
    S_APPL_STAT_CD: "0",
    S_EMP_ID: "",
    S_TRG_EMP_ID: targetEmpId,
    S_APPR_LINE_STAND: typeRow.APPR_LINE_STAND ?? "",
  });
  const path = (course.datasets.ApprLine ?? []).find((r) => r.COL4 === "Y");
  if (!path?.COL2) throw new PageStructureError("기본 결재선(ApprLine)");
  const approvers = toApprovers(course.datasets.LineDetail ?? []);
  checkApprovers(approvers, typeRow, targetEmpId);

  const dsClass = ctx.inputs.S_DSCLASS;
  if (!dsClass) throw new PageStructureError("#S_DSCLASS");
  return {
    ctx,
    dsClass,
    txToken,
    pathId: path.COL2,
    approvers,
    infSendAppl: typeRow.INF_SEND_APPL || "N",
    formFields: initFormFields(typeRow),
  };
}

/**
 * Apply.doApply 의 상신: 결재자 재직 확인 → apply01. 오류 없이 돌아오면 상신된 것이다 — 신청서 번호가 응답에
 * 없더라도 실패로 보고하면 재시도로 중복 상신이 나므로 빈 문자열을 돌려준다.
 */
export async function submitApplication(client: JadeClient, env: ApplicationEnvelope, form: Params): Promise<string> {
  const common = otpToken(env.ctx, "ApplyOtpVal", "Sys_appl_common");
  const retiree = otpToken(env.ctx, "ApplyOtpVal", "searchRetiree");
  for (const a of env.approvers) {
    const r = await client.call(env.ctx, common, retiree, { S_EMP_ID: a.empId });
    if (r.etc.RET_STAT === "N") throw new ApplicationBlockedError(`결재자 ${a.name} 이(가) 퇴직자다 — 결재선을 바꿔야 한다`);
    if (r.etc.RET_STAT === "M") throw new ApplicationBlockedError(`결재자 ${a.name} 이(가) 휴직자다 — 결재선을 바꿔야 한다`);
  }

  // 키 순서는 Apply.doApply 와 같다 (공통부 → 화면 폼). __viewState 해시가 이 순서를 따른다.
  const params: Params = {
    S_TEMP_APPR: env.pathId,
    S_APPR_EMP_IDS: env.approvers.filter((a) => !NOT_APPROVER.has(a.type)).map((a) => a.empId).join(","),
    S_REFER_EMP_IDS: env.approvers.filter((a) => REFERENCE.has(a.type)).map((a) => `${a.empId}^${a.type}`).join(","),
    S_OLD_APPL_ID: "",
    S_PROC_FLAG: form.S_PROC_FLAG ?? "",
    S_INF_SEND_APPL: env.infSendAppl,
    S_APPL_TX_TOKEN: env.txToken,
    ...form,
  };
  const res: JadeResponse = await client.call(env.ctx, env.dsClass, otpToken(env.ctx, "ApplyOtpVal", "apply01"), params);
  return res.etc.APPL_ID ?? "";
}

/** 화면 폼(f1)의 기본값 — 화면 HTML 에 박혀 오는 입력값을 문서 순서대로 담는다. */
export function applicationBaseForm(ctx: PageContext): Params {
  const form: Params = {};
  for (const [k, v] of Object.entries(ctx.inputs)) {
    // 화면 JS 문자열 안의 태그(`id='F_STA_HM_"+r+"'`)도 걸리므로 정상 이름만 받는다.
    if (/^(S_|F_|Q_)[A-Za-z0-9_]*$/.test(k) && k !== "S_DSCLASS" && k !== "S_DSMETHOD") form[k] = v;
  }
  return form;
}
