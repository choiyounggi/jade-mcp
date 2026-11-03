import { describe, expect, it } from "vitest";
import { keychainAddCommand, saveAccount, storePasswordSilently, type SaveAccountDeps } from "../src/account.js";
import { JadeClient, LoginError } from "../src/client.js";
import type { JadeConfig } from "../src/config.js";
import type { JadeResponse } from "../src/response.js";

const PASSWORD = `p@ss "word" $HOME \\n 한글`;
const PASSWORD_HEX = Buffer.from(PASSWORD, "utf8").toString("hex");

describe("keychainAddCommand", () => {
  it("비밀번호를 UTF-8 바이트의 16진수로 넣은 한 줄을 만든다", () => {
    const line = keychainAddCommand("jade-mcp", "user01", PASSWORD);
    expect(line).toBe(`add-generic-password -U -s "jade-mcp" -a "user01" -X ${PASSWORD_HEX}\n`);
    expect(Buffer.from(line.trim().split(" -X ")[1]!, "hex").toString("utf8")).toBe(PASSWORD);
    expect(line).not.toContain(PASSWORD);
  });

  it("한 글자 비밀번호도 그대로 넣는다", () => {
    expect(keychainAddCommand("s", "a", "x")).toBe(`add-generic-password -U -s "s" -a "a" -X 78\n`);
  });

  it.each([
    ["따옴표", 'us"er'],
    ["역슬래시", "us\\er"],
    ["줄바꿈", "us\ner"],
    ["NUL", "us\u0000er"],
    ["DEL", "us\u007fer"],
  ])("account 에 %s 가 있으면 거부한다", (_name, account) => {
    expect(() => keychainAddCommand("jade-mcp", account, "pw")).toThrow("쓸 수 없는 문자");
  });

  it("service 에 줄바꿈이 있으면 거부한다(다음 명령을 끼워 넣지 못하게)", () => {
    expect(() => keychainAddCommand("jade\ndelete-keychain", "user", "pw")).toThrow("쓸 수 없는 문자");
  });

  it("빈 값은 거부한다", () => {
    expect(() => keychainAddCommand("", "user", "pw")).toThrow("비어 있다");
    expect(() => keychainAddCommand("jade-mcp", "user", "")).toThrow("비밀번호가 비어 있다");
  });
});

