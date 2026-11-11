import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "../config.js";

// 구글 캘린더 연동의 파일 위치와, 지금 실행 중인 jade-mcp 를 다시 띄우는 명령.

const here = fileURLToPath(import.meta.url);
/** src/gcal 또는 dist/gcal 의 두 단계 위 */
export const PACKAGE_ROOT = resolve(dirname(here), "..", "..");
const MAIN_ENTRY = join(dirname(here), "..", `main${extname(here)}`);
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };

export const GCAL_DIR = dirname(CONFIG_PATH);
export const GCAL_CLIENT_PATH = join(GCAL_DIR, "gcal-client.json");
export const GCAL_SETTINGS_PATH = join(GCAL_DIR, "gcal.json");
export const GCAL_LOCK_PATH = join(GCAL_DIR, "gcal-sync.lock");
/** 잠금 때문에 못 돈 상신 직후 실행이 남기는 표시. 잠금을 쥔 실행이 끝나기 전에 한 번 더 돈다. */
export const GCAL_RERUN_PATH = join(GCAL_DIR, "gcal-sync.rerun");
export const GCAL_LAUNCHER_PATH = join(GCAL_DIR, "gcal-sync.sh");
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

/** 레포 체크아웃이면 bin/jade-mcp 경로. npm 설치본에는 이 파일이 없다(package.json files). */
export function repoLauncherPath(root = PACKAGE_ROOT): string | undefined {
  const path = join(root, "bin", "jade-mcp");
  return existsSync(path) ? path : undefined;
}

/**
 * launchd 에 등록할 실행 명령. plist 에 버전이 박힌 node 경로나 npx 캐시 경로를 넣으면 node 를 올리거나
 * 캐시가 정리된 뒤 우리 코드가 뜨기도 전에 실패해 로그·알림 없이 멈춘다 — 매번 실행 파일을 찾는 스크립트를 가리킨다.
 * 레포는 bin/jade-mcp, npm 설치본은 GCAL_LAUNCHER_PATH(writeLauncher 가 쓴다).
 */
export function launcherCommand(args: string[], repoLauncher: string | null = repoLauncherPath() ?? null): string[] {
  return ["/bin/sh", repoLauncher ?? GCAL_LAUNCHER_PATH, ...args];
}

const LAUNCHER_VERSION = /^JADE_MCP_VERSION=(\S+)$/m;

/** npm 설치본의 정각 실행 스크립트. 고정 버전을 npx 로 실행한다. */
export function buildLauncherScript(version: string): string {
  return `#!/bin/sh
# jade-mcp gcal install 이 만든 파일이다. jade-mcp 버전이 바뀌면 MCP 서버가 뜰 때 다시 쓴다.
# launchd 는 PATH 가 짧아 npx 를 직접 찾는다. node 버전 선택은 jade-mcp 실행기가 한다.
JADE_MCP_VERSION=${version}
NPX=
for c in "$(command -v npx 2>/dev/null)" $(ls -d "\${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/npx 2>/dev/null | sort -V -r) /opt/homebrew/bin/npx /usr/local/bin/npx; do
  if [ -n "$c" ] && [ -x "$c" ]; then NPX=$c; break; fi
done
if [ -z "$NPX" ]; then echo "jade-mcp: npx 를 찾지 못했다 — Node 를 설치해야 한다 (예: nvm install 24)" >&2; exit 1; fi
PATH="$(dirname "$NPX"):$PATH" exec "$NPX" -y --prefer-offline "jade-mcp@$JADE_MCP_VERSION" "$@"
`;
}

export function launcherVersion(script: string): string | undefined {
  return script.match(LAUNCHER_VERSION)?.[1];
}

export async function writeLauncher(version = PACKAGE_VERSION): Promise<void> {
  await mkdir(GCAL_DIR, { recursive: true });
  await writeFile(GCAL_LAUNCHER_PATH, buildLauncherScript(version), { mode: 0o755 });
}

/**
 * MCP 서버가 뜰 때 부른다. npm 설치본으로 정각 실행을 등록한 사용자의 고정 버전을 지금 버전으로 맞춘다 —
 * 플러그인이 버전 핀을 올려도 정각 실행이 예전 버전에 머물지 않게 한다. 등록하지 않았으면 아무것도 안 한다.
 */
export async function refreshLauncher(): Promise<void> {
  if (repoLauncherPath()) return;
  const current = await readFile(GCAL_LAUNCHER_PATH, "utf8").catch(() => undefined);
  if (current === undefined || launcherVersion(current) === PACKAGE_VERSION) return;
  await writeLauncher();
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
