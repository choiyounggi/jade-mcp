import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JadeClient } from "./client.js";
import { loadConfig, readKeychainPassword } from "./config.js";
import { z } from "zod";
import { fetchMainInfo, toRecentApplications, toTodayStatus, toVacationBalance } from "./features.js";
import { PendingStore } from "./pending.js";
import { commitPunch, preparePunch, type PunchPlan } from "./punch.js";
import { commitCondolence, prepareCondolence, type CondolencePlan } from "./condolence.js";
import { commitSchedule, prepareSchedule, type SchedulePlan } from "./schedule.js";
import { commitVacation, prepareVacation, type VacationPlan } from "./vacation.js";

const config = await loadConfig();
const client = new JadeClient(config, () => readKeychainPassword(config.keychainService, config.userId));

const server = new McpServer({ name: "jade", version: "0.1.0" });

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function safely<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (e) {
    // fetch 는 원인을 cause 에만 담는다 (예: 인증서 검증 실패) — 메시지만으로는 진단할 수 없다.
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    const message = cause ? `${(e as Error).message} (${cause})` : (e as Error).message;
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

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
  ({ token }) => safely(async () => commitVacation(client, vacations.take(token))),
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
  ({ token }) => safely(async () => commitCondolence(client, condolences.take(token))),
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

await server.connect(new StdioServerTransport());
