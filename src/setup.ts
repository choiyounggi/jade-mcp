import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { JadeClient, LoginError } from "./client.js";
import { CONFIG_PATH, readKeychainPassword, type JadeConfig } from "./config.js";
import { fetchMainInfo, toTodayStatus } from "./features.js";

export const DEFAULTS = {
  baseUrl: "https://ehr.jadehr.co.kr",
  keychainService: "jade-mcp",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
} as const;

/** 브라우저의 getJadeFP() 는 32비트 해시의 16진수다. 값이 없으면 같은 모양의 임의 값을 한 번 만들어 계속 쓴다. */
export function generateFingerprint(): string {
  return (randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16);
}

export function isFingerprint(value: string): boolean {
  return /^[0-9a-f]{1,8}$/.test(value);
}

export function buildConfig(answers: Partial<JadeConfig>, previous: Partial<JadeConfig> = {}): JadeConfig {
  const pick = (key: keyof JadeConfig, fallback = "") => (answers[key] || previous[key] || fallback).trim();
  const config: JadeConfig = {
    baseUrl: pick("baseUrl", DEFAULTS.baseUrl).replace(/\/+$/, ""),
    companyCode: pick("companyCode"),
    userId: pick("userId"),
    keychainService: pick("keychainService", DEFAULTS.keychainService),
    fingerprint: pick("fingerprint") || generateFingerprint(),
    userAgent: pick("userAgent", DEFAULTS.userAgent),
  };
  if (!/^https:\/\//.test(config.baseUrl)) throw new Error("JADE 주소는 https:// 로 시작해야 한다");
  if (!config.companyCode) throw new Error("회사코드가 비어 있다");
  if (!config.userId) throw new Error("아이디가 비어 있다");
  if (!isFingerprint(config.fingerprint)) throw new Error("핑거프린트는 브라우저 getJadeFP() 값(16진수 8자 이하)이어야 한다");
  return config;
}

async function readPrevious(): Promise<Partial<JadeConfig>> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<JadeConfig>;
  } catch {
    return {};
  }
}

/**
 * 비밀번호는 이 프로세스를 거치지 않는다 — security 가 터미널에서 직접 받아 Keychain 에 넣는다
 * (-w 를 값 없이 마지막에 두면 security 가 입력을 요청한다).
 */
function storePassword(service: string, account: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`Keychain 저장 실패 (security 종료 코드 ${code})`))));
  });
}

/**
 * 비밀번호를 다시 받아 볼 만한 로그인 실패인지. 2차 인증·비밀번호 초기화 상태와, LoginError 로 감싸 오는
 * 네트워크·인증서 오류나 메인 화면을 못 받은 경우는 비밀번호를 다시 넣어도 안 된다.
 */
export function canRetryPassword(e: unknown): boolean {
  return (
    e instanceof LoginError &&
    !/2차 인증|비밀번호 초기화|메인 화면|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|CERT|certificate|HTTP \d{3}/i.test(e.message)
  );
}

/**
 * MCP 를 등록할 Claude Code 설정 위치. null 은 기본(~/.claude.json)이다. 기본에 등록하면 모든 세션에서 보이고,
 * 프로필 전환 도구(orca 등)도 기본 설정의 mcpServers 를 각 프로필로 복사한다. 지금 셸이 다른 설정 폴더를
 * 쓰고 있으면(CLAUDE_CONFIG_DIR) 그곳에도 등록한다.
 */
export function registrationTargets(env: NodeJS.ProcessEnv): (string | null)[] {
  // CLAUDE_CONFIG_DIR 를 쓰면 설정 파일이 <폴더>/.claude.json 이라 ~/.claude 여도 기본(~/.claude.json)과 다른 파일이다.
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? [null, dir] : [null];
}

function runClaude(args: string[], configDir: string | null): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("claude", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, out }));
  });
}

