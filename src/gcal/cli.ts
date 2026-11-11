import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { appendFile, chmod, copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { JadeClient } from "../client.js";
import { loadConfig, readKeychainPassword } from "../config.js";
import { fetchApplications, type ApplicationRow } from "../history.js";
import { fetchCalendar } from "../schedule.js";
import {
  GCAL_CLIENT_PATH,
  GCAL_DIR,
  GCAL_LOCK_PATH,
  GCAL_LOG_DIR,
  GCAL_LOG_PATH,
  GCAL_RERUN_PATH,
  GCAL_SETTINGS_PATH,
  launcherCommand,
  repoLauncherPath,
  writeLauncher,
} from "./env.js";
import { authorize, createCalendarApi, getAccessToken, hasRefreshToken, loadOAuthClient, readRefreshToken } from "./google.js";
import { agentState, installAgent, PLIST_PATH, uninstallAgent } from "./launchd.js";
import { kstParts, type CalendarEntry } from "./plan.js";
import { formatReport, runSync, type SyncMode } from "./sync.js";

const run = promisify(execFile);

const USAGE = `사용법: jade-mcp gcal <명령>
  auth [--client <JSON 경로>]   구글 로그인 (클라이언트 JSON 을 주면 설정 폴더로 복사한다)
  sync [--dry-run] [--force]   지금 동기화 (--dry-run 은 바꿀 목록만 출력)
  install                      평일 9~19시 매 정각 자동 동기화 등록
  uninstall                    자동 동기화 해제 (만든 일정은 남긴다)
  status                       연동·자동 실행 상태`;

const LOG_MAX_BYTES = 1_000_000;
const NETWORK_POLL_MS = 15_000;
const NETWORK_PROBES = ["oauth2.googleapis.com", "www.googleapis.com"];
const MAX_PAGES = 20;
const MAX_RERUNS = 3;

async function log(line: string): Promise<void> {
  const p = kstParts(new Date());
  const stamped = `${p.ymd} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${line}`;
  console.log(stamped);
  await mkdir(GCAL_LOG_DIR, { recursive: true });
  const size = await stat(GCAL_LOG_PATH).then((s) => s.size, () => 0);
  if (size > LOG_MAX_BYTES) await rename(GCAL_LOG_PATH, `${GCAL_LOG_PATH}.1`);
  await appendFile(GCAL_LOG_PATH, `${stamped}\n`);
}

function notify(message: string): Promise<void> {
  const text = JSON.stringify(message.replace(/\s+/g, " ").slice(0, 200));
  return new Promise((resolve) => execFile("osascript", ["-e", `display notification ${text} with title "JADE → 구글 캘린더"`], () => resolve()));
}

async function calendarId(): Promise<string> {
  try {
    const settings = JSON.parse(await readFile(GCAL_SETTINGS_PATH, "utf8")) as { calendarId?: string };
    return settings.calendarId || "primary";
  } catch {
    return "primary";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 잠금 파일에 PID 를 적는다. 적힌 프로세스가 죽었으면(비정상 종료·재부팅) 남은 잠금을 치우고 다시 잡는다. */
async function tryLock(): Promise<boolean> {
  await mkdir(GCAL_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(GCAL_LOCK_PATH, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      return true;
    } catch {
      const owner = Number(await readFile(GCAL_LOCK_PATH, "utf8").catch(() => ""));
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) return false;
      await rm(GCAL_LOCK_PATH, { force: true });
    }
  }
  return false;
}

async function releaseLock(): Promise<void> {
  const owner = await readFile(GCAL_LOCK_PATH, "utf8").catch(() => "");
  if (owner === String(process.pid)) await rm(GCAL_LOCK_PATH, { force: true });
}

async function takeRerun(): Promise<boolean> {
  if (!existsSync(GCAL_RERUN_PATH)) return false;
  await rm(GCAL_RERUN_PATH, { force: true });
  return true;
}

async function waitForNetwork(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const ok = await Promise.all(NETWORK_PROBES.map((h) => lookup(h))).then(() => true, () => false);
    if (ok) return true;
    if (Date.now() + NETWORK_POLL_MS > deadline) return false;
    await sleep(NETWORK_POLL_MS);
  }
}

async function fetchJade(months: string[], fromYmd: string, toYmd: string) {
  const config = await loadConfig();
  const client = new JadeClient(config, () => readKeychainPassword(config.keychainService, config.userId));
  const calendar: CalendarEntry[] = [];
  for (const month of months) calendar.push(...(await fetchCalendar(client, month)));
  const applications: ApplicationRow[] = [];
  for (let page = 1; ; page++) {
    const res = await fetchApplications(client, { fromYmd, toYmd, statuses: ["approving", "completed"], pageSize: 50, page });
    applications.push(...res.items);
    if (page >= res.pageCount) break;
    // 잘린 목록으로 진행하면 결재중 일정이 지워지고 승인 일정이 달력 표시 기반으로 바뀐다.
    if (page >= MAX_PAGES) throw new Error(`신청내역이 ${MAX_PAGES * 50}건을 넘어 끝까지 읽지 못했다`);
  }
  return { calendar, applications };
}

async function openCalendar() {
  const client = await loadOAuthClient(GCAL_CLIENT_PATH);
  return createCalendarApi(await getAccessToken(client, await readRefreshToken()), await calendarId());
}

async function sync(flags: string[]): Promise<void> {
  // 네트워크·잠금을 기다리기 전 시각으로 정각 실행 여부를 판단해야 기다린 정각 실행이 「늦은 실행」으로 버려지지 않는다.
  const startedAt = new Date();
  const dryRun = flags.includes("--dry-run");
  const mode: SyncMode = flags.includes("--trigger") ? "trigger" : flags.includes("--force") || dryRun ? "manual" : "hourly";
  const out = dryRun ? async (l: string) => console.log(l) : log;

  if (!(await tryLock())) {
    if (mode === "hourly") return;
    // 앞 실행이 상신 전에 JADE 를 읽었을 수 있다 — 표시를 남겨 그 실행이 끝나기 전에 한 번 더 돌게 한다.
    await mkdir(GCAL_DIR, { recursive: true });
    await appendFile(GCAL_RERUN_PATH, "");
    await sleep(1_000);
    if (!(await tryLock())) {
      await out("다른 동기화가 실행 중 — 그 실행이 끝난 뒤 한 번 더 돈다");
      return;
    }
  }
  try {
    if (!(await waitForNetwork(mode === "hourly" ? 5 * 60_000 : 60_000))) {
      await out("건너뜀: 인터넷 연결 없음 — 다음 정각에 다시 확인");
      return;
    }
    const deps = { fetchJade, openCalendar };
    let report = await runSync({ ...deps, now: () => startedAt }, { mode, dryRun });
    // 정각 건너뜀은 하루 수십 줄이라 로그에 남기지 않는다.
    if (!(report.status === "skipped" && mode === "hourly")) {
      for (const line of formatReport(report)) await out(mode === "trigger" ? line.replace("동기화 완료:", "동기화 완료(신청 직후):") : line);
    }
    for (let i = 0; i < MAX_RERUNS && !dryRun && (await takeRerun()); i++) {
      report = await runSync({ ...deps, now: () => new Date() }, { mode: "trigger", dryRun });
      for (const line of formatReport(report)) await out(line.replace("동기화 완료:", "동기화 완료(신청 직후):"));
    }
  } finally {
    await releaseLock();
  }
}

async function auth(flags: string[]): Promise<void> {
  const i = flags.indexOf("--client");
  if (i >= 0) {
    const source = flags[i + 1];
    if (!source) throw new Error("--client 뒤에 OAuth 클라이언트 JSON 경로가 필요하다");
    await loadOAuthClient(source);
    await mkdir(GCAL_DIR, { recursive: true });
    await copyFile(source, GCAL_CLIENT_PATH);
    await chmod(GCAL_CLIENT_PATH, 0o600);
  }
  await authorize(await loadOAuthClient(GCAL_CLIENT_PATH));
  console.log("구글 캘린더 인증 완료 — refresh token 을 Keychain(jade-mcp-gcal)에 저장했다.");
}

/** 등록된 plist 의 실행 파일이 아직 있는지 — node 를 지우거나 레포를 옮기면 launchd 가 조용히 실패한다. */
async function missingProgramPaths(): Promise<string[]> {
  try {
    const { stdout } = await run("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", PLIST_PATH]);
    return (JSON.parse(stdout) as string[]).filter((a) => a.startsWith("/") && !existsSync(a));
  } catch {
    return [];
  }
}

