import { applicationBaseForm, prepareEnvelope, submitApplication, ApplicationBlockedError, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openNewApplication } from "./menu.js";
import { caseTokenOf, PageStructureError } from "./page.js";
import type { JadeResponse, Row } from "./response.js";
import type { Params } from "./viewstate.js";

const OVERTIME_FORM = { type: "1050", name: "연장 근무 신청서", url: "/tam4/tm_day/tm_day_100_m01.jsp" } as const;
/** cbTM102 의 일자 구분: 2=당일, 3=익일 */
const SAME_DAY = "2";
const NEXT_DAY = "3";
/** 대체휴일 날짜·시각까지 받아야 하는 대체/보상 유형 (setYmd·doValidation 의 200·400 분기) */
const NEEDS_REWARD_DATE = new Set(["200", "400"]);
/** setComboRewardType 이 서버 목록이 비었을 때 까는 기본 목록 */
const DEFAULT_REWARD_TYPES = "연장근무시간(OT) 누적□100■휴일대체일 지정□200■휴일대체일 미지정□300";

export interface OvertimeRequest {
  /** 근무일 YYYYMMDD */
  date: string;
  /** HHMM. 근무일 당일 시각이다. */
  startHm: string;
  /** HHMM. 시작 시각보다 이르거나 같으면 익일 시각으로 본다(예: 09:30 ~ 02:00 → 익일 02:00). */
  endHm: string;
  reason: string;
  /** 대체/보상 유형 코드 — 휴일 근무처럼 화면이 이 칸을 보여 줄 때만 쓴다. 100=OT 누적, 300=휴일대체일 미지정 */
  rewardType?: string;
}

/** 연장 근무 신청서 화면 JS 가 부르는 서버 메서드들. 토큰은 화면을 열 때마다 바뀌므로 호출 위치의 코드 모양으로 찾는다. */
export interface OvertimeTokens {
  workType: string;
  attend: string;
  check: string;
  /** setComboRewardType 은 화면 클래스(S_DSCLASS)가 아닌 별도 클래스를 부른다. */
  rewardTypes: { dsClass: string; method: string; stdYmd: string };
}

