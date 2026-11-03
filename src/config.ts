import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

export interface JadeConfig {
  baseUrl: string;
  companyCode: string;
  userId: string;
  keychainService: string;
  /** 실제 브라우저의 getJadeFP() 값. 매번 달라지면 JADE 가 새 기기로 기록한다. */
  fingerprint: string;
  userAgent: string;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "jade-mcp", "config.json");

export const CONFIG_PATH = process.env.JADE_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;

export async function loadConfig(path = CONFIG_PATH): Promise<JadeConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`설정 파일(${path})이 없다 — bin/jade-mcp-setup 으로 계정을 먼저 설정해야 한다`);
  }
  const raw = JSON.parse(text) as Partial<JadeConfig>;
  const required: (keyof JadeConfig)[] = ["baseUrl", "companyCode", "userId", "keychainService", "fingerprint", "userAgent"];
  const missing = required.filter((k) => !raw[k]);
  if (missing.length > 0) {
    throw new Error(`설정 파일(${path})에 값이 비어 있다: ${missing.join(", ")}`);
  }
  return raw as JadeConfig;
}

/** 이전 설정을 기본값으로 쓸 때 부른다. 파일이 없거나 JSON 이 깨졌으면 처음 설정하는 것으로 본다. */
export async function readConfigIfAny(path = CONFIG_PATH): Promise<Partial<JadeConfig>> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<JadeConfig>) : {};
  } catch {
    return {};
  }
}

export async function saveConfig(config: JadeConfig, path = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // mode 는 새로 만들 때만 적용된다 — 기존 파일·폴더도 본인만 읽게 맞춘다.
  // JADE_MCP_CONFIG 등으로 기본 위치가 아닌 곳에 두면 그 폴더는 사용자 것이라 권한을 건드리지 않는다.
  await chmod(path, 0o600);
  if (resolve(path) === DEFAULT_CONFIG_PATH) await chmod(dirname(path), 0o700);
}

const run = promisify(execFile);

/**
 * security find-generic-password -g 가 stderr 에 찍는 password 줄을 푼다. -w 는 한글·탭처럼 출력할 수 없는
 * 바이트가 섞이면 값을 16진수로 바꿔 찍는데, 그대로 찍힌 값과 구분할 수 없어(예: "deadbeef") 쓰지 않는다.
 * -g 는 그런 값이면 `0x<16진수>  "…"`, 아니면 `"…"` 로 찍어 둘을 가를 수 있다.
 */
export function parseKeychainPassword(stderr: string): string | undefined {
  const line = stderr.split("\n").find((l) => l.startsWith("password: "));
  if (!line) return undefined;
  const hex = /^password: 0x([0-9A-Fa-f]+)(?:\s|$)/.exec(line);
  if (hex) return Buffer.from(hex[1]!, "hex").toString("utf8");
  return /^password: "(.*)"$/.exec(line)?.[1];
}

/** 비밀번호는 macOS Keychain 에서만 읽는다. 실패 메시지에 값이 섞이지 않도록 출력을 싣지 않는다. */
/** security 가 항목이 없을 때 내는 종료 코드(errSecItemNotFound). 접근 거부·잠김과 구분해야 온보딩을 엉뚱하게 띄우지 않는다. */
const ITEM_NOT_FOUND = 44;

export class KeychainItemMissingError extends Error {
  constructor(service: string, account: string) {
    super(`Keychain 에 JADE 비밀번호가 없다 (service=${service}, account=${account})`);
    this.name = "KeychainItemMissingError";
  }
}

const exitCodeOf = (e: unknown) => (e as { code?: unknown }).code;

export async function readKeychainPassword(service: string, account: string): Promise<string> {
  let stderr: string;
  try {
    ({ stderr } = await run("security", ["find-generic-password", "-s", service, "-a", account, "-g"]));
  } catch (e) {
    if (exitCodeOf(e) === ITEM_NOT_FOUND) throw new KeychainItemMissingError(service, account);
    // stderr 에 값이 섞일 수 있어 원인 메시지는 싣지 않는다.
    throw new Error("Keychain 에서 JADE 비밀번호를 읽지 못했다 — 키체인 접근 허용 창에서 거부했거나 키체인이 잠겨 있다. 허용·잠금 해제 뒤 다시 시도한다");
  }
  const password = parseKeychainPassword(stderr);
  if (!password) throw new Error("Keychain 의 JADE 비밀번호를 읽지 못했다 — security 출력 형식이 예상과 다르다");
  return password;
}

/** 복호화 없이 항목이 있는지만 본다 — 접근 허용 창을 띄우지 않는다. */
export async function keychainItemState(service: string, account: string): Promise<"present" | "missing" | "unknown"> {
  try {
    await run("security", ["find-generic-password", "-s", service, "-a", account]);
    return "present";
  } catch (e) {
    return exitCodeOf(e) === ITEM_NOT_FOUND ? "missing" : "unknown";
  }
}
