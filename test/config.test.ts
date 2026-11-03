import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseKeychainPassword, readConfigIfAny, saveConfig, type JadeConfig, readKeychainPassword, KeychainItemMissingError, keychainItemState } from "../src/config.js";

// 시스템 임시 폴더(/tmp·$TMPDIR) 대신 세션 작업 폴더를 쓴다 — 보안 에이전트가 그 경로의 파일 생성을 막는다.
const base = join(process.env.CLAUDE_SESSION_TMP || join(homedir(), ".claude", "tmp", "s", "jade-mcp-test"), `config-test-${process.pid}`);

const config: JadeConfig = {
  baseUrl: "https://ehr.jadehr.co.kr",
  companyCode: "1000",
  userId: "user01",
  keychainService: "jade-mcp",
  fingerprint: "1a2b3c",
  userAgent: "UA",
};

const mode = async (path: string) => (await stat(path)).mode & 0o777;

beforeAll(async () => {
  await mkdir(base, { recursive: true });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("saveConfig", () => {
  it("새 폴더는 0700, 파일은 0600 으로 만든다", async () => {
    const path = join(base, "fresh", "nested", "config.json");
    await saveConfig(config, path);
    expect(await mode(path)).toBe(0o600);
    expect(await mode(join(base, "fresh", "nested"))).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
  });

  it("이미 있던 파일의 권한도 0600 으로 좁힌다", async () => {
    const path = join(base, "existing.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await chmod(path, 0o644);
    await saveConfig(config, path);
    expect(await mode(path)).toBe(0o600);
  });

  it("기본 위치가 아닌 폴더는 사용자 것이라 권한을 건드리지 않는다", async () => {
    const dir = join(base, "custom");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await saveConfig(config, join(dir, "config.json"));
    expect(await mode(dir)).toBe(0o755);
  });
});

describe("readConfigIfAny", () => {
  it("저장한 설정을 그대로 읽는다", async () => {
    const path = join(base, "read.json");
    await saveConfig(config, path);
    expect(await readConfigIfAny(path)).toEqual(config);
  });

  it("파일이 없으면 빈 객체", async () => {
    expect(await readConfigIfAny(join(base, "missing.json"))).toEqual({});
  });

  it("JSON 이 깨졌거나 객체가 아니면 빈 객체", async () => {
    const broken = join(base, "broken.json");
    await writeFile(broken, "{ not json");
    expect(await readConfigIfAny(broken)).toEqual({});
    const array = join(base, "array.json");
    await writeFile(array, "[1,2]");
    expect(await readConfigIfAny(array)).toEqual({});
  });
});

describe("parseKeychainPassword", () => {
  const hexLine = (value: string) =>
    `keychain: "/Users/me/Library/Keychains/login.keychain-db"\npassword: 0x${Buffer.from(value).toString("hex").toUpperCase()}  "\\352\\271..."\n`;

  it("출력할 수 있는 문자뿐이면 따옴표 안을 그대로 쓴다", () => {
    expect(parseKeychainPassword('password: "Passw0rd!"\n')).toBe("Passw0rd!");
  });

  it("16진수처럼 생긴 비밀번호도 따옴표 형식이면 글자 그대로다", () => {
    expect(parseKeychainPassword('password: "deadbeef"\n')).toBe("deadbeef");
  });

  it("0x 형식이면 바이트를 UTF-8 로 되돌린다(한글·따옴표·탭)", () => {
    for (const value of ["비번한글abc", 'a "q" \\ $HOME', "a\tb"]) {
      expect(parseKeychainPassword(hexLine(value))).toBe(value);
    }
  });

  it("password 줄이 없거나 비어 있으면 undefined", () => {
    expect(parseKeychainPassword("")).toBeUndefined();
    expect(parseKeychainPassword("keychain: x\n")).toBeUndefined();
    expect(parseKeychainPassword("password: \n")).toBeUndefined();
  });
});

describe.runIf(process.platform === "darwin")("Keychain 항목 없음 판별", () => {
  const service = `jade-mcp-test-absent-${process.pid}-${Date.now()}`;

  it("항목이 없으면 접근 거부와 구분되는 KeychainItemMissingError 를 낸다", async () => {
    await expect(readKeychainPassword(service, "nobody")).rejects.toBeInstanceOf(KeychainItemMissingError);
  });

  it("복호화 없이 항목 상태를 missing 으로 본다", async () => {
    expect(await keychainItemState(service, "nobody")).toBe("missing");
  });
});

