import type { JadeClient } from "./client.js";
import { inputValue, otpToken, PageStructureError, type PageContext } from "./page.js";
import type { JadeResponse } from "./response.js";
import type { Params } from "./viewstate.js";

// 메인 화면의 「업무시작/업무종료」가 여는 팝업. 저장 로직은 전부 이 팝업 화면의 JS 에 있다.
const POPUP_URL = "/ess/tam4/ess_tam_402_p01.jsp";
const PGM_ID = "ess_tam4_401_m02";
const PGM_URL = "/ess/tam4/ess_tam_401_m02.jsp";

export type PunchKind = "in" | "out";

/** 저장 직전까지 마친 상태. commit 은 이 팝업 컨텍스트로 저장만 수행한다. */
export interface PunchPlan {
  kind: PunchKind;
  workDate: string;
  recordedIn: string;
  recordedOut: string;
  serverDate: string;
  serverTime: string;
  notices: string[];
  popup: PopupTokens;
  form: Params;
}

interface PopupTokens {
  ctx: PageContext;
  dsClass: string;
  device: string;
  serverTime: string;
  ipList: string;
  validate: string;
  save: string;
  yesterdayOutInsert: string;
  sip: string;
}

export class PunchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PunchBlockedError";
  }
}

const LITERAL = /["']([A-Za-z0-9+/]{40,}={0,2})["']/g;

/** anchor 바로 앞(window 글자 안)의 마지막 암호 토큰 리터럴. 화면 JS 의 호출 구조에 기대므로 못 찾으면 중단한다. */
function tokenBefore(html: string, anchor: RegExp, what: string, window = 400): string {
  const m = anchor.exec(html);
  if (!m) throw new PageStructureError(what);
  const literals = [...html.slice(Math.max(0, m.index - window), m.index).matchAll(LITERAL)];
  const token = literals.at(-1)?.[1];
  if (!token) throw new PageStructureError(what);
  return token;
}

export function parsePopupTokens(html: string, ctx: PageContext): PopupTokens {
  const save = /value=["']저장["'][^>]*onclick=["']doAction\(['"]([^'"]+)['"]\)/.exec(html)?.[1];
  if (!save) throw new PageStructureError("출퇴근 저장 버튼");
  const yesterdayOutInsert = /YE_DAY_OUT_YMDHM_INSERT\s*=\s*"([^"]*)"/.exec(html)?.[1];
  const sip = /var\s+SIP\s*=\s*"([^"]*)"/.exec(html)?.[1];
  if (yesterdayOutInsert === undefined || sip === undefined) throw new PageStructureError("출퇴근 팝업 설정값");

  const tokens: PopupTokens = {
    ctx,
    dsClass: inputValue(ctx, "S_DSCLASS"),
    device: tokenBefore(html, /USE_DEVICE_CD/, "기기 확인 호출"),
    serverTime: tokenBefore(html, /oracleYmd\s*=\s*xs\.GetCellValue/, "서버 시각 호출"),
    ipList: tokenBefore(html, /ipCheckYn\.push/, "허용 IP 조회 호출"),
    validate: tokenBefore(
      html,
      /serializeForm\(\)\s*,\s*function\s*\(xs\)\s*\{\s*if\(\s*xs\.GetEtcData\("ALERT_MSG"\)\s*\)/,
      "저장 전 검증 호출",
      200,
    ),
    save,
    yesterdayOutInsert,
    sip,
  };
  const distinct = new Set([tokens.device, tokens.serverTime, tokens.ipList, tokens.validate, tokens.save]);
  if (distinct.size !== 5) throw new PageStructureError("서로 다른 출퇴근 호출 토큰");
  return tokens;
}

/** 팝업 JS 의 ipCheck 를 그대로 옮겼다 — 서버가 본 접속 IP(SIP)가 허용 목록에 없으면 저장하지 않는다. */
export function ipCheck(
  rows: { IP_CHECK_YN?: string; IP_SAVE_YN?: string; IP_ADDR?: string }[],
  sip: string,
): { allowed: boolean; saveIp: string } {
  let ok = false;
  let saveIp = "";
  for (const row of rows) {
    const addr = row.IP_ADDR ?? "";
    if (addr.includes("*")) {
      for (const pattern of addr.split(",")) {
        if (!pattern.includes("*")) continue;
        const want = pattern.split(".");
        const have = sip.split(".");
        let same = 0;
        for (let i = 0; i < 4; i++) if (want[i] === have[i] || want[i] === "*") same++;
        ok = same === 4;
      }
    }
    if (!ok) {
      ok = row.IP_CHECK_YN === "Y" ? addr.includes(sip) : true;
      saveIp = row.IP_SAVE_YN === "Y" ? sip : "";
    }
    if (ok) break;
  }
  return { allowed: ok, saveIp };
}

