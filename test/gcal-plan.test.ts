import { describe, expect, it } from "vitest";
import {
  buildDesired,
  diffEvents,
  isWorkday,
  kstParts,
  monthEnd,
  parseApplication,
  scheduleCheck,
  toGoogleEvent,
  type CalendarEntry,
  type DesiredEvent,
  type ExistingEvent,
} from "../src/gcal/plan.js";
import type { ApplicationRow } from "../src/history.js";

// 실제 신청내역 문구 형식만 본뜬 합성 데이터 — 이름·번호는 가짜다.
function app(over: Partial<ApplicationRow>): ApplicationRow {
  return {
    applId: "1",
    applType: "1020",
    applTypeName: "휴가 신청서",
    module: "근태-휴가/휴직",
    appliedAt: "2026.11.01 10:00",
    statusCode: "900",
    statusName: "최종완료",
    progress: "완료",
    content: "",
    target: "홍길동",
    targetOrg: "개발팀",
    applicant: "홍길동",
    comments: 0,
    ...over,
  };
}

const pending = { statusCode: "200", statusName: "결재중", progress: "진행중" as const };
const day = (ymd: string, workType = "선택근무제(IT)", remarks: string[] = []): CalendarEntry => ({ ymd, workType, workTime: "", remarks });
const remoteApp = (applId: string, date: string, extra: Partial<ApplicationRow> = {}) =>
  app({
    applId,
    applType: "1130",
    applTypeName: "재택 근무 신청서",
    module: "근태-근태/근무",
    content: `근무일:${date} 월요일 / 원근무유형:선택근무제(IT) [당일 09:30 ~ 당일 18:30]  / 변경근무유형:재택근무제 [당일 10:00 ~ 당일 19:00]`,
    ...extra,
  });
const brief = (events: DesiredEvent[]) => events.map((e) => [e.key, e.start.slice(11, 16), e.end.slice(11, 16), e.summary]);

describe("parseApplication", () => {
  it("시각이 적힌 여러 날 연차를 날짜별로 나눈다", () => {
    const entries = parseApplication(
      app({ content: "연차휴가 [2026.07.20 월요일(09:30 ~ 18:30) : 8 시간]  , [2026.07.21 화요일(09:30 ~ 18:30) : 8 시간]  [사유:여름 휴가]" }),
    );
    expect(entries.map((e) => [e.kind, e.ymd, e.start, e.end, e.summary, e.pending])).toEqual([
      ["leave", "20260720", "09:30", "18:30", "연차휴가 (8시간)", false],
      ["leave", "20260721", "09:30", "18:30", "연차휴가 (8시간)", false],
    ]);
  });

  it("근태/근무 신청서(출장·외근·교육)는 attend 로, day 단위는 일로 적는다", () => {
    const [trip] = parseApplication(
      app({ applType: "1010", applTypeName: "근태/근무 신청서", module: "근태-근태/근무", content: "외근 [2026.11.20 금요일(14:00 ~ 18:30) : 0.5day]  [사유:고객사 방문]" }),
    );
    expect([trip?.kind, trip?.start, trip?.end, trip?.summary]).toEqual(["attend", "14:00", "18:30", "외근 (0.5일)"]);
  });

  it("재택 근무 신청서는 변경근무유형의 시각을 쓰고, 시각이 없으면 09:30~18:30", () => {
    const [timed] = parseApplication(remoteApp("7", "2026.11.23"));
    expect([timed?.kind, timed?.ymd, timed?.start, timed?.end]).toEqual(["remote", "20261123", "10:00", "19:00"]);
    const [plain] = parseApplication(remoteApp("8", "2026.11.24", { content: "근무일:2026.11.24 화요일 / 변경근무유형:재택근무제" }));
    expect([plain?.start, plain?.end]).toEqual(["09:30", "18:30"]);
  });

  it("시각 없는 경조휴가는 오전/오후 기본 시각으로 휴가기간 전체를 채운다", () => {
    const pm = parseApplication(
      app({
        applType: "1024",
        applTypeName: "경조 휴가 신청서",
        content: "경조금·휴가신청 /  생일반차_오후(본인) / 가족명 : 홍길동(본인) / 휴가기간 : 2026.11.06 금요일~2026.11.06 금요일 / 회사지원금 : 0 /",
      }),
    );
    expect(pm.map((e) => [e.ymd, e.start, e.end, e.label])).toEqual([["20261106", "14:30", "18:30", "생일반차_오후(본인)"]]);
    const full = parseApplication(
      app({ applType: "1024", applTypeName: "경조 휴가 신청서", content: "경조금·휴가신청 / 결혼(본인) / 휴가기간 : 2026.11.30 월요일~2026.12.02 수요일 /" }),
    );
    expect(full.map((e) => [e.ymd, e.start, e.end])).toEqual([
      ["20261130", "09:30", "18:30"],
      ["20261201", "09:30", "18:30"],
      ["20261202", "09:30", "18:30"],
    ]);
  });

  it("결재중 신청은 pending 으로 표시한다", () => {
    const [e] = parseApplication(app({ ...pending, content: "연차휴가 [2026.11.20 금요일(15:00 ~ 19:00) : 4 시간]" }));
    expect(e?.pending).toBe(true);
  });

  it("취소 신청서·반려·다른 신청서·형식 불명·시각 역전은 빈 배열", () => {
    const content = "연차휴가 [2026.11.20 금요일(09:30 ~ 18:30) : 8 시간]";
    expect(parseApplication(app({ content, applTypeName: "전사연휴일 휴가 취소 신청서" }))).toEqual([]);
    expect(parseApplication(app({ content, statusCode: "300", progress: "반려" }))).toEqual([]);
    expect(parseApplication(app({ content, applType: "1110", applTypeName: "출퇴근시각 등록 요청서", module: "근태-근태/근무" }))).toEqual([]);
    expect(parseApplication(app({ content: "" }))).toEqual([]);
    expect(parseApplication(app({ content: "연차휴가 [2026.11.20 금요일(18:30 ~ 09:30) : 8 시간]" }))).toEqual([]);
  });
});

