import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { LoginError, type JadeClient } from "./client.js";
import { keychainItemState, loadConfig, readConfigIfAny, readKeychainPassword } from "./config.js";
import { z } from "zod";
import { fetchMainInfo, toRecentApplications, toTodayStatus, toVacationBalance } from "./features.js";
import { PendingStore } from "./pending.js";
import { saveAccount } from "./account.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { startOnboarding } from "./onboarding.js";
import { createRuntime, NeedsOnboardingError } from "./runtime.js";
import { canRetryPassword } from "./setup.js";
import { commitPunch, preparePunch, type PunchPlan } from "./punch.js";
import { commitCondolence, prepareCondolence, type CondolencePlan } from "./condolence.js";
import { commitSchedule, fetchCalendar, prepareSchedule, type SchedulePlan } from "./schedule.js";
import { commitVacation, prepareVacation, type VacationPlan } from "./vacation.js";
import { commitRemoteWork, localYmd, prepareMonthlyRemoteWork, prepareRemoteWork, remoteWorkReason, WEEKDAYS, type RemoteWorkPlan } from "./remote.js";
import { commitRemoval, fetchApplications, prepareRemoval, type RemovalPlan } from "./history.js";
import { commitClockRequest, DEFAULT_CLOCK_REASON, prepareClockRequests, type ClockRequestApproval } from "./clock-request.js";
import { commitOvertime, prepareOvertime, type OvertimePlan } from "./overtime.js";
import { commitOvertimeCancel, prepareOvertimeCancel, type OvertimeCancelPlan } from "./overtime-cancel.js";
import {
  commitAttendanceCancel,
  listAttendanceCancelCandidates,
  prepareAttendanceCancel,
  type AttendanceCancelPlan,
} from "./attend-cancel.js";
import { commitRemoteWorkRevert, prepareRemoteWorkRevert, type RemoteRevertPlan } from "./remote-change.js";
import { refreshLauncher, triggerGcalSync } from "./gcal/env.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const runtime = createRuntime({
  loadConfig: () => loadConfig(),
  readPassword: (config) => readKeychainPassword(config.keychainService, config.userId),
  passwordState: (config) => keychainItemState(config.keychainService, config.userId),
  runDoctor: () => runDoctor(),
  startOnboarding: () =>
    startOnboarding({ runDoctor: () => runDoctor(), saveAccount: (input) => saveAccount(input), prefill: () => readConfigIfAny(), onSaved: () => {
        runtime.reset();
        // 이전 계정으로 만든 미리보기 토큰이 새 계정 세션으로 commit 되지 않게 한다.
        for (const store of [punches, vacations, remoteWorks, condolences, schedules, removals, clockRequests, overtimes, overtimeCancels, attendanceCancels, remoteReverts]) store.clear();
      } }),
});
// 계정이 없어도 서버는 떠 있어야 온보딩을 안내할 수 있다 — 클라이언트는 도구가 처음 불릴 때 safely 가 채운다.
// 도구 핸들러는 모두 safely 콜백 안에서 이 바인딩을 읽는다.
let client!: JadeClient;

const server = new McpServer({ name: "jade", version });

// 정각 동기화 스크립트의 고정 버전을 이 서버 버전으로 맞춘다. 실패해도 서버 기동을 막지 않는다.
void refreshLauncher().catch(() => {});

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function safely<T>(fn: () => Promise<T>) {
  try {
    client = await runtime.getClient();
    return text(await fn());
  } catch (e) {
    if (e instanceof NeedsOnboardingError) return failure(await runtime.onboardingMessage(e.message));
    if (e instanceof LoginError && canRetryPassword(e)) {
      return failure(`${e.message}\n비밀번호가 바뀌었으면 jade_onboarding 으로 설정 페이지를 열어 다시 저장한다.`);
    }
    // fetch 는 원인을 cause 에만 담는다 (예: 인증서 검증 실패) — 메시지만으로는 진단할 수 없다.
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    const message = cause ? `${(e as Error).message} (${cause})` : (e as Error).message;
    return failure(message);
  }
}

/**
 * 구글 캘린더에 보이는 근태(휴가·재택·출장 등)를 바꾸는 상신·삭제·취소. 끝나면 캘린더 동기화를 별도 프로세스로 띄운다.
 * 실패해도 띄운다 — 일부 건만 전송된 채 실패할 수 있고, 동기화는 JADE 현재 상태로 맞출 뿐이라 남는 부작용이 없다.
 */
