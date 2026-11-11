import { describe, expect, it } from "vitest";
import type { CalendarApi } from "../src/gcal/google.js";
import { buildPlist } from "../src/gcal/launchd.js";
import type { CalendarEntry, DesiredEvent, ExistingEvent } from "../src/gcal/plan.js";
import { formatReport, runSync, type SyncDeps } from "../src/gcal/sync.js";

const MONDAY_10_KST = new Date("2026-11-16T01:00:00Z");

function month(prefix: string, days: number, override: Record<string, Partial<CalendarEntry>> = {}): CalendarEntry[] {
  return Array.from({ length: days }, (_, i) => {
    const ymd = `${prefix}${String(i + 1).padStart(2, "0")}`;
    return { ymd, workType: "선택근무제(IT)", workTime: "", remarks: [], ...override[ymd] };
  });
}

function fakeCalendar(existing: ExistingEvent[] = []) {
  const calls: string[] = [];
  const api: CalendarApi = {
    async listManaged(timeMin, timeMax) {
      calls.push(`list ${timeMin} ${timeMax}`);
      return existing;
    },
    async insert(e: DesiredEvent) {
      calls.push(`insert ${e.key}`);
    },
    async update(id: string, e: DesiredEvent) {
      calls.push(`update ${id} ${e.key}`);
    },
    async remove(id: string) {
      calls.push(`remove ${id}`);
    },
  };
  return { api, calls };
}

function deps(over: Partial<SyncDeps> & { calendar?: CalendarEntry[] }, api: CalendarApi): SyncDeps & { fetched: unknown[] } {
  const fetched: unknown[] = [];
  const calendar = over.calendar ?? [...month("202611", 30, { "20261123": { workType: "재택근무제" } }), ...month("202612", 31)];
  return {
    fetched,
    now: over.now ?? (() => MONDAY_10_KST),
    fetchJade:
      over.fetchJade ??
      (async (months, from, to) => {
        fetched.push({ months, from, to });
        return { calendar, applications: [] };
      }),
    openCalendar: over.openCalendar ?? (async () => api),
  };
}

describe("runSync", () => {
  it("오늘~다음 달 말일을 맞추고 변경을 적용한다", async () => {
    const { api, calls } = fakeCalendar([
      { id: "old", key: "remote-20261120", summary: "재택근무", start: "2026-11-20T09:30:00+09:00", end: "2026-11-20T18:30:00+09:00" },
    ]);
    const d = deps({}, api);
    const report = await runSync(d, { mode: "hourly", dryRun: false });
    expect(d.fetched).toEqual([{ months: ["202611", "202612"], from: "20251116", to: "20261116" }]);
    expect(calls).toEqual(["list 2026-11-16T00:00:00+09:00 2027-01-01T00:00:00+09:00", "insert remote-20261123", "remove old"]);
    expect(formatReport(report)[0]).toBe("동기화 완료: 20261116~20261231 추가 1 · 수정 0 · 삭제 1 (JADE 일정 1건)");
  });

  it("dry-run 은 목록만 만들고 구글 캘린더를 바꾸지 않는다", async () => {
    const { api, calls } = fakeCalendar();
    const report = await runSync(deps({}, api), { mode: "manual", dryRun: true });
    expect(calls.filter((c) => !c.startsWith("list"))).toEqual([]);
    expect(formatReport(report)).toEqual(["[dry-run] 20261116~20261231 추가 1 · 수정 0 · 삭제 0 (JADE 일정 1건)", "  + 20261123 09:30~18:30 재택근무"]);
  });

  it("정각 실행은 주말·늦은 실행·공휴일을 건너뛰지만, 상신 직후 실행은 공휴일에도 돈다", async () => {
    const { api } = fakeCalendar();
    const sunday = () => new Date("2026-11-15T01:00:00Z");
    const late = () => new Date("2026-11-16T01:04:00Z");
    expect(await runSync(deps({ now: sunday }, api), { mode: "hourly", dryRun: true })).toEqual({ status: "skipped", reason: "주말" });
    expect((await runSync(deps({ now: late }, api), { mode: "hourly", dryRun: true })).status).toBe("skipped");
    const holiday = [...month("202611", 30, { "20261116": { workType: "제헌절" } }), ...month("202612", 31)];
    expect(await runSync(deps({ calendar: holiday }, api), { mode: "hourly", dryRun: true })).toEqual({ status: "skipped", reason: "오늘은 제헌절" });
    expect((await runSync(deps({ calendar: holiday }, api), { mode: "trigger", dryRun: true })).status).toBe("done");
  });

  it("달력 응답이 모자라면 구글 캘린더를 건드리기 전에 멈춘다", async () => {
    const { api, calls } = fakeCalendar([{ id: "keep", key: "remote-20261123", summary: "재택근무", start: "", end: "" }]);
    await expect(runSync(deps({ calendar: month("202611", 30) }, api), { mode: "manual", dryRun: false })).rejects.toThrow("JADE 달력 응답이 비정상");
    await expect(runSync(deps({ calendar: [] }, api), { mode: "manual", dryRun: false })).rejects.toThrow("오늘 없음");
    expect(calls).toEqual([]);
  });

  it("윤일에도 1년 전 신청일을 실제 있는 날짜로 계산한다", async () => {
    const { api } = fakeCalendar();
    const leapDay = () => new Date("2028-02-29T01:00:00Z");
    const d = deps({ now: leapDay, calendar: [...month("202802", 29), ...month("202803", 31)] }, api);
    await runSync(d, { mode: "manual", dryRun: true });
    expect(d.fetched).toEqual([{ months: ["202802", "202803"], from: "20270301", to: "20280229" }]);
  });

  it("JADE·구글 오류는 그대로 올린다", async () => {
    const { api } = fakeCalendar();
    const failing = deps({ fetchJade: async () => Promise.reject(new Error("JADE 로그인 실패")) }, api);
    await expect(runSync(failing, { mode: "manual", dryRun: false })).rejects.toThrow("JADE 로그인 실패");
    const noAuth = deps({ openCalendar: async () => Promise.reject(new Error("구글 인증이 만료")) }, api);
    await expect(runSync(noAuth, { mode: "manual", dryRun: false })).rejects.toThrow("구글 인증이 만료");
  });
});

describe("buildPlist", () => {
  it("평일 9~19시 정각 55개, 인자·경로를 XML 이스케이프한다", () => {
    const xml = buildPlist({ programArguments: ["/node", "--import", "tsx", "/a b/main.ts", "gcal", "sync"], workingDirectory: "/a b & c", logDir: "/logs" });
    expect(xml.match(/<key>Weekday<\/key>/g)).toHaveLength(55);
    expect(xml).toContain("<key>Weekday</key><integer>5</integer><key>Hour</key><integer>19</integer>");
    expect(xml).not.toContain("<integer>0</integer><key>Hour");
    expect(xml).toContain("<string>/a b/main.ts</string>");
    expect(xml).toContain("<string>/a b &amp; c</string>");
    expect(xml).toContain("<key>RunAtLoad</key><false/>");
  });
});
