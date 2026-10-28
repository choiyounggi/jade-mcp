import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const CONFIG_PATH = process.env.JADE_MCP_CONFIG ?? join(homedir(), ".config", "jade-mcp", "config.json");

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

const run = promisify(execFile);

/** 비밀번호는 macOS Keychain 에서만 읽는다. 실패 메시지에 값이 섞이지 않도록 stderr 를 버린다. */
export async function readKeychainPassword(service: string, account: string): Promise<string> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    const password = stdout.replace(/\n$/, "");
    if (!password) throw new Error("empty");
    return password;
  } catch {
    throw new Error(`Keychain 에서 JADE 비밀번호를 찾지 못했다 (service=${service}, account=${account})`);
  }
}