describe("buildDesired", () => {
  const range = { fromYmd: "20261111", toYmd: "20261231" };

  it("승인된 재택은 달력 기준(신청서 시각 우선), 승인된 휴가·출장은 달력 표시가 있을 때만 만든다", () => {
    const calendar = [
      day("20261110", "재택근무제"),
      day("20261116", "재택근무제"),
      day("20261123", "재택근무제"),
      day("20261120", "선택근무제(IT)", ["연차휴가(4h)"]),
      day("20261124"),
      day("20261125", "선택근무제(IT)", ["외근(4h)"]),
    ];
    const applications = [
      remoteApp("5", "2026.11.23"),
      app({ applId: "10", content: "연차휴가 [2026.11.20 금요일(15:00 ~ 19:00) : 4 시간]" }),
      // 승인 후 취소돼 달력에서 사라진 휴가
      app({ applId: "11", content: "연차휴가 [2026.11.24 화요일(09:30 ~ 18:30) : 8 시간]" }),
      app({ applId: "12", applType: "1010", applTypeName: "근태/근무 신청서", module: "근태-근태/근무", content: "외근 [2026.11.25 수요일(14:00 ~ 18:00) : 4 시간]" }),
    ];
    expect(brief(buildDesired({ calendar, applications, ...range }))).toEqual([
      ["remote-20261116", "09:30", "18:30", "재택근무"],
      ["leave-10-20261120", "15:00", "19:00", "연차휴가 (4시간)"],
      ["remote-20261123", "10:00", "19:00", "재택근무"],
      ["attend-12-20261125", "14:00", "18:00", "외근 (4시간)"],
    ]);
  });

  it("결재중 신청은 (결재중) 을 붙여 달력 표시 없이도 만들고, 승인되면 같은 키가 된다", () => {
    const calendar = [day("20261130"), day("20261207")];
    const applications = [
      app({ ...pending, applId: "20", content: "연차휴가 [2026.11.30 월요일(09:30 ~ 13:30) : 4 시간]" }),
      remoteApp("21", "2026.12.07", pending),
    ];
    expect(brief(buildDesired({ calendar, applications, ...range }))).toEqual([
      ["leave-20-20261130", "09:30", "13:30", "(결재중) 연차휴가 (4시간)"],
      ["remote-20261207", "10:00", "19:00", "(결재중) 재택근무"],
    ]);
  });

  it("이름이 달력 표시와 다른 승인 휴가는 남은 표시와 짝짓고, 신청서가 없는 표시는 표시로 만든다", () => {
    const calendar = [day("20261113", "선택근무제(IT)", ["경조휴가(8h)"]), day("20261127", "선택근무제(IT)", ["교육(4h)", "생일반차(오후)(4h)"])];
    const applications = [
      app({ applId: "30", applType: "1024", applTypeName: "경조 휴가 신청서", content: "경조금·휴가신청 / 결혼(본인) / 휴가기간 : 2026.11.13 금요일~2026.11.13 금요일 /" }),
    ];
    expect(brief(buildDesired({ calendar, applications, ...range }))).toEqual([
      ["leave-30-20261113", "09:30", "18:30", "결혼(본인)"],
      ["remark-20261127-0", "09:30", "18:30", "교육(4h)"],
      ["remark-20261127-1", "14:30", "18:30", "생일반차(오후)(4h)"],
    ]);
  });

  it("재택 날에 8시간 이상 휴가·출장이 있으면 재택은 빼고, 반차면 둘 다 둔다", () => {
    const calendar = [day("20261116", "재택근무제", ["출장(8h)"]), day("20261123", "재택근무제", ["연차휴가(4h)"])];
    const applications = [
      app({ applId: "40", applType: "1010", applTypeName: "근태/근무 신청서", module: "근태-근태/근무", content: "출장 [2026.11.16 월요일(09:30 ~ 18:30) : 1.0day]" }),
      app({ applId: "41", content: "연차휴가 [2026.11.23 월요일(14:30 ~ 18:30) : 4 시간]" }),
    ];
    expect(brief(buildDesired({ calendar, applications, ...range })).map(([key]) => key)).toEqual([
      "attend-40-20261116",
      "remote-20261123",
      "leave-41-20261123",
    ]);
  });

  it("취소된 승인 휴가는 종류가 다른 남은 표시(신청서 없는 교육)와 짝짓지 않는다", () => {
    const calendar = [day("20261116", "재택근무제", ["교육(4h)"])];
    const applications = [app({ applId: "50", content: "연차휴가 [2026.11.16 월요일(09:30 ~ 18:30) : 8 시간]" })];
    expect(brief(buildDesired({ calendar, applications, ...range }))).toEqual([
      ["remark-20261116-0", "09:30", "18:30", "교육(4h)"],
      ["remote-20261116", "09:30", "18:30", "재택근무"],
    ]);
  });

  it("같은 날 시간이 다른 휴가는 시간 수가 맞는 표시와 짝짓는다", () => {
    const calendar = [day("20261117", "선택근무제(IT)", ["연차휴가(4h)", "연차휴가(2h)"])];
    const applications = [
      app({ applId: "60", content: "연차휴가 [2026.11.17 화요일(17:00 ~ 19:00) : 2 시간]" }),
      app({ applId: "61", content: "연차휴가 [2026.11.17 화요일(09:30 ~ 13:30) : 4 시간]" }),
      // 취소돼 표시가 없는 8시간 연차
      app({ applId: "62", content: "연차휴가 [2026.11.17 화요일(09:30 ~ 18:30) : 8 시간]" }),
    ];
    expect(brief(buildDesired({ calendar, applications, ...range })).map(([key]) => key)).toEqual(["leave-61-20261117", "leave-60-20261117"]);
  });

  it("같은 종류·시간 신청서 둘에 표시가 하나면 나중에 신청한 것을 쓴다", () => {
    const calendar = [day("20261118", "선택근무제(IT)", ["연차휴가(2h)"])];
    const applications = [
      app({ applId: "70", appliedAt: "2026.11.01 09:00", content: "연차휴가 [2026.11.18 수요일(09:30 ~ 11:30) : 2 시간]" }),
      app({ applId: "71", appliedAt: "2026.11.05 09:00", content: "연차휴가 [2026.11.18 수요일(17:00 ~ 19:00) : 2 시간]" }),
    ];
    expect(brief(buildDesired({ calendar, applications, ...range }))).toEqual([["leave-71-20261118", "17:00", "19:00", "연차휴가 (2시간)"]]);
  });

  it("신청서 없는 4시간 표시는 시각을 몰라도 종일로 보지 않아 재택을 남긴다", () => {
    const calendar = [day("20261119", "재택근무제", ["외근(4h)"])];
    expect(brief(buildDesired({ calendar, applications: [], ...range })).map(([key]) => key)).toEqual(["remark-20261119-0", "remote-20261119"]);
  });

  it("범위 밖은 빼고, 빈 입력은 빈 결과", () => {
    const calendar = [day("20261110", "재택근무제"), day("20270101", "재택근무제")];
    expect(buildDesired({ calendar, applications: [], ...range })).toEqual([]);
    expect(buildDesired({ calendar: [], applications: [], ...range })).toEqual([]);
  });
});

