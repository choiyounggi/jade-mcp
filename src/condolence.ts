import {
  applicationBaseForm,
  ApplicationBlockedError,
  prepareEnvelope,
  submitApplication,
  type ApplicationEnvelope,
  type Approver,
} from "./appl.js";
import type { JadeClient } from "./client.js";
import { openNewApplication } from "./menu.js";
import { callTokenAfter, caseTokenOf, PageStructureError } from "./page.js";
import type { Row } from "./response.js";
import type { Params } from "./viewstate.js";

const CONDOLENCE_FORM = { type: "1024", name: "경조 휴가 신청서", url: "/bsi/be_con/be_con_420_m01.jsp" } as const;
const SELF_FAMILY = "10";

export interface CondolenceRequest {
  /** 경조 유형 코드 (예: 3010 생일반차_오후, 1010 결혼(본인), 6040 조사(부모_본인)) */
  conType: string;
  /** 경조일 YYYYMMDD (생일반차면 쓰는 날) */
  conDate: string;
  /** 휴가 기간 YYYYMMDD. 휴가가 딸린 유형이면 필수, 없으면 경조금만 신청한다. */
  leaveStart?: string;
  leaveEnd?: string;
  /** 경조 대상 가족 이름. 본인 경조면 생략(본인 이름). */
  familyName?: string;
  /** 경조 대상 가족 생년월일 YYYYMMDD — JADE 가 요구하는 유형에서만 쓴다. */
  familyBirth?: string;
  reason: string;
  /** 경조품 배송지 — 배송이 있는 유형에서만 쓴다. */
  deliverZip?: string;
  deliverAddr?: string;
}

export interface CondolenceTokens {
  standard: string;
  types: string;
  families: string;
  rule: string;
  birthCheck: string;
  leaveRule: string;
  validate: string;
  dayCount: string;
}

export interface CondolencePlan {
  env: ApplicationEnvelope;
  tokens: CondolenceTokens;
  form: Params;
  maxLeaveDays: string;
  preview: {
    type: string;
    family: string;
    conDate: string;
    leave: string;
    benefit: string;
    reason: string;
    approvers: Approver[];
  };
}

export function parseCondolenceTokens(html: string): CondolenceTokens {
  const tokens: CondolenceTokens = {
    standard: callTokenAfter(html, "//법인별 기준정보", "법인별 기준정보 조회"),
    types: callTokenAfter(html, "if(_xapplStatus == null)", "경조 유형 조회"),
    families: callTokenAfter(html, "function chg_con_type(", "가족관계 조회"),
    rule: caseTokenOf(html, "_xsStat = [];", "경조 기준 조회"),
    birthCheck: callTokenAfter(html, "//가족관계 변경시 기준정보를 보여준다.", "생년월일 필요 여부 조회"),
    leaveRule: callTokenAfter(html, "function getRule(", "휴가 규칙 조회"),
    validate: caseTokenOf(html, 'S_CHK_MSG = xs.GetEtcData("CHK_MSG");', "휴가 기간 검증"),
    dayCount: callTokenAfter(html, "21.09.15 시작일자를", "휴가 일수 계산"),
  };
  // 생년월일 확인 호출은 doAction2(기준 조회) 바로 다음 줄이다 — 기준 조회 토큰이 잡히면 위치가 어긋난 것이다.
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) throw new PageStructureError("경조 휴가 신청서 호출 토큰");
  return tokens;
}

const YMD = /^\d{4}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

export function checkCondolenceRequest(req: CondolenceRequest): void {
  for (const [label, v] of [["경조일", req.conDate], ["휴가 시작일", req.leaveStart], ["휴가 종료일", req.leaveEnd], ["가족 생년월일", req.familyBirth]] as const) {
    if (v !== undefined && !YMD.test(v)) throw new ApplicationBlockedError(`${label}은 YYYYMMDD 형식이어야 한다`);
  }
  if ((req.leaveStart === undefined) !== (req.leaveEnd === undefined)) throw new ApplicationBlockedError("휴가 시작일과 종료일은 함께 줘야 한다");
  if (req.leaveStart && req.leaveEnd && req.leaveStart > req.leaveEnd) throw new ApplicationBlockedError("휴가 종료일이 시작일보다 빠르다");
  if (!req.reason.trim()) throw new ApplicationBlockedError("신청 사유가 비어 있다");
}

