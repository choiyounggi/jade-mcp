import type { ApplicationRow } from "../history.js";

// JADE 근태(달력 + 신청내역) → 구글 캘린더에 있어야 할 일정 → 기존 일정과의 차이. I/O 가 없다.

export interface CalendarEntry {
  ymd: string;
  workType: string;
  workTime: string;
  remarks: string[];
}

export const TIME_ZONE = "Asia/Seoul";
const OFFSET = "+09:00";

export const REMOTE_DEFAULT = { start: "09:30", end: "18:30" } as const;
// 경조휴가 신청서와 달력 표시에는 시각이 없다. 연차 신청서의 종일(09:30~18:30, 8시간)을 4시간씩 나눈 값을 쓴다.
export const FALLBACK_TIMES = { full: ["09:30", "18:30"], am: ["09:30", "13:30"], pm: ["14:30", "18:30"] } as const;
export const PENDING_PREFIX = "(결재중) ";

// 구글 캘린더 일정의 비공개 속성. 이 표식이 있는 일정만 수정·삭제한다.
export const SYNC_MARK = "jadeSync";
export const SYNC_KEY = "jadeKey";

// 매시 정각 실행만 인정한다. 잠자기에서 깨어난 뒤 launchd 가 몰아서 띄운 늦은 실행은 건너뛴다.
export const LATE_LIMIT_MINUTES = 3;
export const RUN_HOURS = { from: 9, to: 19 } as const;

const COMPLETED = "900";
const LEAVE_MODULE = "근태-휴가/휴직";
const ATTEND_TYPE = "1010"; // 근태/근무 신청서 — 출장·외근·교육 등
const REMOTE_TYPE = "1130"; // 재택 근무 신청서
const REMOTE_WORK_TYPE = "재택근무제";
const FULL_DAY_MINUTES = 8 * 60;
const MAX_PERIOD_DAYS = 62;

const TIMED_ENTRY =
  /\[(\d{4})\.(\d{2})\.(\d{2})[^(\]]*\((\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})\)\s*:\s*([\d.]+)\s*(시간|day)\s*\]/g;