describe("diffEvents", () => {
  const ev = (key: string, start: string, end: string, summary = "재택근무"): DesiredEvent => ({ key, kind: "remote", ymd: start.slice(0, 10), summary, start, end });
  const ex = (id: string, key: string | undefined, start: string, end: string, summary = "재택근무"): ExistingEvent => ({ id, key, summary, start, end });

  it("추가·수정(제목·시각)·삭제·중복·키 없는 일정을 가른다", () => {
    const desired = [
      ev("remote-20261116", "2026-11-16T09:30:00+09:00", "2026-11-16T18:30:00+09:00"),
      ev("leave-10-20261120", "2026-11-20T15:00:00+09:00", "2026-11-20T19:00:00+09:00", "연차휴가 (4시간)"),
      ev("remote-20261123", "2026-11-23T09:30:00+09:00", "2026-11-23T18:30:00+09:00"),
      ev("remote-20261207", "2026-12-07T09:30:00+09:00", "2026-12-07T18:30:00+09:00"),
    ];
    const existing = [
      // 같은 순간을 UTC 로 돌려준 경우는 변경이 아니다
      ex("a", "remote-20261116", "2026-11-16T00:30:00Z", "2026-11-16T09:30:00Z"),
      ex("a2", "remote-20261116", "2026-11-16T00:30:00Z", "2026-11-16T09:30:00Z"),
      ex("b", "leave-10-20261120", "2026-11-20T14:00:00+09:00", "2026-11-20T18:00:00+09:00", "연차휴가 (4시간)"),
      ex("c", "remote-20261207", "2026-12-07T09:30:00+09:00", "2026-12-07T18:30:00+09:00", "(결재중) 재택근무"),
      ex("d", "leave-9-20261125", "2026-11-25T09:30:00+09:00", "2026-11-25T18:30:00+09:00"),
      ex("e", undefined, "2026-11-26T09:30:00+09:00", "2026-11-26T18:30:00+09:00"),
    ];
    const plan = diffEvents(desired, existing);
    expect(plan.insert.map((e) => e.key)).toEqual(["remote-20261123"]);
    expect(plan.update.map((u) => u.id)).toEqual(["b", "c"]);
    expect(plan.remove.map((e) => e.id).sort()).toEqual(["a2", "d", "e"]);
  });

  it("JADE 일정이 비면 기존 동기화 일정은 모두 삭제, 둘 다 비면 할 일 없음", () => {
    const existing = [ex("x", "remote-20261116", "2026-11-16T09:30:00+09:00", "2026-11-16T18:30:00+09:00")];
    expect(diffEvents([], existing)).toEqual({ insert: [], update: [], remove: existing });
    expect(diffEvents([], [])).toEqual({ insert: [], update: [], remove: [] });
  });
});

