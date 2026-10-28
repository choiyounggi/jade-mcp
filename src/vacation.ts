import { applicationBaseForm, prepareEnvelope, submitApplication, ApplicationBlockedError, type ApplicationEnvelope, type Approver } from "./appl.js";
import type { JadeClient } from "./client.js";
import { openNewApplication } from "./menu.js";
import { callTokenAfter, caseTokenOf, PageStructureError } from "./page.js";
import type { Row } from "./response.js";
import type { Params } from "./viewstate.js";

const VACATION_FORM = { type: "1020", name: "휴가 신청서", url: "/tam4/tm_day/tm_day_010_m05.jsp" } as const;

export interface VacationRequest {
  /** 휴가 종류 코드 (예: 4010 연차휴가). */
  attendClass: string;
  /** YYYYMMDD */
  date: string;
  /** HHMM — 당일 안의 시간만 지원한다. */
  startHm: string;
  endHm: string;
  reason: string;
}

export interface VacationPlan {
  env: ApplicationEnvelope;
  validate: string;
  form: Params;
  preview: {
    type: string;
    date: string;
    time: string;
    useTime: string;
    reason: string;
    approvers: Approver[];
  };
}

/** 휴가 신청서 화면 JS 가 부르는 서버 메서드들. 토큰은 화면을 열 때마다 바뀌므로 호출 위치의 코드 모양으로 찾는다. */
export interface VacationTokens {
  types: string;
  quota: string;
  rules: string;
  rows: string;
  useTime: string;
  validate: string;
  dayCount: string;
  deductOrder: string;
}

export function parseVacationTokens(html: string): VacationTokens {
  const tokens: VacationTokens = {
    types: callTokenAfter(html, "function LoadPage()", "휴가 종류 조회"),
    quota: callTokenAfter(html, "function getRule(", "휴가 단위 조회"),
    rules: callTokenAfter(html, 'enableInput("F_END_YMD", true);', "휴가 종류 규칙 조회"),
    rows: caseTokenOf(html, "createAttedTr(xs, true, true);", "휴가 사용일 조회"),
    useTime: caseTokenOf(html, "var sel_ymd   = arguments[1];", "사용시간 계산"),
    validate: caseTokenOf(html, 'S_CHK_MSG = xs.GetEtcData("CHK_MSG")', "신청 기간 검증"),
    dayCount: callTokenAfter(html, 'S_CHK_MSG = xs.GetEtcData("CHK_MSG")', "신청일수 계산"),
    deductOrder: callTokenAfter(html, "function ddct_check()", "연차 차감순서 검사"),
  };
  // 위치로 찾은 토큰이 서로 겹치면 화면 구조가 바뀐 것이다 — 엉뚱한 메서드를 부르지 않게 멈춘다.
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) throw new PageStructureError("휴가 신청서 호출 토큰");
  return tokens;
}

function first(rows: Row[] | undefined): Row {
  return rows?.[0] ?? {};
}

function firstDataset(res: { datasets: Record<string, Row[]> }): Row[] {
  return Object.values(res.datasets)[0] ?? [];
}

function fmtYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function fmtHm(hm: string): string {
  return `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
}

export function checkVacationRequest(req: VacationRequest): void {
  if (!/^\d{8}$/.test(req.date)) throw new ApplicationBlockedError("날짜는 YYYYMMDD 형식이어야 한다");
  for (const hm of [req.startHm, req.endHm]) {
    if (!/^([01]\d|2[0-3])[0-5]\d$/.test(hm)) throw new ApplicationBlockedError(`시각 ${hm} 은 HHMM 형식이어야 한다`);
  }
  if (req.startHm >= req.endHm) throw new ApplicationBlockedError("종료 시각이 시작 시각보다 늦어야 한다 (자정을 넘는 신청은 지원하지 않는다)");
  if (!req.reason.trim()) throw new ApplicationBlockedError("신청 사유가 비어 있다");
}

/** 휴가 신청서를 상신 직전까지 채우고 서버 검증(CHK_MSG)까지 통과시킨다. 저장·상신은 하지 않는다. */
export async function prepareVacation(client: JadeClient, req: VacationRequest): Promise<VacationPlan> {
  checkVacationRequest(req);
  return client.withSession(async (main) => {
    const { text, ctx } = await openNewApplication(client, main, VACATION_FORM);
    const t = parseVacationTokens(text);
    const emp = ctx.inputs.S_LOGIN_EMP_ID;
    if (!emp) throw new PageStructureError("#S_LOGIN_EMP_ID");
    const env = await prepareEnvelope(client, ctx, VACATION_FORM.type, emp);
    const call = (method: string, params: Params) => client.call(ctx, env.dsClass, method, params);

    const types = firstDataset(await call(t.types, { S_APPL_TYPE: VACATION_FORM.type }));
    const type = types.find((r) => r.CD === req.attendClass);
    if (!type) {
      const list = types.filter((r) => r.CD).map((r) => `${r.CD} ${r.CD_NM}`).join(", ");
      throw new ApplicationBlockedError(`휴가 종류 ${req.attendClass} 가 없다. 고를 수 있는 종류: ${list}`);
    }

    const form: Params = { ...applicationBaseForm(ctx), ...env.formFields, S_APPL_DTL_TXT: "", S_FILE_NO: "" };
    Object.assign(form, {
      S_TARGET_EMP_ID: emp,
      S_TARGET_EMP_NM: ctx.inputs.S_LOGIN_EMP_NM ?? "",
      S_BEF_TARGET_EMP_ID: emp,
      S_ATTEND_CLASS: req.attendClass,
      F_STA_YMD: fmtYmd(req.date),
      F_END_YMD: fmtYmd(req.date),
      S_STA_YMD: req.date,
      S_END_YMD: req.date,
    });

    const quota = first(firstDataset(await call(t.quota, { ...form, S_DSMETHOD: t.quota }))).QUOTA_TIME_DH ?? "";
    const meta = firstDataset(await call(t.rules, { S_APPL_TYPE: VACATION_FORM.type })).find((r) => r.CD === req.attendClass) ?? {};
    Object.assign(form, {
      S_QUOTA_TIME_DH: quota,
      S_CD_Q_YN: meta.Q_YN ?? "",
      S_CD_Q_CD: meta.Q_CD ?? "",
      S_CD_D_CNT_TYPE: meta.D_CNT_TYPE ?? "",
      S_CD_USE_CNT: meta.USE_CNT ?? "",
      S_CD_ATTEND_YN: meta.ATTEND_YN ?? "",
      S_APPL_TIME_INPUT_YN: meta.APPL_TIME_INPUT_YN ?? "",
      S_APPL_USE_TIME_YN: meta.APPL_USE_TIME_YN ?? "",
    });
    if (quota !== "H") throw new ApplicationBlockedError("시간 단위로 신청하는 휴가 종류만 지원한다");

    const day = firstDataset(await call(t.rows, { ...form, S_DSMETHOD: t.rows })).find((r) => r.ATTEND_YMD === req.date);
    if (!day) throw new ApplicationBlockedError(`${fmtYmd(req.date)} 은 휴가를 쓸 수 있는 근무일이 아니다`);
    if (day.APPL_ANL_USETYPE !== "10") throw new ApplicationBlockedError("시각을 직접 입력하는 신청 방식이 아니라 지원하지 않는다");

    const use = first(
      firstDataset(
        await call(t.useTime, {
          S_TARGET_EMP_ID: emp,
          S_STD_YMD: req.date,
          S_STA_YMD: req.date,
          S_STA_TIME: req.startHm,
          S_END_YMD: req.date,
          S_END_TIME: req.endHm,
        }),
      ),
    );
    const hour = use.USE_HOUR ?? "";
    const min = use.USE_MIN ?? "";
    if (!hour || Number(hour) + Number(min) === 0) throw new ApplicationBlockedError("서버가 계산한 사용시간이 0 이다 — 시각을 확인해야 한다");

    Object.assign(form, {
      S_APPL_ANL_USETYPE: day.APPL_ANL_USETYPE,
      S_NOTE: req.reason,
      S_ATTEND_YMD: req.date,
      S_STA_YMD_CLASS: "2",
      F_STA_HM: fmtHm(req.startHm),
      S_END_YMD_CLASS: "2",
      F_END_HM: fmtHm(req.endHm),
      F_USE_HOUR: hour,
      F_USE_MIN: min,
      // applSumTime: 시간 + 분/100 (분을 소수 둘째 자리에 싣는 화면 규칙)
      S_APPL_SUM_TIME: String(Number(hour) + Number(min) / 100),
      S_ATTEND_YMDS: req.date,
      S_ALL_DAY_YNS: "N",
      S_USE_HOURS: hour,
      S_USE_MINS: min,
      S_STA_YMDS: "2",
      S_STA_HMS: req.startHm,
      S_END_YMDS: "2",
      S_END_HMS: req.endHm,
      // 단위시간 선택이 없는 신청 방식이면 화면이 "undefined" 를 그대로 보낸다.
      S_UNIT_TIME_CDS: "undefined",
    });
    // inputAutoUnformat 이 시간 칸(F_*_n)마다 만드는 숫자형 사본
    Object.assign(form, { S_STA_HM_0: req.startHm, S_END_HM_0: req.endHm, S_USE_HOUR_0: hour, S_USE_MIN_0: min });

    const days = first(firstDataset(await call(t.dayCount, { ...form, S_DSMETHOD: t.dayCount })));
    if (!Number(days.W_D_CNT)) throw new ApplicationBlockedError("적용일수가 0 이다 — 휴가를 쓸 수 있는 날이 아니다");
    form.S_DAYS_DUTIE_DAY = days.T_D_CNT ?? "";
    form.S_WORK_DUTIE_DAY = days.W_D_CNT ?? "";

    await validate(client, env, t.validate, form);
    const order = first(firstDataset(await call(t.deductOrder, { ...form, S_DSMETHOD: t.deductOrder })));
    if (order.APPLY_ATTEND_CD_NM) throw new ApplicationBlockedError(`${order.APPLY_ATTEND_CD_NM}을(를) 먼저 소진해야 한다`);

    return {
      env,
      validate: t.validate,
      form,
      preview: {
        type: `${type.CD_NM} (${type.CD})`,
        date: fmtYmd(req.date),
        time: `${fmtHm(req.startHm)} ~ ${fmtHm(req.endHm)}`,
        useTime: `${Number(hour)}시간${Number(min) ? ` ${Number(min)}분` : ""}`,
        reason: req.reason,
        approvers: env.approvers,
      },
    };
  });
}

async function validate(client: JadeClient, env: ApplicationEnvelope, method: string, form: Params): Promise<void> {
  const res = await client.call(env.ctx, env.dsClass, method, { ...form, S_DSMETHOD: method });
  const msg = res.etc.CHK_MSG ?? "";
  if (msg !== "OK") throw new ApplicationBlockedError(msg ? msg.replaceAll("▶", "").trim() : "JADE 가 신청 기간 검증 결과를 주지 않았다");
}

/** 준비된 휴가 신청서를 상신한다. 상신 직전에 서버 검증을 한 번 더 통과해야 보낸다. */
export async function commitVacation(client: JadeClient, plan: VacationPlan): Promise<{ applId: string }> {
  await validate(client, plan.env, plan.validate, plan.form);
  return { applId: await submitApplication(client, plan.env, plan.form) };
}
