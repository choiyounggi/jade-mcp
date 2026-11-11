import { monthsBefore, type ApplicationRow } from "../history.js";
import type { CalendarApi } from "./google.js";
import {
  buildDesired,
  diffEvents,
  isWorkday,
  kstParts,
  monthEnd,
  nextDay,
  scheduleCheck,
  type CalendarEntry,
  type DesiredEvent,
  type SyncPlan,
} from "./plan.js";

/**
 * hourly  = launchd 정각 실행 (시간대·공휴일·늦은 실행을 거른다)
 * trigger = jade 쓰기 도구가 상신·취소 직후 띄운 실행
 * manual  = 사용자가 직접 실행
 */
export type SyncMode = "hourly" | "trigger" | "manual";

export interface SyncDeps {
  now(): Date;
  /** months(YYYYMM) 달력을 이어 붙인 것과, 신청일 fromYmd~toYmd 의 결재중·최종완료 신청서 전부. */
  fetchJade(months: string[], fromYmd: string, toYmd: string): Promise<{ calendar: CalendarEntry[]; applications: ApplicationRow[] }>;
  openCalendar(): Promise<CalendarApi>;
}

export type SyncReport =
  | { status: "skipped"; reason: string }
  | { status: "done"; dryRun: boolean; fromYmd: string; toYmd: string; desired: DesiredEvent[]; plan: SyncPlan };

const APPLICATION_LOOKBACK_MONTHS = 12;

function toIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00+09:00`;
}

/** 오늘부터 다음 달 말일까지를 JADE 기준으로 맞춘다. */
export async function runSync(deps: SyncDeps, opts: { mode: SyncMode; dryRun: boolean }): Promise<SyncReport> {
  const now = kstParts(deps.now());
  if (opts.mode === "hourly") {
    const check = scheduleCheck(now);
    if (!check.run) return { status: "skipped", reason: check.reason };
  }
  const fromYmd = now.ymd;
  const toYmd = monthEnd(now.ymd, 1);
  const months = [now.ymd.slice(0, 6), toYmd.slice(0, 6)];
  const { calendar, applications } = await deps.fetchJade(months, monthsBefore(now.ymd, APPLICATION_LOOKBACK_MONTHS), now.ymd);

  // 달력 응답이 비거나 깨졌는데 진행하면 범위 안의 동기화 일정이 전부 삭제된다.
  const today = calendar.find((d) => d.ymd === now.ymd);
  if (!today || calendar.length < 56) throw new Error(`JADE 달력 응답이 비정상이다 (${calendar.length}일, 오늘 ${today ? "있음" : "없음"})`);
  if (opts.mode === "hourly" && !isWorkday(today.workType)) return { status: "skipped", reason: `오늘은 ${today.workType}` };

  const desired = buildDesired({ calendar, applications, fromYmd, toYmd });
  const gcal = await deps.openCalendar();
  const existing = await gcal.listManaged(toIso(fromYmd), toIso(nextDay(toYmd)));
  const plan = diffEvents(desired, existing);
  if (!opts.dryRun) {
    for (const e of plan.insert) await gcal.insert(e);
    for (const u of plan.update) await gcal.update(u.id, u.event);
    for (const e of plan.remove) await gcal.remove(e.id);
  }
  return { status: "done", dryRun: opts.dryRun, fromYmd, toYmd, desired, plan };
}

function describe(e: DesiredEvent): string {
  return `${e.ymd} ${e.start.slice(11, 16)}~${e.end.slice(11, 16)} ${e.summary}`;
}

/** 로그·터미널에 남길 줄들. */
export function formatReport(r: SyncReport): string[] {
  if (r.status === "skipped") return [`건너뜀: ${r.reason}`];
  const { plan } = r;
  return [
    `${r.dryRun ? "[dry-run] " : "동기화 완료: "}${r.fromYmd}~${r.toYmd} 추가 ${plan.insert.length} · 수정 ${plan.update.length} · 삭제 ${plan.remove.length} (JADE 일정 ${r.desired.length}건)`,
    ...plan.insert.map((e) => `  + ${describe(e)}`),
    ...plan.update.map((u) => `  ~ ${describe(u.event)}`),
    ...plan.remove.map((e) => `  - ${(e.start ?? "").slice(0, 16)} ${e.summary}`),
  ];
}
