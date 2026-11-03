import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(new URL("../bin/jade-mcp.cjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("./fixtures/launcher/entry.cjs", import.meta.url));

interface LaunchInput {
  platform: string;
  currentVersion: string;
  execPath: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  entry: string;
  findSecureNode: (env: NodeJS.ProcessEnv) => string | null;
}

interface LaunchPlan {
  node?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  notice?: string;
  exitCode?: number;
  message?: string;
}

const { planLaunch } = createRequire(import.meta.url)("../bin/jade-mcp.cjs") as { planLaunch(input: LaunchInput): LaunchPlan };

function input(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    platform: "darwin",
    currentVersion: "24.22.1",
    execPath: "/current/node",
    argv: ["/current/node", "/pkg/bin/jade-mcp.cjs"],
    env: { HOME: "/Users/me" },
    entry: "/pkg/dist/main.js",
    findSecureNode: () => {
      throw new Error("현재 Node 가 충분하면 찾지 않는다");
    },
    ...overrides,
  };
}

describe("planLaunch", () => {
  it("현재 Node 가 충분하면 그 Node 에 --use-system-ca 를 붙여 진입점을 실행한다", () => {
    const plan = planLaunch(input({ argv: ["/current/node", "/pkg/bin/jade-mcp.cjs", "doctor", "--x"] }));
    expect(plan).toEqual({ node: "/current/node", args: ["--use-system-ca", "/pkg/dist/main.js", "doctor", "--x"], env: { HOME: "/Users/me" } });
  });

  it("현재 Node 가 낡으면 찾은 보안 패치 Node 로 바꿔 실행한다", () => {
    const plan = planLaunch(input({ currentVersion: "24.8.0", findSecureNode: () => "/nvm/v24.22.1/bin/node" }));
    expect(plan.node).toBe("/nvm/v24.22.1/bin/node");
    expect(plan.args).toEqual(["--use-system-ca", "/pkg/dist/main.js"]);
  });

  it("macOS 가 아니면 실행하지 않고 종료코드 1", () => {
    const plan = planLaunch(input({ platform: "linux" }));
    expect(plan.exitCode).toBe(1);
    expect(plan.message).toContain("macOS 전용");
    expect(plan.node).toBeUndefined();
  });

  it("보안 패치 Node 가 없으면 최소 버전과 설치 안내를 내고 종료코드 1", () => {
    const plan = planLaunch(input({ currentVersion: "20.0.0", findSecureNode: () => null, argv: ["n", "s", "serve"] }));
    expect(plan.exitCode).toBe(1);
    expect(plan.message).toContain("22.23.4");
    expect(plan.message).toContain("nvm install 24");
    expect(plan.node).toBeUndefined();
  });

  it("보안 패치 Node 가 없어도 doctor 는 현재 Node 로 --use-system-ca 없이 돌리고 폴백을 알린다", () => {
    const plan = planLaunch(input({ currentVersion: "16.13.0", findSecureNode: () => null, argv: ["n", "s", "doctor"] }));
    expect(plan.node).toBe("/current/node");
    expect(plan.args).toEqual(["/pkg/dist/main.js", "doctor"]);
    expect(plan.env).toEqual({ HOME: "/Users/me", JADE_MCP_NODE_FALLBACK: "1" });
    expect(plan.notice).toContain("16.13.0");
  });

  it("프리릴리스 Node 는 낡은 것으로 보고 다른 설치본을 찾는다", () => {
    const plan = planLaunch(input({ currentVersion: "26.12.1-rc.1", findSecureNode: () => "/brew/node" }));
    expect(plan.node).toBe("/brew/node");
  });
});

// 실제 프로세스로 띄워 인자 전달·종료코드·stdout 오염을 확인한다 (vitest 를 돌리는 Node 는 보안 패치 버전이다)
function runLauncher(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { ...process.env, JADE_MCP_ENTRY: ENTRY, ...env },
  });
}

describe("bin/jade-mcp.cjs 실행", () => {
  it("인자를 그대로 넘기고 --use-system-ca 로 띄우며, stdout 에는 자식 출력만 남는다", () => {
    const result = runLauncher(["serve", "--flag", "값 공백"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ["serve", "--flag", "값 공백"], execArgv: ["--use-system-ca"], fallback: null });
    expect(result.stderr).toBe("");
  });

  it("자식의 종료코드를 그대로 돌려준다", () => {
    expect(runLauncher([], { LAUNCHER_TEST_EXIT: "3" }).status).toBe(3);
  });

  it("자식이 시그널로 끝나면 같은 시그널로 끝난다", () => {
    const result = runLauncher([], { LAUNCHER_TEST_SIGNAL: "SIGTERM" });
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
  });

  it("받은 SIGTERM 을 자식에게 넘기고 자식의 종료코드로 끝난다", async () => {
    const child = spawn(process.execPath, [LAUNCHER], { env: { ...process.env, JADE_MCP_ENTRY: ENTRY, LAUNCHER_TEST_WAIT: "1" } });
    let stdout = "";
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("\n")) resolve();
      });
    });
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
    expect(code).toBe(7);
    expect(stdout).toContain('"received":"SIGTERM"');
  });

  it("진입점이 없으면 Node 오류로 끝나며 stdout 은 비어 있다", () => {
    const result = runLauncher([], { JADE_MCP_ENTRY: "/nonexistent/jade-mcp/main.js" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