describe("storePasswordSilently", () => {
  it("security -i 의 표준입력으로만 비밀번호를 넘긴다", async () => {
    const calls: { command: string; args: string[]; input: string }[] = [];
    await storePasswordSilently("jade-mcp", "user01", PASSWORD, async (command, args, input) => {
      calls.push({ command, args, input });
      return 0;
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("security");
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.args.join(" ")).not.toContain(PASSWORD_HEX);
    expect(calls[0]!.input).toBe(keychainAddCommand("jade-mcp", "user01", PASSWORD));
  });

  it("security 가 실패하면 종료 코드만 담은 오류를 낸다", async () => {
    const error = await storePasswordSilently("jade-mcp", "user01", PASSWORD, async () => 45).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Keychain 저장 실패 (security 종료 코드 45)");
    expect((error as Error).message).not.toContain(PASSWORD);
    expect((error as Error).message).not.toContain(PASSWORD_HEX);
  });

  it("security 를 실행하지 못해도 실행기 오류 문구를 싣지 않는다", async () => {
    const error = await storePasswordSilently("jade-mcp", "user01", PASSWORD, async () => {
      throw new Error(`spawn failed with ${PASSWORD_HEX}`);
    }).catch((e: Error) => e);
    expect((error as Error).message).toBe("Keychain 저장 실패 (security 를 실행하지 못했다)");
  });

  it("거부할 문자가 있으면 security 를 부르지 않는다", async () => {
    let called = false;
    await expect(
      storePasswordSilently("jade-mcp", 'a"b', "pw", async () => {
        called = true;
        return 0;
      }),
    ).rejects.toThrow("쓸 수 없는 문자");
    expect(called).toBe(false);
  });
});

function mainInfo(row: Record<string, string>): JadeResponse {
  return { etc: {}, datasets: { tmpInfo: [row] } };
}

/** fetchMainInfo 는 client.withSession 결과를 그대로 돌려준다 — 로그인 결과만 흉내 낸다. */
function fakeClient(result: () => Promise<JadeResponse>, seen?: { password?: string }): SaveAccountDeps["createClient"] {
  return (_config, getPassword) =>
    ({
      withSession: async () => {
        if (seen) seen.password = await getPassword();
        return result();
      },
    }) as unknown as JadeClient;
}

function recorder() {
  const log: string[] = [];
  const stored: { service: string; account: string; password: string }[] = [];
  const saved: JadeConfig[] = [];
  const deps: SaveAccountDeps = {
    readPrevious: async () => ({ fingerprint: "1a2b3c", keychainService: "jade-mcp" }),
    storePassword: async (service, account, password) => {
      log.push("store");
      stored.push({ service, account, password });
    },
    saveConfig: async (config) => {
      log.push("save");
      saved.push(config);
    },
    readPassword: async () => stored.at(-1)?.password ?? "",
  };
  return { log, stored, saved, deps };
}

describe("saveAccount", () => {
  it("Keychain 에 들어간 값이 입력과 다르면 설정을 쓰지 않고 실패로 알린다", async () => {
    const r = recorder();
    const login = fakeClient(async () => mainInfo({ WORK_YMD: "20261103", C_IN_HM_DP: "09:01", C_OUT_HM_DP: "" }), {});
    await expect(
      saveAccount({ companyCode: "1000", userId: "user01", password: PASSWORD }, { ...r.deps, createClient: login, readPassword: async () => "truncated" }),
    ).rejects.toThrow(/다시 읽어 확인하지 못했다/);
    expect(r.saved).toEqual([]);
  });

  it("되읽기 자체가 실패해도 설정을 쓰지 않는다", async () => {
    const r = recorder();
    const login = fakeClient(async () => mainInfo({ WORK_YMD: "20261103", C_IN_HM_DP: "09:01", C_OUT_HM_DP: "" }), {});
    const err = await saveAccount(
      { companyCode: "1000", userId: "user01", password: PASSWORD },
      { ...r.deps, createClient: login, readPassword: async () => Promise.reject(new Error(`denied ${PASSWORD}`)) },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(PASSWORD);
    expect(r.saved).toEqual([]);
  });

  it("로그인이 되면 Keychain → 설정 파일 순으로 저장하고 오늘 근태를 돌려준다", async () => {
    const r = recorder();
    const seen: { password?: string } = {};
    const result = await saveAccount(
      { companyCode: " 1000 ", userId: "user01", password: PASSWORD },
      {
        ...r.deps,
        createClient: fakeClient(async () => {
          r.log.push("login");
          return mainInfo({ WORK_YMD: "20261103", C_IN_HM_DP: "09:01", C_OUT_HM_DP: "" });
        }, seen),
      },
    );
    expect(result).toEqual({ userId: "user01", workDate: "20261103", clockIn: "09:01", clockOut: "" });
    expect(r.log).toEqual(["login", "store", "save"]);
    expect(seen.password).toBe(PASSWORD);
    expect(r.stored).toEqual([{ service: "jade-mcp", account: "user01", password: PASSWORD }]);
    expect(r.saved[0]).toMatchObject({ companyCode: "1000", userId: "user01", fingerprint: "1a2b3c", baseUrl: "https://ehr.jadehr.co.kr" });
    expect(JSON.stringify(r.saved[0])).not.toContain(PASSWORD);
  });

  it("이전 설정이 없으면 핑거프린트를 새로 만든다", async () => {
    const r = recorder();
    await saveAccount(
      { companyCode: "1000", userId: "user01", password: "pw" },
      { ...r.deps, readPrevious: async () => ({}), createClient: fakeClient(async () => mainInfo({ WORK_YMD: "20261103" })) },
    );
    expect(r.saved[0]!.fingerprint).toMatch(/^[0-9a-f]{1,8}$/);
  });

  it("로그인에 실패하면 아무것도 저장하지 않고 사람이 읽을 말로 알려 준다", async () => {
    const r = recorder();
    const error = await saveAccount(
      { companyCode: "1000", userId: "user01", password: PASSWORD },
      { ...r.deps, createClient: fakeClient(async () => Promise.reject(new LoginError("로그인 실패: 아이디 또는 비밀번호가 맞지 않습니다"))) },
    ).catch((e: Error) => e);
    expect((error as Error).message).toContain("회사코드·아이디·비밀번호를 확인해 줘");
    expect((error as Error).message).toContain("아이디 또는 비밀번호가 맞지 않습니다");
    expect(r.log).toEqual([]);
  });

  it("네트워크 오류는 주소·네트워크를 확인하라고 한다", async () => {
    const r = recorder();
    await expect(
      saveAccount(
        { companyCode: "1000", userId: "user01", password: "pw" },
        { ...r.deps, createClient: fakeClient(async () => Promise.reject(new TypeError("fetch failed"))) },
      ),
    ).rejects.toThrow("네트워크");
    expect(r.log).toEqual([]);
  });

  it("2차 인증 계정은 JADE 문구를 그대로 낸다", async () => {
    const r = recorder();
    await expect(
      saveAccount(
        { companyCode: "1000", userId: "user01", password: "pw" },
        { ...r.deps, createClient: fakeClient(async () => Promise.reject(new LoginError("2차 인증이 켜진 계정이라 자동 로그인을 할 수 없다"))) },
      ),
    ).rejects.toThrow(/^2차 인증/);
  });

  it("오류 문구에 비밀번호가 섞여 있으면 원문을 버린다", async () => {
    const r = recorder();
    const error = await saveAccount(
      { companyCode: "1000", userId: "user01", password: PASSWORD },
      { ...r.deps, createClient: fakeClient(async () => Promise.reject(new LoginError(`로그인 실패: ${PASSWORD}`))) },
    ).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect((error as Error).message).toContain("확인해 줘");
  });

  it("빈 비밀번호·Keychain 에 못 쓰는 아이디는 로그인 전에 거부한다", async () => {
    const r = recorder();
    let loggedIn = false;
    const createClient = fakeClient(async () => {
      loggedIn = true;
      return mainInfo({});
    });
    await expect(saveAccount({ companyCode: "1000", userId: "user01", password: "" }, { ...r.deps, createClient })).rejects.toThrow("비밀번호가 비어");
    await expect(saveAccount({ companyCode: "1000", userId: 'us"er', password: "pw" }, { ...r.deps, createClient })).rejects.toThrow("쓸 수 없는 문자");
    await expect(saveAccount({ companyCode: "", userId: "user01", password: "pw" }, { ...r.deps, createClient })).rejects.toThrow("회사코드");
    expect(loggedIn).toBe(false);
    expect(r.log).toEqual([]);
  });

  it("Keychain 저장이 실패하면 설정 파일을 쓰지 않는다", async () => {
    const r = recorder();
    await expect(
      saveAccount(
        { companyCode: "1000", userId: "user01", password: "pw" },
        {
          ...r.deps,
          createClient: fakeClient(async () => mainInfo({ WORK_YMD: "20261103" })),
          storePassword: async () => {
            throw new Error("Keychain 저장 실패 (security 종료 코드 1)");
          },
        },
      ),
    ).rejects.toThrow("Keychain 저장 실패");
    expect(r.saved).toEqual([]);
  });
});
