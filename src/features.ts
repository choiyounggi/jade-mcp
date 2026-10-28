import type { JadeClient } from "./client.js";
import { inputValue, otpToken } from "./page.js";
import type { JadeResponse, Row } from "./response.js";

/** 메인 화면이 처음 뜰 때 받는 데이터 묶음 — 오늘 근태·연차·최근 신청 내역이 함께 온다. */
export async function fetchMainInfo(client: JadeClient): Promise<JadeResponse> {
  return client.withSession((main) =>
    client.call(main, inputValue(main, "S_DSCLASS"), otpToken(main, "hunelOtpVal", "getMainInfo")),
  );
}

function first(res: JadeResponse, dataset: string): Row | undefined {
  return res.datasets[dataset]?.[0];
}

export interface TodayStatus {
  workDate: string;
  clockIn: string;
  clockOut: string;
  workTime: string;
  /** 오늘 출퇴근 입력이 허용되는지 (근무계획·마감·근로유형 조건을 모두 통과해야 true) */
  canRecord: boolean;
}

export function toTodayStatus(res: JadeResponse): TodayStatus {
  const row = first(res, "tmpInfo");
  if (!row) throw new Error("오늘 근태 정보(tmpInfo)가 응답에 없다");
  return {
    workDate: row.WORK_YMD ?? "",
    clockIn: row.C_IN_HM_DP ?? "",
    clockOut: row.C_OUT_HM_DP ?? "",
    workTime: row.WORK_TIME_DP ?? "",
    canRecord:
      row.INPUT_YN === "Y" &&
      row.IN_OUT_YN === "Y" &&
      row.CLOSE_YN === "N" &&
      (row.PLAN_WORK_YN === "Y" || row.UNPLAN_CHK_WORK_RECORD === "Y"),
  };
}

export interface VacationBalance {
  total: string;
  used: string;
  remaining: string;
  unit: string;
}

export function toVacationBalance(res: JadeResponse): VacationBalance {
  const row = first(res, "vacCnt");
  if (!row) throw new Error("연차 정보(vacCnt)가 응답에 없다");
  return {
    total: row.CRT_D_CNT ?? "",
    used: row.USE_D_CNT ?? "",
    remaining: row.BLN_D_CNT ?? "",
    unit: (row.QUOTA_UNIT ?? "").trim(),
  };
}

export interface ApplicationSummary {
  date: string;
  type: string;
  status: string;
  applId: string;
}

export function toRecentApplications(res: JadeResponse): ApplicationSummary[] {
  return (res.datasets.applList ?? []).map((r) => ({
    date: r.APPL_YMD ?? "",
    type: r.APPL_TYPE_NM ?? "",
    status: r.APPL_STAT_NM ?? "",
    applId: r.APPL_ID ?? "",
  }));
}
