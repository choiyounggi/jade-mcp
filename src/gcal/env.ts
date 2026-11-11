import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "../config.js";

// 구글 캘린더 연동의 파일 위치와, 지금 실행 중인 jade-mcp 를 다시 띄우는 명령.

const here = fileURLToPath(import.meta.url);
/** src/gcal 또는 dist/gcal 의 두 단계 위 */
export const PACKAGE_ROOT = resolve(dirname(here), "..", "..");
const MAIN_ENTRY = join(dirname(here), "..", `main${extname(here)}`);

export const GCAL_DIR = dirname(CONFIG_PATH);
export const GCAL_CLIENT_PATH = join(GCAL_DIR, "gcal-client.json");
export const GCAL_SETTINGS_PATH = join(GCAL_DIR, "gcal.json");
export const GCAL_LOCK_PATH = join(GCAL_DIR, "gcal-sync.lock");
/** 잠금 때문에 못 돈 상신 직후 실행이 남기는 표시. 잠금을 쥔 실행이 끝나기 전에 한 번 더 돈다. */
export const GCAL_RERUN_PATH = join(GCAL_DIR, "gcal-sync.rerun");
export const GCAL_LOG_DIR = join(homedir(), "Library", "Logs", "jade-mcp");
export const GCAL_LOG_PATH = join(GCAL_LOG_DIR, "gcal-sync.log");

/**
 * 지금 프로세스와 같은 node·옵션으로 `jade-mcp <args>` 를 실행하는 인자 목록.
 * 레포 실행(`--import tsx`)과 npm 설치본(dist) 모두 execArgv 를 그대로 물려받아야 같은 방식으로 뜬다.
 * `--import tsx` 는 작업 디렉터리 기준으로 풀리므로 PACKAGE_ROOT 에서 실행해야 한다.
 */
export function selfCommand(args: string[]): string[] {
  return [process.execPath, ...process.execArgv, MAIN_ENTRY, ...args];
}

/**
 * launchd 에 등록할 실행 명령. 버전이 박힌 node 경로를 plist 에 고정하면 node 를 올리거나 지운 뒤
 * 우리 코드가 뜨기도 전에 실패해 로그·알림 없이 멈춘다 — 레포에서는 매번 node 를 고르는 bin/jade-mcp 를 쓴다.
 */
export function launcherCommand(args: string[]): string[] {
  const repoLauncher = join(PACKAGE_ROOT, "bin", "jade-mcp");
  if (existsSync(repoLauncher)) return ["/bin/sh", repoLauncher, ...args];
  if (PACKAGE_ROOT.includes("/_npx/")) {
    throw new Error("npx 임시 설치본은 캐시 정리 때 사라져 자동 실행을 등록할 수 없다 — `npm i -g jade-mcp` 로 설치한 뒤 다시 등록한다");
  }
  return selfCommand(args);
}

/**
 * jade 쓰기 도구가 상신·취소에 성공한 뒤 부른다. 구글 캘린더를 연동한 사용자만 별도 프로세스로 동기화를 띄우고 바로 돌아온다.
 * 도구 응답을 기다리게 하지 않고, 동기화 실패가 신청 결과에 섞이지 않게 하려고 분리한다.
 */
export function triggerGcalSync(): void {
  if (!existsSync(GCAL_CLIENT_PATH)) return;
  const [node, ...args] = selfCommand(["gcal", "sync", "--trigger"]);
  if (!node) return;
  try {
    const child = spawn(node, args, { cwd: PACKAGE_ROOT, detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 동기화를 못 띄워도 신청은 이미 끝났다. 다음 정각 동기화가 반영한다.
  }
}