async function status(): Promise<void> {
  const client = await loadOAuthClient(GCAL_CLIENT_PATH).then(() => "있음", (e: Error) => `없음 (${e.message})`);
  const agent = await agentState();
  const missing = agent ? await missingProgramPaths() : [];
  const lines = [
    `OAuth 클라이언트: ${client}`,
    `구글 인증(Keychain): ${(await hasRefreshToken()) ? "있음" : "없음 — jade-mcp gcal auth"}`,
    `자동 실행: ${agent ? `등록됨 (${PLIST_PATH})` : "등록 안 됨 — jade-mcp gcal install"}`,
    ...(agent ?? []).map((l) => `  ${l}`),
    ...missing.map((p) => `  ⚠ 실행 파일이 없다: ${p} — jade-mcp gcal install 로 다시 등록한다`),
    `로그: ${GCAL_LOG_PATH}`,
  ];
  const recent = await readFile(GCAL_LOG_PATH, "utf8").then((t) => t.trimEnd().split("\n").slice(-5), () => []);
  console.log([...lines, ...recent.map((l) => `  ${l}`)].join("\n"));
}

export async function runGcalCommand(argv: string[]): Promise<void> {
  const [command, ...flags] = argv;
  try {
    switch (command) {
      case "auth":
        await auth(flags);
        break;
      case "sync":
        await sync(flags);
        break;
      case "install":
        if (!repoLauncherPath()) await writeLauncher();
        // npx 캐시 경로는 정리되면 사라져 작업 디렉터리로 쓰면 launchd 가 실행 자체를 못 한다.
        await installAgent({ programArguments: launcherCommand(["gcal", "sync"]), workingDirectory: GCAL_DIR, logDir: GCAL_LOG_DIR });
        console.log(`자동 동기화 등록 완료 — 평일 9~19시 매 정각 (${PLIST_PATH})`);
        break;
      case "uninstall":
        await uninstallAgent();
        console.log("자동 동기화 해제 완료 — 이미 만든 구글 캘린더 일정은 남겨 둔다.");
        break;
      case "status":
        await status();
        break;
      default:
        console.error(USAGE);
        process.exitCode = 2;
    }
  } catch (e) {
    const message = (e as Error).message;
    if (command === "sync") {
      await log(`실패: ${message}`).catch(() => {});
      if (!flags.includes("--dry-run")) await notify(`동기화 실패: ${message}`);
    } else {
      console.error(`실패: ${message}`);
    }
    process.exitCode = 1;
  }
}