export function parseOvertimeTokens(html: string): OvertimeTokens {
  const anchor = "function setComboRewardType()";
  const at = html.indexOf(anchor);
  if (at < 0) throw new PageStructureError("대체/보상 유형 목록 조회");
  const combo = /ajaxSyncRequestXS\("([^"]+)",\s*"([^"]+)",\s*\{[^}]*S_STD_YMD\s*:\s*"(\d{8})"/.exec(html.slice(at));
  if (!combo?.[1] || !combo[2] || !combo[3]) throw new PageStructureError("대체/보상 유형 목록 조회");

  const tokens: OvertimeTokens = {
    workType: caseTokenOf(html, '$("#S_WORK_TYPE_CD").val(xs.GetEtcData("WORK_TYPE_CD"));', "근무유형 조회"),
    attend: caseTokenOf(html, 'xs.GetEtcData("ATTEND_TXT")', "근태사항 조회"),
    check: caseTokenOf(html, '$("#S_TYPE").val(p1);', "신청 검증"),
    rewardTypes: { dsClass: combo[1], method: combo[2], stdYmd: combo[3] },
  };
  // 위치로 찾은 토큰이 서로 겹치면 화면 구조가 바뀐 것이다 — 엉뚱한 메서드를 부르지 않게 멈춘다.
  const methods = [tokens.workType, tokens.attend, tokens.check, tokens.rewardTypes.method];
  if (new Set(methods).size !== methods.length) throw new PageStructureError("연장 근무 신청서 호출 토큰");
  return tokens;
}

function fmtYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function fmtHm(hm: string): string {
  return `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
}

/** addYmd(ymd, "D", 1) — 달력 날짜 계산이라 UTC 로 해서 서머타임 영향을 받지 않게 한다. */
export function nextYmd(ymd: string): string {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface OvertimeSpan {
  staClass: string;
  endClass: string;
  staYmd: string;
  endYmd: string;
}

/**
 * 입력 검사와 일자 구분 결정. 화면은 시작·종료마다 당일/익일을 고르게 하고 setYmd 로 실제 날짜를 만든다 —
 * 여기서는 시작을 당일로 두고, 종료가 시작보다 이르거나 같으면 익일로 정한다.
 */
export function resolveOvertimeSpan(req: OvertimeRequest): OvertimeSpan {
  if (!/^\d{8}$/.test(req.date)) throw new ApplicationBlockedError("날짜는 YYYYMMDD 형식이어야 한다");
  for (const hm of [req.startHm, req.endHm]) {
    if (!/^([01]\d|2[0-3])[0-5]\d$/.test(hm)) throw new ApplicationBlockedError(`시각 ${hm} 은 HHMM 형식이어야 한다`);
  }
  // 같은 시각을 익일로 해석하면 24시간 신청이 된다 — 오타일 가능성이 커서 막는다.
  if (req.startHm === req.endHm) throw new ApplicationBlockedError("시작 시각과 종료 시각이 같다");
  if (!req.reason.trim()) throw new ApplicationBlockedError("신청 사유가 비어 있다");
  const overnight = req.endHm < req.startHm;
  return {
    staClass: SAME_DAY,
    endClass: overnight ? NEXT_DAY : SAME_DAY,
    staYmd: req.date,
    endYmd: overnight ? nextYmd(req.date) : req.date,
  };
}

export interface RewardOption {
  code: string;
  name: string;
}

/** setComboRewardType: 서버 목록 첫 행의 CD 가 비면(행이 없어도) 화면에 박힌 기본 목록을 쓴다. */
export function rewardOptions(rows: Row[]): RewardOption[] {
  if (!rows[0]?.CD) {
    return DEFAULT_REWARD_TYPES.split("■").map((item) => {
      const [name = "", code = ""] = item.split("□");
      return { code, name };
    });
  }
  return rows.filter((r) => r.CD).map((r) => ({ code: r.CD ?? "", name: r.CD_NM ?? "" }));
}

export interface WorkDayInfo {
  workType: string;
  workTypeCd: string;
  workDutieYn: string;
  workYn: string;
  subAttendCd: string;
  chgHoliAsgnYn: string;
  subAttendUseSta: string;
  subAttendUseEnd: string;
}

export function toWorkDayInfo(etc: Record<string, string>): WorkDayInfo {
  return {
    workType: etc.WORK_TYPE ?? "",
    workTypeCd: etc.WORK_TYPE_CD ?? "",
    workDutieYn: etc.WORK_DUTIE_YN ?? "",
    workYn: etc.WORK_YN ?? "",
    subAttendCd: etc.SUB_ATTEND_CD ?? "",
    chgHoliAsgnYn: etc.CHG_HOLI_ASGN_YN ?? "",
    subAttendUseSta: etc.SUB_ATTEND_USE_STA ?? "",
    subAttendUseEnd: etc.SUB_ATTEND_USE_END ?? "",
  };
}

/**
 * 대체/보상 유형이 필요한지. doValidation 은 대체휴가 코드가 있는 비근무일이면 유형을 요구하지만, 화면(setRewardTr)은
 * 휴일대체 지정 가능(CHG_HOLI_ASGN_YN=Y)일 때만 그 칸을 보여 준다 — 칸이 숨은 채 필수인 날은 화면에서도 상신할 수 없다.
 */
export function rewardRequirement(day: WorkDayInfo): "none" | "required" | "unavailable" {
  if (!day.subAttendCd || day.workDutieYn !== "N") return "none";
  return day.chgHoliAsgnYn === "Y" ? "required" : "unavailable";
}

/** 고른 대체/보상 유형 검사. 대체휴일 날짜를 함께 받는 유형(200·400)은 지원하지 않는다. */
export function pickRewardType(options: RewardOption[], wanted: string | undefined): RewardOption {
  const list = options.map((o) => `${o.code} ${o.name}`).join(", ");
  if (!wanted) throw new ApplicationBlockedError(`휴일 근무라 대체/보상 유형(rewardType)을 골라야 한다. 고를 수 있는 유형: ${list}`);
  const option = options.find((o) => o.code === wanted);
  if (!option) throw new ApplicationBlockedError(`대체/보상 유형 ${wanted} 가 없다. 고를 수 있는 유형: ${list}`);
  if (NEEDS_REWARD_DATE.has(wanted)) throw new ApplicationBlockedError(`${option.name}은(는) 대체휴일 날짜까지 정해야 해서 지원하지 않는다 — JADE 화면에서 신청해야 한다`);
  return option;
}

/** BF_APPL 검증(doAction2 의 S_TYPE 분기)은 결과를 Etc 가 아닌 첫 행의 CHK_MSG 로 준다. 행이 없으면 화면도 상신하지 않는다. */
export function checkResult(res: JadeResponse): void {
  const msg = Object.values(res.datasets)[0]?.[0]?.CHK_MSG;
  if (msg === undefined) throw new ApplicationBlockedError("JADE 가 연장 근무 신청 검증 결과를 주지 않았다");
  if (msg !== "OK") throw new ApplicationBlockedError(msg ? msg.replaceAll("▶", "").trim() : "JADE 가 연장 근무 신청을 막았다 (사유 없음)");
}

export interface OvertimePlan {
  env: ApplicationEnvelope;
  check: string;
  form: Params;
  preview: {
    date: string;
    workType: string;
    /** 그날 이미 잡힌 근태(휴가 등). 없으면 빈 문자열 */
    attendance: string;
    time: string;
    rewardType: string | null;
    reason: string;
    approvers: Approver[];
  };
}

async function runCheck(client: JadeClient, env: ApplicationEnvelope, method: string, form: Params): Promise<void> {
  checkResult(await client.call(env.ctx, env.dsClass, method, { ...form, S_DSMETHOD: method }));
}

/** 연장 근무 신청서를 상신 직전까지 채우고 서버 검증(BF_APPL)까지 통과시킨다. 저장·상신은 하지 않는다. */
export async function prepareOvertime(client: JadeClient, req: OvertimeRequest): Promise<OvertimePlan> {
  const span = resolveOvertimeSpan(req);
  return client.withSession(async (main) => {
    const { text, ctx } = await openNewApplication(client, main, OVERTIME_FORM);
    const t = parseOvertimeTokens(text);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, OVERTIME_FORM.type, emp);
    const call = (method: string, params: Params) => client.call(ctx, env.dsClass, method, params);

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields };
    Object.assign(form, {
      S_TARGET_EMP_ID: emp,
      S_TARGET_EMP_NM: ctx.inputs.S_LOGIN_EMP_NM ?? "",
      S_BEF_TARGET_EMP_ID: emp,
      F_WORK_YMD: fmtYmd(req.date),
      S_WORK_YMD: req.date,
      S_STA_YMD_CLASS: span.staClass,
      S_END_YMD_CLASS: span.endClass,
    });

    const day = toWorkDayInfo((await call(t.workType, { ...form, S_DSMETHOD: t.workType })).etc);
    if (!day.workTypeCd) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 의 근무유형을 JADE 가 주지 않았다 — 신청할 수 없는 날일 수 있다`);
    Object.assign(form, {
      S_WORK_TYPE: day.workType,
      S_WORK_TYPE_CD: day.workTypeCd,
      S_WORK_DUTIE_YN: day.workDutieYn,
      S_WORK_YN: day.workYn,
      S_SUB_ATTEND_CD: day.subAttendCd,
      S_CHG_HOLI_ASGN_YN: day.chgHoliAsgnYn,
      S_SUB_ATTEND_USE_STA: day.subAttendUseSta,
      S_SUB_ATTEND_USE_END: day.subAttendUseEnd,
    });
    const attendance = ((await call(t.attend, { ...form, S_DSMETHOD: t.attend })).etc.ATTEND_TXT ?? "").trim().replace(/^,+/, "").replace(/,$/, "");

    let reward: RewardOption | null = null;
    const need = rewardRequirement(day);
    if (need === "unavailable") {
      throw new ApplicationBlockedError(`${fmtYmd(req.date)} 은 대체/보상 유형이 필요한데 JADE 화면이 그 칸을 보여 주지 않는 날이라 신청할 수 없다`);
    }
    if (need === "required") {
      const rt = t.rewardTypes;
      const rows = Object.values((await client.call(ctx, rt.dsClass, rt.method, { S_TARGET_EMP_ID: emp, S_STD_YMD: rt.stdYmd })).datasets)[0] ?? [];
      reward = pickRewardType(rewardOptions(rows), req.rewardType);
    }

    // inputAutoUnformat 이 F_* 칸마다 만드는 S_* 사본과 setYmd 가 채우는 실제 날짜. 대체휴일 칸은 200·400 이 아니면 비운다.
    Object.assign(form, {
      F_STA_HM: fmtHm(req.startHm),
      S_STA_HM: req.startHm,
      F_END_HM: fmtHm(req.endHm),
      S_END_HM: req.endHm,
      S_STA_YMD: span.staYmd,
      S_END_YMD: span.endYmd,
      S_RSN: req.reason,
      S_REWARD_TYPE: reward?.code ?? "",
      F_REWARD_YMD: "",
      S_REWARD_YMD: "",
      S_RW_STA_YMD_CLASS: "",
      F_RW_STA_HM: "",
      S_RW_STA_HM: "",
      S_RW_END_YMD_CLASS: "",
      F_RW_END_HM: "",
      S_RW_END_HM: "",
      S_RW_STA_YMD: "",
      S_RW_END_YMD: "",
      S_RW_WORK_TYPE: "",
      S_RW_WORK_TYPE_CD: "",
      S_APPL_DTL_TXT: "",
      S_TYPE: "BF_APPL",
    });
    await runCheck(client, env, t.check, form);

    return {
      env,
      check: t.check,
      form,
      preview: {
        date: fmtYmd(req.date),
        workType: day.workType,
        attendance,
        time: `${fmtYmd(span.staYmd)} ${fmtHm(req.startHm)} ~ ${fmtYmd(span.endYmd)} ${fmtHm(req.endHm)}`,
        rewardType: reward ? `${reward.name} (${reward.code})` : null,
        reason: req.reason,
        approvers: env.approvers,
      },
    };
  });
}

/** 준비된 연장 근무 신청서를 상신한다. 화면의 doApplyBefore 처럼 상신 직전에 BF_APPL 검증을 한 번 더 통과해야 보낸다. */
export async function commitOvertime(client: JadeClient, plan: OvertimePlan): Promise<{ applId: string }> {
  await runCheck(client, plan.env, plan.check, plan.form);
  return { applId: await submitApplication(client, plan.env, plan.form) };
}