/**
 * 팝업이 검증 응답(Etc)을 보고 저장할지 막을지 정하는 분기를 옮겼다.
 * 브라우저가 confirm 으로 묻는 지점은 notices 로 모아 사용자 승인 단계에 보여준다.
 */
export function decide(
  etc: Record<string, string>,
  kind: PunchKind,
  stdYmdHm: string,
  yesterdayOutInsert: string,
): { notices: string[] } {
  const v = (k: string) => etc[k] ?? "";
  const isOut = kind === "out";
  const notices: string[] = [];

  if (v("ALERT_MSG")) {
    if (yesterdayOutInsert === "Y") {
      if (isOut && v("YE_DAY_IN_HM") !== "" && v("YE_DAY_OUT_HM") === "" && v("C_IN_YMDHM") === "") {
        throw new PunchBlockedError("전날 퇴근 미기록 상태라 전날 퇴근으로 기록할지 확인이 필요하다 — 브라우저에서 처리해야 한다");
      }
      if (v("YE_DAY_IN_HM") === "") throw new PunchBlockedError("출근 기록을 먼저 해야 한다");
    } else {
      notices.push(v("ALERT_MSG"));
      if (v("TM_NOT_FIRST_OUT") === "Y" && v("C_IN_YMDHM") === "" && isOut) {
        throw new PunchBlockedError("출근 기록을 먼저 해야 한다");
      }
    }
  }

  const sequenceChecks = () => {
    if (!isOut && v("YE_DAY_OUT_YMD") !== "" && v("YE_DAY_OUT_HM") !== "" && v("IN_OUT_ITR") !== "") {
      if (Number(v("IN_OUT_TERM")) < Number(v("IN_OUT_ITR"))) {
        throw new PunchBlockedError(`전날 퇴근 뒤 ${v("IN_OUT_ITR")} 이 지나야 출근을 기록할 수 있다`);
      }
    }
    if (v("TM_NOT_FIRST_OUT") === "Y" && v("C_IN_YMDHM") === "" && isOut) {
      if (yesterdayOutInsert !== "Y" || !(v("YE_DAY_IN_HM") && !v("YE_DAY_OUT_HM"))) {
        throw new PunchBlockedError("출근 기록을 먼저 해야 한다");
      }
    } else if (v("C_OUT_YMDHM") !== "" && !isOut) {
      if (Number(v("C_OUT_YMDHM")) <= Number(stdYmdHm)) {
        throw new PunchBlockedError(`출근 시각이 이미 기록된 퇴근 시각(${v("ALERT_C_OUT_YMDHM")}) 뒤다`);
      }
    } else if (v("C_IN_YMDHM") !== "" && isOut) {
      if (Number(stdYmdHm) <= Number(v("C_IN_YMDHM"))) {
        throw new PunchBlockedError(`퇴근 시각이 출근 시각(${v("ALERT_C_IN_YMDHM")})보다 앞선다`);
      }
    }
  };

  const plan = v("PLAN_CHK_CONFIRM");
  if (plan === "PLAN_NO_CHECK") {
    if (v("CONFIRM") !== "OK") throw new PunchBlockedError(v("CONFIRM") || "JADE 가 저장을 허용하지 않았다");
    sequenceChecks();
  } else if (plan === "OK") {
    sequenceChecks();
  } else {
    if (v("TM_NOT_FIRST_OUT") === "Y" && v("C_IN_YMDHM") === "" && isOut) {
      throw new PunchBlockedError("출근 기록을 먼저 해야 한다");
    }
    // 원본의 저장 분기(TERM_CHK_YN=Y·CONFIRM=OK·PLAN_CHK_CONFIRM=OK)는 앞의 OK 분기에 먼저 걸려 여기서는 닿지 않는다.
    if (v("TERM_CHK_YN") === "Y" && v("CONFIRM") !== "OK") throw new PunchBlockedError(v("CONFIRM"));
    throw new PunchBlockedError(plan || "근무계획 확인을 통과하지 못했다");
  }
  return { notices };
}

function firstRow(res: JadeResponse, dataset: string): Record<string, string> {
  const row = res.datasets[dataset]?.[0];
  if (!row) throw new Error(`메인 정보에 ${dataset} 가 없다`);
  return row;
}

function formatYmd(ymd: string): string {
  return ymd.length === 8 ? `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6)}` : ymd;
}

function formatHm(hm: string): string {
  return hm.length === 4 ? `${hm.slice(0, 2)}:${hm.slice(2)}` : hm;
}

