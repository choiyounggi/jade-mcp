import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { JadeClient } from "./client.js";
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
  // mode 는 새로 만들 때만 적용된다 — 기존 파일도 본인만 읽게 맞춘다.
  await chmod(CONFIG_PATH, 0o600);
  console.log(`설정을 저장했다: ${CONFIG_PATH}`);

  console.log("\n로그인을 확인한다...");
  const client = new JadeClient(config, () => readKeychainPassword(config.keychainService, config.userId));
  const today = toTodayStatus(await fetchMainInfo(client));
  console.log(`로그인 성공 — 오늘(${today.workDate}) 출근 ${today.clockIn}, 퇴근 ${today.clockOut}`);

  const launcher = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "jade-mcp");
  console.log(`\nClaude Code 에 등록하려면:\n  claude mcp add jade -s user -- ${launcher}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`설정 실패: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