function changesCalendar<T>(fn: () => Promise<T>) {
  return safely(async () => {
    try {
      return await fn();
    } finally {
      // 여기서 예외가 나면 성공한 상신이 실패 응답으로 덮여 다시 상신될 수 있다.
      try {
        triggerGcalSync();
      } catch {
        // 다음 정각 동기화가 반영한다
      }
    }
  });
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "jade_doctor",
  {
    title: "설치 상태 점검",
    description:
      "jade-mcp 가 동작할 환경인지 점검한다 — macOS, 보안 패치된 Node, 회사망 인증서(시스템 CA) 사용, Keychain 도구, JADE 접속, 계정 설정. " +
      "JADE 에 로그인하지 않는다. 도구가 접속·인증서 오류로 실패하거나 사용자가 설치 문제를 물을 때 부른다.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => {
    const report = await runDoctor();
    return { content: [{ type: "text" as const, text: `${formatDoctor(report)}\n\n${JSON.stringify(report, null, 2)}` }] };
  },
);

server.registerTool(
  "jade_onboarding",
  {
    title: "계정 설정 페이지 열기",
    description:
      "JADE 계정(회사코드·아이디·비밀번호)을 입력·변경하는 로컬 설정 페이지를 브라우저로 열고 주소를 돌려준다. 계정이 없으면 다른 jade 도구도 이 페이지를 연다. " +
      "비밀번호가 바뀌었거나 다른 계정으로 바꿀 때 쓴다. 비밀번호는 절대 대화로 받지 말고 이 페이지에만 입력하게 안내한다. 입력값은 로그인으로 확인한 뒤 Keychain 에 저장된다.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => ({ content: [{ type: "text" as const, text: await runtime.onboardingMessage("사용자가 계정 입력·변경을 요청") }] }),
);

server.registerTool(
  "jade_today",
  {
    title: "오늘 출퇴근 현황",
    description: "JADE 에서 오늘 근무일·출근/퇴근 시각·근무시간과 출퇴근 입력 가능 여부를 조회한다.",
    annotations: readOnly,
  },
  () => safely(async () => toTodayStatus(await fetchMainInfo(client))),
);

server.registerTool(
  "jade_vacation_balance",
  {
    title: "내 연차 정보",
    description: "JADE 에서 내 연차 발생·사용·잔여량과 그 단위를 조회한다.",
    annotations: readOnly,
  },
  () => safely(async () => toVacationBalance(await fetchMainInfo(client))),
);

server.registerTool(
  "jade_recent_applications",
  {
    title: "최근 신청 내역",
    description: "JADE 메인 화면에 보이는 최근 신청서(휴가·근태 등)의 일자·유형·결재 상태를 조회한다.",
    annotations: readOnly,
  },
  () => safely(async () => toRecentApplications(await fetchMainInfo(client))),
);

server.registerTool(
  "jade_calendar",
  {
    title: "월 근태 달력",
    description:
      "JADE 「근태현황」 달력에서 한 달의 날짜별 근무유형·실제 근무시각과 날짜 칸 표시(연차휴가 등)를 조회한다. 저장하지 않는다.",
    inputSchema: { month: z.string().regex(/^\d{6}$/).describe("조회 월 YYYYMM") },
    annotations: readOnly,
  },
  ({ month }) => safely(async () => fetchCalendar(client, month)),
);

const punches = new PendingStore<PunchPlan>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_punch",
  {
    title: "출근/퇴근 기록 준비",
    description:
      "JADE 출근(in) 또는 퇴근(out) 기록을 저장 직전까지 검증하고 미리보기와 일회용 토큰을 돌려준다. " +
      "저장하지 않는다. 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_punch 로 저장한다.",
    inputSchema: { kind: z.enum(["in", "out"]).describe("in=출근, out=퇴근") },
    annotations: readOnly,
  },
  ({ kind }) =>
    safely(async () => {
      const plan = await preparePunch(client, kind);
      const { token, expiresAt } = punches.put(plan);
      return {
        action: kind === "in" ? "출근 기록" : "퇴근 기록",
        workDate: plan.workDate,
        currentlyRecorded: { clockIn: plan.recordedIn, clockOut: plan.recordedOut },
        willRecordAt: `${plan.serverDate} ${plan.serverTime} (저장 시점의 서버 시각으로 기록된다)`,
        notices: plan.notices,
        token,
        expiresAt: expiresAt.toISOString(),
      };
    }),
);