async function openPopup(client: JadeClient, main: PageContext, kind: PunchKind, info: JadeResponse) {
  const tmp = firstRow(info, "tmpInfo");
  const emp = firstRow(info, "empInfo");
  if (tmp.INPUT_YN !== "Y") throw new PunchBlockedError("입력이 허용되지 않은 일자라 출퇴근을 기록할 수 없다");
  if (tmp.IN_OUT_YN !== "Y") throw new PunchBlockedError("출퇴근 기록을 하지 않는 근로유형이다");
  if (tmp.CLOSE_YN !== "N") throw new PunchBlockedError("근태가 마감되어 출퇴근을 기록할 수 없다");
  if (tmp.PLAN_WORK_YN !== "Y" && tmp.UNPLAN_CHK_WORK_RECORD !== "Y") {
    throw new PunchBlockedError("근무계획 정보가 없어 출퇴근을 기록할 수 없다");
  }

  const auth = await client.call(main, otpToken(main, "hunelOtpVal", "Sy_main_page"), otpToken(main, "hunelOtpVal", "searchAuth"), {
    S_PGM_ID: PGM_ID,
    S_PGM_URL: PGM_URL,
  });
  const isOut = kind === "out";
  const page = main.page;
  const form: Params = {
    X_PROFILE_ID: auth.etc.PROFILE_ID ?? "",
    X_MENU_NM: isOut ? "퇴근기록" : "출근기록",
    X_MODULE_ID: auth.etc.MODULE_ID ?? "",
    X_PGM_ID: PGM_ID,
    X_PGM_URL: PGM_URL,
    X_ENC_VAL: auth.etc.ENC_VAL ?? "",
    S_EMP_ID: emp.EMP_ID ?? "",
    S_YMD: tmp.WORK_YMD ?? "",
    S_GUBUN: isOut ? "END" : "STA",
    S_STD_YMD: isOut ? tmp.I_OUT_YMD : tmp.I_IN_YMD,
    S_STD_HM: isOut ? tmp.I_OUT_HM : tmp.I_IN_HM,
    ...(isOut
      ? { S_C_OUT_YMD: tmp.C_OUT_YMD, S_C_OUT_HM: (tmp.C_OUT_HM ?? "").replace("--:--", "") }
      : { S_C_IN_YMD: tmp.C_IN_YMD, S_C_IN_HM: (tmp.C_IN_HM ?? "").replace("--:--", "") }),
    S_ATTEND_MANAGE: tmp.ATTEND_MANAGE,
    S_IP_API: tmp.IP_CHECK_YN,
    S_WORK_PLAN_TYPE: tmp.WORK_PLAN_TYPE,
    [isOut ? "S_UNPLAN_CHK_MSG" : "S_UNPLAN_CHK_TOAST"]: tmp.UNPLAN_CHK_TOAST,
    X_C_CD: page.C_CD,
    X_MENU_ID: auth.etc.MENU_ID ?? "",
    X_SQL_ID: page.SQL_ID,
    X_EMP_SCH_AUTH_CD: page.EMP_SCH_AUTH_CD,
    X_POP_URL: POPUP_URL,
    X_HELP_PGM_ID: page.HELP_PGM_ID,
    MASKING_USE_YN: page.MASKING_USE_YN,
    PER_NO_LIMIT_YN: page.PER_NO_LIMIT_YN,
    RSN_POP_USE_YN: page.RSN_POP_USE_YN,
    ENC_MASKING_USE_YN: page.ENC_MASKING_USE_YN,
    ENC_PER_NO_LIMIT_YN: page.ENC_PER_NO_LIMIT_YN,
    ENC_RSN_POP_USE_YN: page.ENC_RSN_POP_USE_YN,
    ENC_T: page.ENC_T,
    EXCEL_FILE_PWD_YN: page.EXCEL_FILE_PWD_YN,
    CONF_INPUT_USE_YN: page.CONF_INPUT_USE_YN,
    CLIPBOARD_YN: page.CLIPBOARD_YN,
  };
  // submit2 는 값이 없는 파라미터도 빈 문자열로 보낸다.
  for (const k of Object.keys(form)) form[k] ??= "";

  const html = await client.openScreen(form);
  return { tokens: parsePopupTokens(html.text, html.ctx), tmp, emp };
}