function rows(res: { datasets: Record<string, Row[]> }): Row[] {
  return Object.values(res.datasets)[0] ?? [];
}

function fmtYmd(ymd: string): string {
  return ymd ? `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}` : "";
}

/** 경조 휴가 신청서를 상신 직전까지 채우고 서버 검증을 통과시킨다. 저장·상신은 하지 않는다. */
export async function prepareCondolence(client: JadeClient, req: CondolenceRequest): Promise<CondolencePlan> {
  checkCondolenceRequest(req);
  return client.withSession(async (main) => {
    const { text, ctx } = await openNewApplication(client, main, CONDOLENCE_FORM);
    const t = parseCondolenceTokens(text);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    const empName = ctx.inputs.S_LOGIN_EMP_NM ?? "";
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, CONDOLENCE_FORM.type, emp);
    const call = (method: string, params: Params) => client.call(ctx, env.dsClass, method, params);

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields, S_FILE_NO: "", S_FILE_CNT_02: "", S_APPL_DTL_TXT: "" };
    Object.assign(form, { S_TARGET_EMP_ID: emp, S_TARGET_EMP_NM: empName, S_BEF_TARGET_EMP_ID: emp });

    const std = rows(await call(t.standard, form))[0] ?? {};
    form.S_STD_SET_2 = std.STD_SET_2 ?? "";

    const types = rows(await call(t.types, form)).filter((r) => r.CD);
    const type = types.find((r) => r.CD === req.conType);
    if (!type) {
      throw new ApplicationBlockedError(`경조 유형 ${req.conType} 이 없다. 고를 수 있는 유형: ${types.map((r) => `${r.CD} ${r.CD_NM}`).join(", ")}`);
    }
    form.S_CON_TYPE = req.conType;

    const families = rows(await call(t.families, form)).filter((r) => r.CD);
    if (families.length !== 1) throw new ApplicationBlockedError(`${type.CD_NM} 의 가족관계를 하나로 정할 수 없다`);
    const family = families[0]!;
    form.S_FAM_CD = family.CD ?? "";
    const familyName = family.CD === SELF_FAMILY ? (req.familyName ?? empName) : req.familyName;
    if (!familyName?.trim()) throw new ApplicationBlockedError(`경조 대상(${family.CD_NM})의 이름이 필요하다`);

    const rule = rows(await call(t.rule, { ...form, S_DSMETHOD: t.rule }))[0];
    if (!rule) throw new ApplicationBlockedError(`${type.CD_NM} 에 등록된 경조 기준이 없다`);
    if (rule.FILE_REG_YN === "Y" && rule.FILE_EST_YN === "Y") {
      throw new ApplicationBlockedError(`${type.CD_NM} 은 증빙 파일 첨부가 필수인데, 파일 첨부는 아직 지원하지 않는다 — JADE 화면에서 신청해야 한다`);
    }
    if (rule.DELIVER_ADDR_YN === "Y" && (!req.deliverZip || !req.deliverAddr)) {
      throw new ApplicationBlockedError(`${type.CD_NM} 은 경조품 배송지(우편번호·주소)가 필요하다`);
    }
    Object.assign(form, {
      S_COM_MON: rule.COM_MON ?? "",
      S_ECLUB_MON: rule.ECLUB_MON ?? "",
      S_CON_GOODS: rule.CON_GOODS ?? "",
      S_TM_CD: rule.TM_CD ?? "",
      S_CON_INFO: rule.CON_INFO ?? "",
      S_TM_INFO: rule.TM_INFO ?? "",
      S_FAM_NM: familyName,
    });

    const birthNeeded = (await call(t.birthCheck, form)).etc.BIRTH_ADDR_YN === "Y";
    if (birthNeeded && form.S_STD_SET_2 === "P") {
      throw new ApplicationBlockedError("이 유형은 가족 주민번호를 요구하는데, 주민번호 입력은 지원하지 않는다 — JADE 화면에서 신청해야 한다");
    }
    if (birthNeeded && !req.familyBirth) throw new ApplicationBlockedError("경조 대상 가족의 생년월일이 필요하다");

    const leaveRule = rows(await call(t.leaveRule, { S_APPL_TYPE: CONDOLENCE_FORM.type })).find((r) => r.CD === rule.TM_CD) ?? {};
    Object.assign(form, { S_CD_D_CNT_TYPE: leaveRule.D_CNT_TYPE ?? "", S_CD_USE_CNT: leaveRule.USE_CNT ?? "" });

    const withLeave = rule.TM_APPL_YN === "Y" && req.leaveStart !== undefined;
    if (rule.TM_APPL_YN === "Y" && !withLeave) throw new ApplicationBlockedError(`${type.CD_NM} 은 휴가 기간(leaveStart·leaveEnd)이 필요하다`);
    if (rule.TM_APPL_YN !== "Y" && req.leaveStart) throw new ApplicationBlockedError(`${type.CD_NM} 은 휴가 신청이 없는 유형이다 — 휴가 기간 없이 신청한다`);

    Object.assign(form, {
      F_BIRTH_YMD: fmtYmd(req.familyBirth ?? ""),
      F_CON_YMD: fmtYmd(req.conDate),
      F_TM_STA_YMD: withLeave ? fmtYmd(req.leaveStart!) : "",
      F_TM_END_YMD: withLeave ? fmtYmd(req.leaveEnd!) : "",
      S_DELIVER_ZIP_NO: req.deliverZip ?? "",
      S_DELIVER_ADDR: req.deliverAddr ?? "",
      S_NOTE: req.reason,
      // inputAutoUnformat 이 날짜 칸(F_*)마다 만드는 숫자형 사본
      S_BIRTH_YMD: req.familyBirth ?? "",
      S_BIRTH_YMD_PER: "",
      S_CON_YMD: req.conDate,
      S_TM_STA_YMD: withLeave ? req.leaveStart! : "",
      S_TM_END_YMD: withLeave ? req.leaveEnd! : "",
    });

    const maxLeaveDays = rule.TM_D_CNT ?? "";
    let leaveDays = "";
    if (withLeave) {
      await validate(client, env, t, form, maxLeaveDays);
      const count = rows(await call(t.dayCount, { ...form, S_TM_D_CNT: maxLeaveDays }))[0] ?? {};
      leaveDays = count.W_D_CNT ?? "";
      if (maxLeaveDays && Number(leaveDays) > Number(maxLeaveDays)) {
        throw new ApplicationBlockedError(`${type.CD_NM} 의 최대 휴가일수는 ${maxLeaveDays}일이다 — 종료일을 ${count.MAX_YMD} 이전으로 해야 한다`);
      }
    }

    return {
      env,
      tokens: t,
      form,
      maxLeaveDays,
      preview: {
        type: `${type.CD_NM} (${type.CD})`,
        family: `${family.CD_NM} ${familyName}`,
        conDate: fmtYmd(req.conDate),
        leave: withLeave ? `${fmtYmd(req.leaveStart!)} ~ ${fmtYmd(req.leaveEnd!)} (${leaveDays || maxLeaveDays}일)` : "없음",
        benefit: rule.TM_INFO || rule.CON_INFO || "",
        reason: req.reason,
        approvers: env.approvers,
      },
    };
  });
}

async function validate(client: JadeClient, env: ApplicationEnvelope, t: CondolenceTokens, form: Params, maxLeaveDays: string) {
  const res = await client.call(env.ctx, env.dsClass, t.validate, { ...form, S_TM_D_CNT: maxLeaveDays, S_DSMETHOD: t.validate });
  const msg = res.etc.CHK_MSG ?? "";
  if (msg !== "OK") throw new ApplicationBlockedError(msg ? msg.replaceAll("▶", "").trim() : "JADE 가 휴가 기간 검증 결과를 주지 않았다");
}

/** 준비된 경조 휴가 신청서를 상신한다. 휴가가 딸렸으면 상신 직전에 기간 검증을 한 번 더 통과해야 보낸다. */
export async function commitCondolence(client: JadeClient, plan: CondolencePlan): Promise<{ applId: string }> {
  if (plan.form.S_TM_STA_YMD) await validate(client, plan.env, plan.tokens, plan.form, plan.maxLeaveDays);
  return { applId: await submitApplication(client, plan.env, plan.form) };
}