server.registerTool(
  "jade_commit_punch",
  {
    title: "출근/퇴근 기록 저장",
    description:
      "jade_prepare_punch 가 준 토큰으로 출근/퇴근을 실제 JADE 근태에 기록한다. 되돌릴 수 없는 기록이므로 " +
      "사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_punch 가 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => safely(async () => commitPunch(client, punches.take(token))),
);

const vacations = new PendingStore<VacationPlan>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_vacation",
  {
    title: "휴가 신청 준비",
    description:
      "JADE 휴가 신청서(시간 단위, 하루 안의 시각 범위)를 상신 직전까지 채우고 서버 검증을 통과시킨 뒤 미리보기와 " +
      "일회용 토큰을 돌려준다. 상신하지 않는다. 반차는 그날 실제 근무 시각 기준으로 쉬는 구간을 넣는다 " +
      "(예: 10시 출근 오후 반차 → 15:00~19:00). 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_vacation 으로 상신한다.",
    inputSchema: {
      attendClass: z.string().regex(/^\d{4}$/).default("4010").describe("휴가 종류 코드. 4010=연차휴가"),
      date: z.string().regex(/^\d{8}$/).describe("휴가일 YYYYMMDD"),
      startHm: z.string().regex(/^\d{4}$/).describe("시작 시각 HHMM"),
      endHm: z.string().regex(/^\d{4}$/).describe("종료 시각 HHMM"),
      reason: z.string().min(1).describe("신청 사유"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareVacation(client, req);
      const { token, expiresAt } = vacations.put(plan);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_vacation",
  {
    title: "휴가 신청 상신",
    description:
      "jade_prepare_vacation 이 준 토큰으로 휴가 신청서를 결재선에 상신한다. 결재자에게 바로 전달되므로 " +
      "사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_vacation 이 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => changesCalendar(async () => commitVacation(client, vacations.take(token))),
);

// 여러 날을 한 번에 준비하므로 미리보기를 읽고 승인할 시간을 다른 쓰기 도구보다 넉넉히 둔다.
const remoteWorks = new PendingStore<RemoteWorkPlan["preview"]>(15 * 60 * 1000);

server.registerTool(
  "jade_prepare_remote_work",
  {
    title: "재택근무 신청 준비 (월·요일)",
    description:
      "한 달의 지정 요일마다 JADE 재택 근무 신청서를 한 장씩 상신 직전까지 채우고 마감 검사를 통과시킨 뒤, 날짜별 미리보기와 " +
      "일회용 토큰을 돌려준다. 상신하지 않는다. 그 달의 주는 첫 평일이 든 주부터 평일이 다음 달로 넘어가지 않는 주까지이며, " +
      "주중(월~금)에 공휴일이 있거나 휴가 표시가 있는 주, 이미 재택이거나 지난 날짜는 빼고 그 사유를 skipped 로 알려 준다. " +
      "1일이 목·금이면 첫 주의 요일이 전달 날짜일 수 있다. 결재 대기 중인 신청은 달력에 안 보일 수 있으니 같은 날을 두 번 상신하지 않게 주의한다. " +
      "사유는 「M월 D일 재택근무 신청드립니다.」. 사용자가 미리보기를 확인하고 승인한 뒤에만 날짜마다 jade_commit_remote_work 로 상신한다.",
    inputSchema: {
      month: z.string().regex(/^\d{6}$/).describe("신청 월 YYYYMM"),
      weekday: z.enum(WEEKDAYS).describe("재택 요일 mon|tue|wed|thu|fri"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const batch = await prepareMonthlyRemoteWork(client, req, localYmd());
      return {
        month: batch.month,
        weekday: batch.weekday,
        applications: batch.plans.map((p) => {
          const { token, expiresAt } = remoteWorks.put(p.preview);
          return { ...p.preview, token, expiresAt: expiresAt.toISOString() };
        }),
        skipped: batch.skipped,
      };
    }),
);

server.registerTool(
  "jade_commit_remote_work",
  {
    title: "재택근무 신청 상신 (한 건)",
    description:
      "jade_prepare_remote_work 또는 jade_prepare_remote_work_day 가 날짜별로 준 토큰 하나로 그날의 재택 근무 신청서 한 장을 결재선에 상신한다. 상신 직전에 화면을 새로 열어 " +
      "검사를 다시 통과하고 미리보기와 같을 때만 보낸다. 결재자에게 바로 전달되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_remote_work·jade_prepare_remote_work_day 가 그 날짜에 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => changesCalendar(async () => commitRemoteWork(client, remoteWorks.take(token))),
);

const condolences = new PendingStore<CondolencePlan>(5 * 60 * 1000);

const ymd = z.string().regex(/^\d{8}$/);

server.registerTool(
  "jade_prepare_condolence",
  {
    title: "생일반차 신청 준비",
    description:
      "JADE 경조 휴가 신청서로 생일반차를 상신 직전까지 채우고 서버 검증을 통과시킨 뒤 미리보기와 일회용 토큰을 돌려준다. " +
      "상신하지 않는다. 결혼·출산·조사 등 다른 경조 유형은 쓰지 않는다. " +
      "사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_condolence 로 상신한다.",
    inputSchema: {
      conType: z.enum(["3010", "3020"]).describe("3010=생일반차 오후, 3020=생일반차 오전"),
      date: ymd.describe("반차 쓰는 날 YYYYMMDD"),
      reason: z.string().min(1).default("생일 반차").describe("신청 사유"),
    },
    annotations: readOnly,
  },
  ({ conType, date, reason }) =>
    safely(async () => {
      const plan = await prepareCondolence(client, { conType, conDate: date, leaveStart: date, leaveEnd: date, reason });
      const { token, expiresAt } = condolences.put(plan);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_condolence",
  {
    title: "생일반차 신청 상신",
    description:
      "jade_prepare_condolence 가 준 토큰으로 생일반차(경조 휴가 신청서)를 결재선에 상신한다. 결재자에게 바로 전달되므로 " +
      "사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_condolence 가 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => changesCalendar(async () => commitCondolence(client, condolences.take(token))),
);

const schedules = new PendingStore<SchedulePlan>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_schedule",
  {
    title: "근무일정 등록 준비",
    description:
      "「내정보 > 근태현황 > 일정등록」에서 한 달의 근무 가능일자를 모두(또는 dates 로 고른 날만) 같은 계획 시각으로 " +
      "바꿀 준비를 하고 미리보기와 일회용 토큰을 돌려준다. 저장하지 않는다. 결재 없이 바로 반영되는 변경이므로 " +
      "사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_schedule 로 저장한다.",
    inputSchema: {
      month: z.string().regex(/^\d{6}$/).describe("대상 월 YYYYMM"),
      startHm: z.string().regex(/^\d{4}$/).describe("계획 시작 시각 HHMM"),
      endHm: z.string().regex(/^\d{4}$/).describe("계획 종료 시각 HHMM"),
      dates: z.array(z.string().regex(/^\d{8}$/)).optional().describe("일부 날만 바꿀 때 YYYYMMDD 목록. 없으면 근무 가능일자 전체"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareSchedule(client, req);
      const { token, expiresAt } = schedules.put(plan);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_schedule",
  {
    title: "근무일정 등록 저장",
    description:
      "jade_prepare_schedule 이 준 토큰으로 근무일정을 저장하고, 달력을 다시 읽어 시각이 바뀌고 근무유형은 그대로인지 " +
      "확인한 결과를 돌려준다. 결재 없이 바로 반영되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_schedule 이 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ token }) => safely(async () => commitSchedule(client, schedules.take(token))),
);

server.registerTool(
  "jade_applications",
  {
    title: "신청내역 조회",
    description:
      "JADE 「신청 > 신청내역」 탭의 목록(신청일시·신청서 유형·진행상태·APPL_ID·신청내용·대상자)을 조회한다. 저장하지 않는다. " +
      "기간을 비우면 화면처럼 6개월 전부터 오늘까지다. 상태는 approving=결재중(200), rejected=반려(300), completed=최종완료(900) 이고 비우면 전체다. " +
      "progress 는 목록 아이콘 기준(진행중·반려·완료)이다. 삭제·회수할 신청서 번호를 고를 때도 이 도구로 찾는다.",
    inputSchema: {
      fromYmd: z.string().regex(/^\d{8}$/).optional().describe("신청일 시작 YYYYMMDD (기본: 6개월 전)"),
      toYmd: z.string().regex(/^\d{8}$/).optional().describe("신청일 종료 YYYYMMDD (기본: 오늘)"),
      statuses: z.array(z.enum(["approving", "rejected", "completed"])).optional().describe("진행상태 필터. 비우면 전체"),
      keyword: z.string().max(100).optional().describe("신청내용 검색어"),
      applType: z.string().regex(/^\d+$/).optional().describe("신청서 유형 코드 (예: 1130=재택 근무 신청서). 비우면 전체"),
      page: z.number().int().min(1).default(1).describe("페이지 번호"),
      pageSize: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50)]).default(20).describe("페이지당 건수"),
    },
    annotations: readOnly,
  },
  (q) => safely(() => fetchApplications(client, q)),
);

const removals = new PendingStore<RemovalPlan>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_delete_applications",
  {
    title: "신청서 삭제·회수 준비",
    description:
      "신청서(APPL_ID) 여러 장의 삭제(delete) 또는 회수(retract)를 준비한다. 신청내역에서 다시 찾고, 신청서 화면을 열어 JADE 화면의 " +
      "버튼 규칙(임시저장이거나 아직 결재 전인 신청서만 삭제, 회수는 회사가 회수 기능을 쓸 때 결재 전 신청서만)과 결재 진행 검사를 통과한 것만 " +
      "대상으로 잡아 미리보기와 일회용 토큰을 돌려준다. 지우지 않는다. 막힌 신청서는 blocked 에 사유와 함께 알려 준다. " +
      "삭제는 신청서를 지우고 되돌릴 수 없다. 회수는 결재 요청만 거둬들이고 신청서는 남는다. " +
      "사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_delete_applications 로 실행한다.",
    inputSchema: {
      applIds: z.array(z.string().regex(/^\d+$/)).min(1).max(20).describe("대상 신청서 번호(APPL_ID) 목록 — jade_applications 결과의 applId"),
      action: z.enum(["delete", "retract"]).describe("delete=삭제(되돌릴 수 없음), retract=회수. 사용자가 말한 쪽을 고른다"),
      fromYmd: z.string().regex(/^\d{8}$/).optional().describe("대상을 찾을 신청일 시작 YYYYMMDD (기본: 6개월 전)"),
      toYmd: z.string().regex(/^\d{8}$/).optional().describe("대상을 찾을 신청일 종료 YYYYMMDD (기본: 오늘)"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareRemoval(client, req);
      const { token, expiresAt } = removals.put(plan);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_delete_applications",
  {
    title: "신청서 삭제·회수 실행",
    description:
      "jade_prepare_delete_applications 가 준 토큰으로 신청서를 한 장씩 삭제(또는 회수)한다. 장마다 신청서 화면을 새로 열어 검사를 다시 통과하고 " +
      "상태가 미리보기와 같을 때만 보내며, 장별 결과(삭제됨·회수됨·건너뜀·실패·확인 필요)를 돌려준다. 삭제는 되돌릴 수 없으므로 " +
      "사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_delete_applications 가 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => changesCalendar(async () => commitRemoval(client, removals.take(token))),
);

// 여러 날을 한 번에 준비하므로 미리보기를 읽고 승인할 시간을 다른 쓰기 도구보다 넉넉히 둔다.
const clockRequests = new PendingStore<ClockRequestApproval>(15 * 60 * 1000);

server.registerTool(
  "jade_prepare_clock_request",
  {
    title: "출퇴근시각 등록 요청 준비",
    description:
      "출퇴근을 못 찍은 지난 근무일(오늘 포함)의 출근·퇴근 시각을 JADE 출퇴근시각 등록 요청서로 상신 직전까지 채우고, " +
      "화면의 서버 검증(신청 검증·근무계획 대비 검증)을 통과시킨 뒤 날짜별 미리보기와 일회용 토큰을 돌려준다. 상신하지 않는다. " +
      "신청서는 하루에 한 장이라 날짜마다 따로 준비하고, 막힌 날은 사유와 함께 skipped 로 알려 준다. " +
      "kind 로 출근만(in)·퇴근만(out)·둘 다(both)를 고르고, 고른 쪽의 시각은 사용자에게 받은 값만 넣는다(기본값 없음). 출퇴근 처리 단위로 시각이 바뀌면 adjusted 에 적는다. " +
      "사용자가 미리보기를 확인하고 승인한 뒤에만 날짜마다 jade_commit_clock_request 로 상신한다.",
    inputSchema: {
      dates: z.array(z.string().regex(/^\d{8}$/)).min(1).max(31).describe("근무일 YYYYMMDD 목록 (오늘 이전·오늘만)"),
      kind: z.enum(["both", "in", "out"]).describe("both=출퇴근기록, in=출근기록만, out=퇴근기록만. 사용자가 말한 쪽만 고른다"),
      inHm: z.string().regex(/^\d{4}$/).optional().describe("출근 시각 HHMM (kind=in·both 이면 필수)"),
      outHm: z.string().regex(/^\d{4}$/).optional().describe("퇴근 시각 HHMM (kind=out·both 이면 필수)"),
      outNextDay: z.boolean().default(false).describe("퇴근이 다음 날 새벽이면 true"),
      reason: z.string().min(1).default(DEFAULT_CLOCK_REASON).describe("신청 사유"),
    },
    annotations: readOnly,
  },
  ({ dates, kind, inHm, outHm, outNextDay, reason }) =>
    safely(async () => {
      // 기본 시각을 채우면 이미 찍힌 기록(예: 지각 출근)이 사용자가 말하지 않은 값으로 바뀌는 신청이 나간다.
      if (kind !== "out" && !inHm) throw new Error("출근 시각(inHm)을 받아야 한다 — 사용자에게 시각을 확인한다");
      if (kind !== "in" && !outHm) throw new Error("퇴근 시각(outHm)을 받아야 한다 — 사용자에게 시각을 확인한다");
      const batch = await prepareClockRequests(
        client,
        { kind, inHm: kind === "out" ? undefined : inHm, outHm: kind === "in" ? undefined : outHm, outNextDay, reason },
        dates,
      );
      return {
        applications: batch.plans.map((p) => {
          const { token, expiresAt } = clockRequests.put({ request: p.request, preview: p.preview });
          return { ...p.preview, token, expiresAt: expiresAt.toISOString() };
        }),
        skipped: batch.skipped,
      };
    }),
);

server.registerTool(
  "jade_commit_clock_request",
  {
    title: "출퇴근시각 등록 요청 상신 (한 건)",
    description:
      "jade_prepare_clock_request 가 날짜별로 준 토큰 하나로 그날의 출퇴근시각 등록 요청서 한 장을 결재선에 상신한다. 상신 직전에 화면을 새로 열어 " +
      "검증을 다시 통과하고 미리보기와 같을 때만 보낸다. 결재자에게 바로 전달되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_clock_request 가 그 날짜에 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => safely(async () => commitClockRequest(client, clockRequests.take(token))),
);

const overtimes = new PendingStore<OvertimePlan>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_overtime",
  {
    title: "연장근무 신청 준비",
    description:
      "JADE 연장 근무 신청서를 상신 직전까지 채우고 서버 검증을 통과시킨 뒤 미리보기와 일회용 토큰을 돌려준다. 상신하지 않는다. " +
      "종료 시각이 시작 시각보다 이르면 익일 시각으로 본다(예: 0930 ~ 0200 → 익일 02:00). 시작·종료 시각은 사용자에게 받은 값만 넣는다(기본값 없음). " +
      "휴일 근무면 대체/보상 유형(rewardType)이 필요하다(100=연장근무시간 누적, 300=휴일대체일 미지정). 대체휴일 지정(200)은 JADE 화면에서 해야 한다. " +
      "연장근무는 근무 종료 전에 최종 결재가 끝나야 인정된다. 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_overtime 으로 상신한다.",
    inputSchema: {
      date: z.string().regex(/^\d{8}$/).describe("근무일 YYYYMMDD"),
      startHm: z.string().regex(/^\d{4}$/).describe("시작 시각 HHMM (근무일 당일)"),
      endHm: z.string().regex(/^\d{4}$/).describe("종료 시각 HHMM. 시작보다 이르면 익일"),
      reason: z.string().min(1).describe("신청 사유"),
      rewardType: z.enum(["100", "300"]).optional().describe("휴일 근무일 때만: 100=연장근무시간(OT) 누적, 300=휴일대체일 미지정"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareOvertime(client, req);
      const { token, expiresAt } = overtimes.put(plan);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_overtime",
  {
    title: "연장근무 신청 상신",
    description:
      "jade_prepare_overtime 이 준 토큰으로 연장 근무 신청서를 결재선에 상신한다. 상신 직전에 서버 검증을 한 번 더 통과해야 보낸다. " +
      "결재자에게 바로 전달되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_overtime 이 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => safely(async () => commitOvertime(client, overtimes.take(token))),
);

const overtimeCancels = new PendingStore<OvertimeCancelPlan>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_overtime_cancel",
  {
    title: "연장근무 취소 신청 준비",
    description:
      "JADE 연장 근무 취소 신청서를 상신 직전까지 채우고 미리보기와 일회용 토큰을 돌려준다. 상신하지 않는다. " +
      "화면의 「취소할 사전근무 선택」 목록을 근무일이 든 달로 조회해 그날의 신청 한 건을 고른다. JADE 가 취소를 막은 신청(취소신청 가능=N)은 고르지 않고, " +
      "같은 날 취소할 수 있는 신청이 여러 건이면 startHm 으로 고르게 한다. 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_overtime_cancel 로 상신한다.",
    inputSchema: {
      date: z.string().regex(/^\d{8}$/).describe("취소할 연장근무의 근무일 YYYYMMDD"),
      startHm: z.string().regex(/^\d{4}$/).optional().describe("같은 날 여러 건일 때 고를 근무 시작 시각 HHMM"),
      reason: z.string().min(1).describe("취소 사유"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareOvertimeCancel(client, req);
      const { token, expiresAt } = overtimeCancels.put(plan);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_overtime_cancel",
  {
    title: "연장근무 취소 신청 상신",
    description:
      "jade_prepare_overtime_cancel 이 준 토큰으로 연장 근무 취소 신청서를 결재선에 상신한다. 상신 직전에 대상 목록을 다시 조회해 " +
      "그 신청이 아직 취소 가능할 때만 보낸다. 결재자에게 바로 전달되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_overtime_cancel 이 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => safely(async () => commitOvertimeCancel(client, overtimeCancels.take(token))),
);

server.registerTool(
  "jade_attendance_cancel_candidates",
  {
    title: "근태/근무 취소 대상 조회",
    description:
      "JADE 근태/근무 취소 신청서의 「취소할 근태/휴가 선택」 팝업이 보여 주는 원신청 목록(출장·근태 등)을 조회한다. 저장하지 않는다. " +
      "selectable=false 인 행은 취소 신청을 올릴 수 없고 blockedReason 에 이유가 있다. 재택근무 취소는 이 목록에 나오지 않으므로 jade_prepare_remote_work_revert 를 쓴다.",
    inputSchema: {
      from: z.string().regex(/^\d{8}$/).optional().describe("조회 시작일 YYYYMMDD. 없으면 이번 달 1일"),
      to: z.string().regex(/^\d{8}$/).optional().describe("조회 종료일 YYYYMMDD. 없으면 이번 달 말일"),
    },
    annotations: readOnly,
  },
  (req) => safely(async () => listAttendanceCancelCandidates(client, req)),
);

const attendanceCancels = new PendingStore<AttendanceCancelPlan["preview"]>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_attendance_cancel",
  {
    title: "근태/근무 취소 신청 준비",
    description:
      "jade_attendance_cancel_candidates 로 고른 원신청(applId)의 근태/근무 취소 신청서를 상신 직전까지 채우고, 그 원신청이 팝업에서 고를 수 있는 행인지 확인한 뒤 " +
      "미리보기와 일회용 토큰을 돌려준다. 상신하지 않는다. 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_attendance_cancel 로 상신한다.",
    inputSchema: {
      applId: z.string().regex(/^\d+$/).describe("취소할 원신청 번호 (목록의 applId)"),
      reason: z.string().min(1).describe("취소 사유"),
      from: z.string().regex(/^\d{8}$/).optional().describe("원신청을 찾을 조회 시작일 YYYYMMDD. 목록 조회 때와 같게"),
      to: z.string().regex(/^\d{8}$/).optional().describe("원신청을 찾을 조회 종료일 YYYYMMDD. 목록 조회 때와 같게"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareAttendanceCancel(client, req);
      const { token, expiresAt } = attendanceCancels.put(plan.preview);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_attendance_cancel",
  {
    title: "근태/근무 취소 신청 상신",
    description:
      "jade_prepare_attendance_cancel 이 준 토큰으로 근태/근무 취소 신청서를 결재선에 상신한다. 상신 직전에 화면을 새로 열어 그 원신청이 아직 취소 가능한지 다시 확인하고 " +
      "미리보기와 같을 때만 보낸다. 결재자에게 바로 전달되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_attendance_cancel 이 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => changesCalendar(async () => commitAttendanceCancel(client, attendanceCancels.take(token))),
);

const remoteReverts = new PendingStore<RemoteRevertPlan["preview"]>(5 * 60 * 1000);

server.registerTool(
  "jade_prepare_remote_work_revert",
  {
    title: "재택근무 취소 신청 준비 (한 날)",
    description:
      "재택근무제로 바뀐 날을 재택 근무 신청서로 사용자가 고른 근무유형으로 되돌리는 신청서를 상신 직전까지 채우고 마감 검사를 통과시킨 뒤 " +
      "미리보기와 일회용 토큰을 돌려준다. 상신하지 않는다. 그날이 아직 재택근무제가 아니면(결재 대기 포함) 막는다. " +
      "사유 기본값은 「M월 D일 재택근무 취소 신청드립니다.」. 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_remote_work_revert 로 상신한다.",
    inputSchema: {
      date: ymd.describe("재택을 취소할 날 YYYYMMDD"),
      workType: z.string().min(1).describe("되돌릴 근무유형 이름 (예: 선택근무제(IT)). 원래 근무유형은 미리보기로 확인할 수 없으므로 사용자에게 받는다"),
      reason: z.string().min(1).optional().describe("신청 사유"),
    },
    annotations: readOnly,
  },
  (req) =>
    safely(async () => {
      const plan = await prepareRemoteWorkRevert(client, req);
      const { token, expiresAt } = remoteReverts.put(plan.preview);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

server.registerTool(
  "jade_commit_remote_work_revert",
  {
    title: "재택근무 취소 신청 상신 (한 날)",
    description:
      "jade_prepare_remote_work_revert 가 준 토큰으로 근무유형 되돌리기 재택 근무 신청서를 결재선에 상신한다. 상신 직전에 화면을 새로 열어 검사를 다시 통과하고 " +
      "미리보기와 같을 때만 보낸다. 결재자에게 바로 전달되므로 사용자가 미리보기를 보고 명시적으로 승인했을 때만 호출한다.",
    inputSchema: { token: z.string().describe("jade_prepare_remote_work_revert 가 돌려준 토큰") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ token }) => changesCalendar(async () => commitRemoteWorkRevert(client, remoteReverts.take(token))),
);

server.registerTool(
  "jade_prepare_remote_work_day",
  {
    title: "재택근무 신청 준비 (지정 날짜)",
    description:
      "지정한 하루의 JADE 재택 근무 신청서를 상신 직전까지 채우고 마감 검사를 통과시킨 뒤 미리보기와 일회용 토큰을 돌려준다. 상신하지 않는다. " +
      "결재 대기 중인 같은 날 신청은 달력에 안 보여 두 번 상신될 수 있으므로, 먼저 jade_applications(statuses=[approving])로 그날 재택 신청이 없는지 확인한다. " +
      "사유 기본값은 「M월 D일 재택근무 신청드립니다.」. 사용자가 미리보기를 확인하고 승인한 뒤에만 jade_commit_remote_work 로 상신한다.",
    inputSchema: {
      date: ymd.describe("재택 날짜 YYYYMMDD"),
      reason: z.string().min(1).optional().describe("신청 사유"),
    },
    annotations: readOnly,
  },
  ({ date, reason }) =>
    safely(async () => {
      const plan = await prepareRemoteWork(client, { date, reason: reason ?? remoteWorkReason(date) });
      const { token, expiresAt } = remoteWorks.put(plan.preview);
      return { ...plan.preview, token, expiresAt: expiresAt.toISOString() };
    }),
);

await server.connect(new StdioServerTransport());