/** 팝업의 「저장」 클릭에서 confirm 직전까지 — 검증만 하고 저장하지 않는다. */
export async function preparePunch(client: JadeClient, kind: PunchKind): Promise<PunchPlan> {
  return client.withSession(async (main) => {
    const info = await client.call(main, inputValue(main, "S_DSCLASS"), otpToken(main, "hunelOtpVal", "getMainInfo"));
    const { tokens, tmp, emp } = await openPopup(client, main, kind, info);
    const { ctx } = tokens;
    const empId = emp.EMP_ID ?? "";
    const ymd = ctx.inputs.S_YMD || tmp.WORK_YMD || "";

    const device = await client.call(ctx, tokens.dsClass, tokens.device, { S_EMP_ID: empId, S_YMD: ymd });
    const deviceCd = device.datasets[Object.keys(device.datasets)[0] ?? ""]?.[0]?.USE_DEVICE_CD ?? "";
    if (!deviceCd.includes("20") && !deviceCd.includes("30")) {
      throw new PunchBlockedError("근태 기록이 허용된 기기·지역이 아니다");
    }

    const time = await client.call(ctx, tokens.dsClass, tokens.serverTime, {});
    const timeRow = time.datasets[Object.keys(time.datasets)[0] ?? ""]?.[0] ?? {};
    const serverDate = timeRow.ORACLE_YMD ?? "";
    const serverTime = timeRow.ORACLE_TIME ?? "";
    if (!serverDate || !serverTime) throw new PageStructureError("서버 시각 응답");

    const ips = await client.call(ctx, tokens.dsClass, tokens.ipList, { S_STD_YMD: serverDate, S_EMP_ID: empId });
    const ipRows = ips.datasets[Object.keys(ips.datasets)[0] ?? ""] ?? [];
    const ip = ipCheck(ipRows, tokens.sip);
    if (!ip.allowed) throw new PunchBlockedError("허용된 IP 에서 접속하지 않아 출퇴근을 기록할 수 없다");

    const isOut = kind === "out";
    // 팝업 폼 f1 을 serializeForm 한 결과와 같은 순서·필드. 시각 입력칸은 비활성이라 빠지고,
    // inputAutoUnformat 이 만든 S_STD_YMD/S_STD_TIME 이 끝에 붙는다.
    const form: Params = {
      S_DSCLASS: tokens.dsClass,
      S_DSMETHOD: tokens.save,
      S_SAVENAME: ctx.inputs.S_SAVENAME ?? "",
      S_EMP_ID: empId,
      S_YMD: ymd,
      S_GUBUN: isOut ? "END" : "STA",
      S_CUR_TIME: ctx.inputs.S_CUR_TIME ?? "",
      S_CUR_YMD: ctx.inputs.S_CUR_YMD ?? "",
      S_IN_IP_ADDR: isOut ? (ctx.inputs.S_IN_IP_ADDR ?? "") : ip.saveIp,
      S_OUT_IP_ADDR: isOut ? ip.saveIp : (ctx.inputs.S_OUT_IP_ADDR ?? ""),
      S_ATTEND_MANAGE: ctx.inputs.S_ATTEND_MANAGE ?? "",
      S_WORK_PLAN_TYPE: ctx.inputs.S_WORK_PLAN_TYPE ?? "",
      S_CHANGE_YN: ctx.inputs.S_CHANGE_YN ?? "N",
      S_RSN: "",
      S_STD_YMD: serverDate,
      S_STD_TIME: serverTime,
    };

    const check = await client.call(ctx, tokens.dsClass, tokens.validate, form);
    const { notices } = decide(check.etc, kind, serverDate + serverTime, tokens.yesterdayOutInsert);

    return {
      kind,
      workDate: ymd,
      recordedIn: tmp.C_IN_HM_DP ?? "",
      recordedOut: tmp.C_OUT_HM_DP ?? "",
      serverDate: formatYmd(serverDate),
      serverTime: formatHm(serverTime),
      notices,
      popup: tokens,
      form,
    };
  });
}

/** 승인된 계획을 저장한다. 서버 시각은 저장 시점으로 다시 받아 검증을 한 번 더 통과시킨다. */
export async function commitPunch(client: JadeClient, plan: PunchPlan): Promise<{ recordedAt: string; message: string }> {
  const { popup, kind } = plan;
  const time = await client.call(popup.ctx, popup.dsClass, popup.serverTime, {});
  const timeRow = time.datasets[Object.keys(time.datasets)[0] ?? ""]?.[0] ?? {};
  const serverDate = timeRow.ORACLE_YMD ?? "";
  const serverTime = timeRow.ORACLE_TIME ?? "";
  if (!serverDate || !serverTime) throw new PageStructureError("서버 시각 응답");

  const form: Params = { ...plan.form, S_STD_YMD: serverDate, S_STD_TIME: serverTime };
  const check = await client.call(popup.ctx, popup.dsClass, popup.validate, form);
  decide(check.etc, kind, serverDate + serverTime, popup.yesterdayOutInsert);

  const saved = await client.call(popup.ctx, popup.dsClass, popup.save, form);
  return {
    recordedAt: `${formatYmd(serverDate)} ${formatHm(serverTime)}`,
    message: saved.etc.ALERT_MSG || "저장되었습니다",
  };
}