const LEAVE_PERIOD = /휴가기간\s*:\s*(\d{4})\.(\d{2})\.(\d{2})[^~]*~\s*(\d{4})\.(\d{2})\.(\d{2})/;
const REMOTE_DAY = /근무일\s*:\s*(\d{4})\.(\d{2})\.(\d{2})/g;
const REMOTE_TIME = /변경근무유형\s*:[^[]*\[\s*당일\s*(\d{2}:\d{2})\s*~\s*당일\s*(\d{2}:\d{2})\s*\]/;
const REMARK_HOURS = /\((\d+(?:\.\d+)?)h\)\s*$/;

export type Kind = "remote" | "leave" | "attend";

/** 신청서 한 건에서 뽑은 하루치 일정. */
export interface Entry {
  applId: string;
  kind: Kind;
  ymd: string;
  start: string;
  end: string;
  label: string;
  summary: string;
  /** 신청서에 적힌 시간 수(일 단위는 8시간으로 환산). 모르면 undefined */
  hours: number | undefined;
  pending: boolean;
  appliedAt: string;
}

export interface DesiredEvent {
  key: string;
  kind: Kind;
  ymd: string;
  summary: string;
  /** RFC 3339, +09:00 */
  start: string;
  end: string;
  /** 쉬거나 자리를 비우는 시간 수. 모르면 시작~종료 간격으로 판단한다 */
  hours?: number;
}

export interface ExistingEvent {
  id: string;
  key: string | undefined;
  summary: string;
  start: string | undefined;
  end: string | undefined;
}

export interface SyncPlan {
  insert: DesiredEvent[];
  update: { id: string; event: DesiredEvent }[];
  remove: ExistingEvent[];
}

function addDays(ymd: string, n: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

function eachYmd(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to && days.length < MAX_PERIOD_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

function minutes(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

function fallbackTimes(text: string): readonly [string, string] {
  if (text.includes("오전")) return FALLBACK_TIMES.am;
  if (text.includes("오후")) return FALLBACK_TIMES.pm;
  return FALLBACK_TIMES.full;
}

/** 「연차휴가 [2026.10.16 금요일(17:00 ~ 19:00) : 2 시간] , [...]」 형식. 시각 항목이 없으면 undefined. */
function parseTimed(app: ApplicationRow, kind: Kind, pending: boolean): Entry[] | undefined {
  const matches = [...app.content.matchAll(TIMED_ENTRY)];
  if (matches.length === 0) return undefined;
  const bracket = app.content.indexOf("[");
  const label = (bracket > 0 ? app.content.slice(0, bracket).trim() : "") || app.applTypeName;
  const entries: Entry[] = [];
  for (const [, y, m, d, start, end, amount, unit] of matches) {
    if (!y || !m || !d || !start || !end || start >= end) continue;
    entries.push({
      applId: app.applId,
      kind,
      ymd: y + m + d,
      start,
      end,
      label,
      summary: `${label} (${amount}${unit === "day" ? "일" : "시간"})`,
      hours: unit === "day" ? Number(amount) * 8 : Number(amount),
      pending,
      appliedAt: app.appliedAt,
    });
  }
  return entries;
}

/** 경조 휴가 신청서 — 「경조금·휴가신청 / 생일반차_오후(본인) / … / 휴가기간 : A~B /」. 시각이 없어 기본 시각을 쓴다. */
function parsePeriod(app: ApplicationRow, pending: boolean): Entry[] {
  const p = app.content.match(LEAVE_PERIOD);
  if (!p) return [];
  const second = app.content.split("/").map((s) => s.trim())[1];
  const label = second && !second.includes(":") ? second : app.applTypeName;
  const [start, end] = fallbackTimes(label);
  const hours = start === FALLBACK_TIMES.full[0] && end === FALLBACK_TIMES.full[1] ? 8 : 4;
  return eachYmd(`${p[1]}${p[2]}${p[3]}`, `${p[4]}${p[5]}${p[6]}`).map((ymd) => ({
    applId: app.applId,
    kind: "leave" as const,
    ymd,
    start,
    end,
    label,
    summary: label,
    hours,
    pending,
    appliedAt: app.appliedAt,
  }));
}

/** 「근무일:2026.11.23 월요일 / 원근무유형:… / 변경근무유형:재택근무제 [당일 09:30 ~ 당일 18:30]」. */
function parseRemote(app: ApplicationRow, pending: boolean): Entry[] {
  const time = app.content.match(REMOTE_TIME);
  const start = time?.[1] ?? REMOTE_DEFAULT.start;
  const end = time?.[2] ?? REMOTE_DEFAULT.end;
  if (start >= end) return [];
  return [...app.content.matchAll(REMOTE_DAY)].map(([, y, m, d]) => ({
    applId: app.applId,
    kind: "remote" as const,
    ymd: `${y}${m}${d}`,
    start,
    end,
    label: "재택근무",
    summary: "재택근무",
    hours: undefined,
    pending,
    appliedAt: app.appliedAt,
  }));
}

/**
 * 신청내역 한 줄을 하루치 일정으로 나눈다. 휴가/휴직 모듈 전부, 근태/근무 신청서(출장·외근·교육 등), 재택 근무 신청서만 다룬다.
 * 취소 신청서와 반려는 제외한다 — 승인된 취소의 결과는 달력에서 원 일정이 사라지는 것으로 반영된다.
 */
export function parseApplication(app: ApplicationRow): Entry[] {
  if (app.applTypeName.includes("취소") || app.progress === "반려") return [];
  const pending = app.statusCode !== COMPLETED;
  if (app.applType === REMOTE_TYPE) return parseRemote(app, pending);
  if (app.module === LEAVE_MODULE) return parseTimed(app, "leave", pending) ?? parsePeriod(app, pending);
  if (app.applType === ATTEND_TYPE) return parseTimed(app, "attend", pending) ?? [];
  return [];
}

function normalize(text: string): string {
  return text.replace(REMARK_HOURS, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function labelsMatch(remark: string, label: string): boolean {
  const r = normalize(remark);
  const l = normalize(label);
  return r.length > 0 && l.length > 0 && (r.includes(l) || l.includes(r));
}

function remarkHours(remark: string): number | undefined {
  const h = remark.match(REMARK_HOURS)?.[1];
  return h === undefined ? undefined : Number(h);
}

/** 둘 다 시간 수를 알면 같아야 한다 — 같은 날 2시간·4시간 휴가가 섞였을 때 엉뚱한 표시와 짝짓지 않게. */
function hoursMatch(remark: string, e: Entry): boolean {
  const h = remarkHours(remark);
  return h === undefined || e.hours === undefined || h === e.hours;
}

function toEvent(key: string, kind: Kind, ymd: string, start: string, end: string, summary: string, hours?: number): DesiredEvent {
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const event: DesiredEvent = { key, kind, ymd, summary, start: `${date}T${start}:00${OFFSET}`, end: `${date}T${end}:00${OFFSET}` };
  if (hours !== undefined) event.hours = hours;
  return event;
}

function fromEntry(e: Entry): DesiredEvent {
  const key = e.kind === "remote" ? `remote-${e.ymd}` : `${e.kind}-${e.applId}-${e.ymd}`;
  return toEvent(key, e.kind, e.ymd, e.start, e.end, e.pending ? PENDING_PREFIX + e.summary : e.summary, e.hours);
}

function isFullDay(e: DesiredEvent): boolean {
  if (e.hours !== undefined) return e.hours >= 8;
  return minutes(e.end.slice(11, 16)) - minutes(e.start.slice(11, 16)) >= FULL_DAY_MINUTES;
}

function remarkKind(remark: string): Kind {
  return /휴가|연차|반차/.test(remark) ? "leave" : "attend";
}

export interface DesiredInput {
  calendar: CalendarEntry[];
  applications: ApplicationRow[];
  fromYmd: string;
  toYmd: string;
}

/**
 * fromYmd~toYmd(양끝 포함)에 구글 캘린더에 있어야 할 일정.
 * - 승인된 일정은 JADE 달력 기준이다. 승인 뒤 취소된 신청서는 최종완료로 남고 달력 표시만 사라지기 때문이다.
 * - 결재 중인 신청은 달력에 안 보이므로 신청서로 만들고 제목에 (결재중) 을 붙인다.
 * - 재택 날에 8시간 이상 휴가·출장 등이 있으면 재택 일정은 뺀다.
 */
export function buildDesired({ calendar, applications, fromYmd, toYmd }: DesiredInput): DesiredEvent[] {
  const inRange = (ymd: string) => ymd >= fromYmd && ymd <= toYmd;
  const days = new Map(calendar.map((d) => [d.ymd, d]));
  const entries = applications.flatMap(parseApplication).filter((e) => inRange(e.ymd));
  const events: DesiredEvent[] = [];
  const keys = new Set<string>();
  const push = (event: DesiredEvent) => {
    if (keys.has(event.key)) return;
    keys.add(event.key);
    events.push(event);
  };

  const approvedRemote = new Map(entries.filter((e) => e.kind === "remote" && !e.pending).map((e) => [e.ymd, e]));
  for (const day of calendar) {
    if (!inRange(day.ymd) || day.workType !== REMOTE_WORK_TYPE) continue;
    const e = approvedRemote.get(day.ymd);
    push(toEvent(`remote-${day.ymd}`, "remote", day.ymd, e?.start ?? REMOTE_DEFAULT.start, e?.end ?? REMOTE_DEFAULT.end, "재택근무"));
  }

  // 같은 날 같은 종류·시간의 신청서가 둘인데 달력 표시가 하나면 어느 쪽이 취소됐는지 달력만으로는 모른다.
  // 취소 뒤 다시 신청하는 경우가 흔하므로 나중에 신청한 것을 먼저 짝짓는다.
  const approvedByDay = new Map<string, Entry[]>();
  for (const e of [...entries].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))) {
    if (e.kind === "remote" || e.pending) continue;
    approvedByDay.set(e.ymd, [...(approvedByDay.get(e.ymd) ?? []), e]);
  }
  const remarkDays = calendar.filter((d) => inRange(d.ymd) && d.remarks.length > 0).map((d) => d.ymd);
  for (const ymd of new Set([...approvedByDay.keys(), ...remarkDays])) {
    const remarks = days.get(ymd)?.remarks ?? [];
    const dayEntries = approvedByDay.get(ymd) ?? [];
    const consumed = new Set<number>();
    const unmatched: Entry[] = [];
    for (const e of dayEntries) {
      const i = remarks.findIndex((r, idx) => !consumed.has(idx) && labelsMatch(r, e.label) && hoursMatch(r, e));
      if (i >= 0) {
        consumed.add(i);
        push(fromEntry(e));
      } else unmatched.push(e);
    }
    // 신청서 이름과 달력 표시가 다르게 적히는 종류(예: 경조 휴가)는 종류·시간이 맞는 남은 표시와 짝지어 살린다.
    // 맞는 표시가 없으면 취소된 것이다.
    for (const e of unmatched) {
      const i = remarks.findIndex((r, idx) => !consumed.has(idx) && remarkKind(r) === e.kind && hoursMatch(r, e));
      if (i < 0) continue;
      consumed.add(i);
      push(fromEntry(e));
    }
    // 달력에는 있는데 조회 기간 안에 신청서가 없는 일정은 달력 표시로 만든다.
    remarks.forEach((remark, i) => {
      if (consumed.has(i)) return;
      const [start, end] = fallbackTimes(remark);
      push(toEvent(`remark-${ymd}-${i}`, remarkKind(remark), ymd, start, end, remark, remarkHours(remark)));
    });
  }

  for (const e of entries) {
    if (!e.pending) continue;
    if (e.kind === "remote" && days.get(e.ymd)?.workType === REMOTE_WORK_TYPE) continue;
    push(fromEntry(e));
  }

  const fullDayOff = new Set(events.filter((e) => e.kind !== "remote" && isFullDay(e)).map((e) => e.ymd));
  return events
    .filter((e) => !(e.kind === "remote" && fullDayOff.has(e.ymd)))
    .sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

function sameInstant(a: string | undefined, b: string): boolean {
  return a !== undefined && Date.parse(a) === Date.parse(b);
}

/** existing 은 동기화 표식이 있는 일정만 넘겨야 한다 — desired 에 없는 키는 모두 삭제 대상이 된다. */
export function diffEvents(desired: DesiredEvent[], existing: ExistingEvent[]): SyncPlan {
  const byKey = new Map<string, ExistingEvent>();
  const remove: ExistingEvent[] = [];
  for (const e of existing) {
    if (!e.key || byKey.has(e.key)) remove.push(e);
    else byKey.set(e.key, e);
  }
  const insert: DesiredEvent[] = [];
  const update: SyncPlan["update"] = [];
  for (const d of desired) {
    const e = byKey.get(d.key);
    if (!e) {
      insert.push(d);
      continue;
    }
    byKey.delete(d.key);
    if (e.summary !== d.summary || !sameInstant(e.start, d.start) || !sameInstant(e.end, d.end)) update.push({ id: e.id, event: d });
  }
  remove.push(...byKey.values());
  return { insert, update, remove };
}

export function toGoogleEvent(event: DesiredEvent) {
  return {
    summary: event.summary,
    description: "JADE 근태에서 자동 동기화된 일정입니다. 직접 고치면 다음 동기화에서 JADE 기준으로 되돌아갑니다.",
    start: { dateTime: event.start, timeZone: TIME_ZONE },
    end: { dateTime: event.end, timeZone: TIME_ZONE },
    // 재택은 근무 중이라 다른 사람의 일정 잡기를 막지 않는다.
    transparency: event.kind === "remote" ? "transparent" : "opaque",
    reminders: { useDefault: false },
    extendedProperties: { private: { [SYNC_MARK]: "1", [SYNC_KEY]: event.key } },
  };
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface KstParts {
  ymd: string;
  hour: number;
  minute: number;
  weekday: number;
}

export function kstParts(date: Date): KstParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? ""] ?? -1,
  };
}

/** ymd 가 속한 달에서 offset 달 뒤의 말일. */
export function monthEnd(ymd: string, offset = 0): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) + offset, 0));
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

export function nextDay(ymd: string): string {
  return addDays(ymd, 1);
}

/** 평일 9~19시 정각(+LATE_LIMIT_MINUTES분)에만 돈다. 공휴일은 isWorkday 로 따로 거른다. */
export function scheduleCheck({ weekday, hour, minute }: KstParts): { run: true } | { run: false; reason: string } {
  if (weekday < 1 || weekday > 5) return { run: false, reason: "주말" };
  if (hour < RUN_HOURS.from || hour > RUN_HOURS.to) return { run: false, reason: `운영 시간 밖(${hour}시)` };
  if (minute > LATE_LIMIT_MINUTES) return { run: false, reason: `정각 실행이 아님(${hour}:${String(minute).padStart(2, "0")})` };
  return { run: true };
}

/** 달력 근무유형이 근무일인지. 주말은 「휴일」, 공휴일은 「추석」「제헌절」처럼 이름으로 나온다. */
export function isWorkday(workType: string): boolean {
  return workType.includes("근무");
}
