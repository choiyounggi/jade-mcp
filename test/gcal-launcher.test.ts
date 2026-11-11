import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildLauncherScript, GCAL_LAUNCHER_PATH, launcherCommand, launcherVersion } from "../src/gcal/env.js";

describe("launcherCommand", () => {
  it("레포 체크아웃이면 bin/jade-mcp 를 sh 로 실행한다", () => {
    expect(launcherCommand(["gcal", "sync"], "/repo/bin/jade-mcp")).toEqual(["/bin/sh", "/repo/bin/jade-mcp", "gcal", "sync"]);
  });

  it("npm 설치본이면 버전이 박힌 경로 대신 설정 폴더의 스크립트를 가리킨다", () => {
    const args = launcherCommand(["gcal", "sync"], null);
    expect(args).toEqual(["/bin/sh", GCAL_LAUNCHER_PATH, "gcal", "sync"]);
    expect(args.some((a) => a.includes("_npx") || a.includes("/versions/node/"))).toBe(false);
  });
});

describe("buildLauncherScript", () => {
  it("고정 버전을 npx 로 실행하고 인자를 그대로 넘긴다", () => {
    const script = buildLauncherScript("0.4.0");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("JADE_MCP_VERSION=0.4.0");
    expect(script).toContain('exec "$NPX" -y --prefer-offline "jade-mcp@$JADE_MCP_VERSION" "$@"');
    expect(script).toContain('"${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin/npx');
  });

  it("sh 문법 검사를 통과한다", () => {
    expect(() => execFileSync("/bin/sh", ["-n"], { input: buildLauncherScript("0.4.0") })).not.toThrow();
  });

  it("launcherVersion 은 스크립트의 고정 버전을 읽고, 형식이 다르면 undefined", () => {
    expect(launcherVersion(buildLauncherScript("1.2.3"))).toBe("1.2.3");
    expect(launcherVersion("#!/bin/sh\necho hi\n")).toBeUndefined();
    expect(launcherVersion("")).toBeUndefined();
  });
});