/** Claude Code 에 jade MCP 를 user 범위로 등록한다. 이미 같은 경로로 있으면 건드리지 않는다. */
async function registerClaude(launcher: string): Promise<void> {
  const manual = `  claude mcp add jade -s user -- "${launcher}"`;
  for (const dir of registrationTargets(process.env)) {
    const where = dir ? `설정 폴더 ${dir}` : "기본 설정(~/.claude.json)";
    try {
      const existing = await runClaude(["mcp", "get", "jade"], dir);
      if (existing.code === 0 && existing.out.includes(launcher)) {
        console.log(`이미 등록돼 있다 — ${where}`);
        continue;
      }
      if (existing.code === 0) {
        console.log(`${where} 에 다른 경로의 jade 가 이미 있다(어느 범위인지는 claude mcp get jade). 지우고 다시 등록하려면:\n  claude mcp remove jade -s <범위> && \\\n${manual}`);
        continue;
      }
      const added = await runClaude(["mcp", "add", "jade", "-s", "user", "--", launcher], dir);
      if (added.code !== 0) throw new Error(added.out.trim() || `종료 코드 ${added.code}`);
      console.log(`등록했다 — ${where}`);
    } catch (e) {
      console.log(`자동 등록 실패(${(e as Error).message}). 직접 등록하려면:\n${manual}`);
      return;
    }
  }
  console.log("Claude Code 를 다시 열면 jade 도구가 보인다.");
}

async function confirm(question: string, byDefault = true): Promise<boolean> {
  if (!stdin.isTTY) return byDefault;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} ${byDefault ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer === "" ? byDefault : answer.startsWith("y");
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const previous = await readPrevious();
  const rl = createInterface({ input: stdin, output: stdout });
  // question() 은 미리 들어온 입력 줄을 놓친다(붙여넣기·파이프). 줄 반복자는 줄을 버퍼에 모아 둔다.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (label: string, current?: string) => {
    stdout.write(current ? `${label} [${current}]: ` : `${label}: `);
    const next = await lines.next();
    return next.done ? "" : String(next.value).trim();
  };

  console.log(`JADE MCP 계정 설정 — 설정 파일: ${CONFIG_PATH}\n`);
  const answers: Partial<JadeConfig> = {
    baseUrl: await ask("JADE 주소", previous.baseUrl ?? DEFAULTS.baseUrl),
    companyCode: await ask("회사코드 (JADE 로그인 화면에 입력하는 값)", previous.companyCode),
    userId: await ask("아이디", previous.userId),
    fingerprint: await ask(
      "브라우저 핑거프린트 (JADE 화면의 개발자도구 콘솔에서 getJadeFP() 결과, 비우면 자동 생성)",
      previous.fingerprint,
    ),
  };
  rl.close();
  const config = buildConfig(answers, previous);

  const askPassword = !previous.userId || previous.userId !== config.userId || process.argv.includes("--password");
  if (askPassword) {
    console.log("\nJADE 비밀번호를 macOS Keychain 에 저장한다. 아래 security 입력창에 두 번 입력한다.");
    await storePassword(config.keychainService, config.userId);
  } else {
    console.log("\n기존 Keychain 비밀번호를 그대로 쓴다 (바꾸려면 --password 로 다시 실행).");
  }

  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // mode 는 새로 만들 때만 적용된다 — 기존 파일·폴더도 본인만 읽게 맞춘다.
  // JADE_MCP_CONFIG 로 경로를 바꿨으면 그 폴더는 사용자 것이라 권한을 건드리지 않는다.
  await chmod(CONFIG_PATH, 0o600);
  if (!process.env.JADE_MCP_CONFIG) await chmod(dirname(CONFIG_PATH), 0o700);
  console.log(`설정을 저장했다: ${CONFIG_PATH}`);

  console.log("\n로그인을 확인한다...");
  for (let attempt = 1; ; attempt++) {
    try {
      const client = new JadeClient(config, () => readKeychainPassword(config.keychainService, config.userId));
      const today = toTodayStatus(await fetchMainInfo(client));
      console.log(`로그인 성공 — 오늘(${today.workDate}) 출근 ${today.clockIn}, 퇴근 ${today.clockOut}`);
      break;
    } catch (e) {
      if (!canRetryPassword(e) || attempt >= 3 || !stdin.isTTY) throw e;
      console.log(`\n${(e as Error).message}`);
      const retry = await confirm("비밀번호를 다시 입력할까? (회사코드·아이디가 틀렸다면 n 을 누르고 setup 을 다시 실행)");
      if (!retry) throw e;
      await storePassword(config.keychainService, config.userId);
    }
  }

  const launcher = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jade-mcp");
  if (await confirm("\nClaude Code 에 jade MCP 를 등록할까?")) {
    await registerClaude(launcher);
  } else {
    console.log(`나중에 등록하려면:\n  claude mcp add jade -s user -- ${launcher}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`설정 실패: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
