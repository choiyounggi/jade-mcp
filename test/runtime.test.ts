import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { JadeClient } from "../src/client.js";
import type { JadeConfig } from "../src/config.js";
import type { DoctorReport } from "../src/doctor.js";
import { createRuntime, NeedsOnboardingError, UnsafeRuntimeError, type RuntimeDeps } from "../src/runtime.js";
import { launchCommand } from "../src/setup.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const config: JadeConfig = {
  baseUrl: "https://jade.example",
  companyCode: "C1",
  userId: "user1",
  keychainService: "jade-mcp",
  fingerprint: "abc123",
  userAgent: "UA",
};

const okReport: DoctorReport = { ready: true, checks: [{ id: "os", status: "ok", label: "macOS", detail: "darwin" }] };

function deps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    loadConfig: async () => config,
    readPassword: async () => "pw",
    passwordState: async () => "present",
    nodeVersion: "24.22.1",
    runDoctor: async () => okReport,
    startOnboarding: async () => ({ url: "http://127.0.0.1:1234/tok", reused: false }),
    env: {},
    createClient: () => ({ marker: Symbol("client") }) as unknown as JadeClient,
    ...overrides,
  };
}

describe("createRuntime.getClient", () => {
  it("설정과 비밀번호가 있으면 클라이언트를 한 번만 만들어 재사용한다", async () => {
    const createClient = vi.fn(() => ({}) as JadeClient);
    const rt = createRuntime(deps({ createClient }));
    const a = await rt.getClient();
    const b = await rt.getClient();
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("설정 파일이 없으면 온보딩이 필요하다고 알린다", async () => {
    const rt = createRuntime(deps({ loadConfig: async () => Promise.reject(new Error("no file")) }));
    await expect(rt.getClient()).rejects.toBeInstanceOf(NeedsOnboardingError);
  });

  it("Keychain 항목이 없으면 클라이언트를 만들지 않고 온보딩으로 보낸다", async () => {
    const createClient = vi.fn(() => ({}) as JadeClient);
    const rt = createRuntime(deps({ passwordState: async () => "missing", createClient }));
    await expect(rt.getClient()).rejects.toBeInstanceOf(NeedsOnboardingError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("Keychain 접근이 거부돼 상태를 모르면 온보딩으로 보내지 않고 로그인 단계에 원인을 맡긴다", async () => {
    const readPassword = vi.fn(async () => "pw");
    const rt = createRuntime(deps({ passwordState: async () => "unknown", readPassword }));
    await expect(rt.getClient()).resolves.toBeDefined();
    expect(readPassword).not.toHaveBeenCalled();
  });

  it("실행기를 거치지 않아도 보안 패치 안 된 Node 면 요청하지 않는다", async () => {
    const rt = createRuntime(deps({ nodeVersion: "22.19.0" }));
    await expect(rt.getClient()).rejects.toBeInstanceOf(UnsafeRuntimeError);
  });

  it("실행기가 보안 패치 안 된 Node 로 띄웠으면 설정이 있어도 요청하지 않는다", async () => {
    const loadConfig = vi.fn(async () => config);
    const rt = createRuntime(deps({ env: { JADE_MCP_NODE_FALLBACK: "1" }, loadConfig }));
    await expect(rt.getClient()).rejects.toBeInstanceOf(UnsafeRuntimeError);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("reset 뒤에는 바뀐 설정으로 새 클라이언트를 만든다", async () => {
    const createClient = vi.fn(() => ({}) as JadeClient);
    const rt = createRuntime(deps({ createClient }));
    await rt.getClient();
    rt.reset();
    await rt.getClient();
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});

describe("createRuntime.onboardingMessage", () => {
  it("설정 페이지 주소와 비밀번호를 대화로 받지 말라는 안내를 담는다", async () => {
    const msg = await createRuntime(deps()).onboardingMessage("계정 설정 파일이 없다");
    expect(msg).toContain("http://127.0.0.1:1234/tok");
    expect(msg).toContain("계정 설정 파일이 없다");
    expect(msg).toMatch(/비밀번호는 이 대화로 받지 말고/);
    expect(msg).not.toContain("먼저 해결할 문제");
  });

  it("점검에 실패 항목이 있으면 해결 방법을 함께 알린다", async () => {
    const report: DoctorReport = {
      ready: false,
      checks: [
        { id: "node", status: "fail", label: "Node", detail: "20.0.0", fix: "nvm install 24" },
        { id: "account", status: "warn", label: "계정", detail: "미설정" },
      ],
    };
    const msg = await createRuntime(deps({ runDoctor: async () => report })).onboardingMessage("x");
    expect(msg).toContain("- Node: 20.0.0 → nvm install 24");
    expect(msg).not.toContain("- 계정");
  });

  it("이미 열린 페이지를 재사용하면 그렇게 알린다", async () => {
    const msg = await createRuntime(deps({ startOnboarding: async () => ({ url: "http://127.0.0.1:9/t", reused: true }) })).onboardingMessage("x");
    expect(msg).toContain("이미 열어 둔");
  });
});

describe("launchCommand", () => {
  it("npm 패키지의 dist 에서 돌면 지금 버전으로 고정한 npx 명령으로 등록한다", () => {
    expect(launchCommand("file:///Users/u/.npm/_npx/abc/node_modules/jade-mcp/dist/setup.js")).toEqual(["npx", "-y", `jade-mcp@${version}`]);
  });

  it("clone 한 레포의 src 에서 돌면 레포 실행기 경로로 등록한다", () => {
    expect(launchCommand("file:///Users/u/jade-mcp/src/setup.js")).toEqual(["/Users/u/jade-mcp/bin/jade-mcp"]);
  });

  it("이름에 dist 가 들어간 다른 폴더는 패키지로 보지 않는다", () => {
    expect(launchCommand("file:///Users/u/my-dist/src/setup.js")).toEqual(["/Users/u/my-dist/bin/jade-mcp"]);
  });
});