describe("toGoogleEvent", () => {
  it("동기화 표식·시간대·알림 끄기, 재택만 한가함", () => {
    const remote = toGoogleEvent({ key: "remote-20261116", kind: "remote", ymd: "20261116", summary: "재택근무", start: "2026-11-16T09:30:00+09:00", end: "2026-11-16T18:30:00+09:00" });
    expect(remote.extendedProperties.private).toEqual({ jadeSync: "1", jadeKey: "remote-20261116" });
    expect(remote.start.timeZone).toBe("Asia/Seoul");
    expect(remote.transparency).toBe("transparent");
    expect(remote.reminders).toEqual({ useDefault: false });
    expect(toGoogleEvent({ key: "k", kind: "attend", ymd: "", summary: "외근", start: "", end: "" }).transparency).toBe("opaque");
  });
});

describe("시각·일정 판단", () => {
  it("scheduleCheck: 평일 9~19시 정각+3분 안에서만 실행", () => {
    expect(scheduleCheck({ ymd: "", weekday: 1, hour: 9, minute: 0 }).run).toBe(true);
    expect(scheduleCheck({ ymd: "", weekday: 5, hour: 19, minute: 3 }).run).toBe(true);
    expect(scheduleCheck({ ymd: "", weekday: 3, hour: 10, minute: 4 }).run).toBe(false);
    expect(scheduleCheck({ ymd: "", weekday: 2, hour: 8, minute: 59 }).run).toBe(false);
    expect(scheduleCheck({ ymd: "", weekday: 2, hour: 20, minute: 0 }).run).toBe(false);
    expect(scheduleCheck({ ymd: "", weekday: 0, hour: 10, minute: 0 }).run).toBe(false);
    expect(scheduleCheck({ ymd: "", weekday: 6, hour: 10, minute: 0 }).run).toBe(false);
  });

  it("isWorkday: 주말 「휴일」과 공휴일 이름은 근무일이 아니다", () => {
    expect(isWorkday("선택근무제(IT)")).toBe(true);
    expect(isWorkday("재택근무제")).toBe(true);
    expect(isWorkday("휴일")).toBe(false);
    expect(isWorkday("추석(-1)")).toBe(false);
    expect(isWorkday("제헌절")).toBe(false);
  });

  it("kstParts·monthEnd: 한국 시각 기준 날짜, 다음 달 말일(연말·윤년)", () => {
    // UTC 15:30 은 한국 시각으로 다음 날 00:30 이다
    expect(kstParts(new Date("2026-11-11T15:30:00Z"))).toEqual({ ymd: "20261112", hour: 0, minute: 30, weekday: 4 });
    expect(monthEnd("20261111")).toBe("20261130");
    expect(monthEnd("20261111", 1)).toBe("20261231");
    expect(monthEnd("20261215", 1)).toBe("20270131");
    expect(monthEnd("20280115", 1)).toBe("20280229");
  });
});
