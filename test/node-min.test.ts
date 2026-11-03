import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface FindDeps {
  isExecutable(file: string): boolean;
  listDir(dir: string): string[];
  versionOf(node: string): string | null;
}

const nodeMin = createRequire(import.meta.url)("../bin/node-min.cjs") as {
  isSecureNode(version: string): boolean;
  MIN_TEXT: string;
  findSecureNode(env: NodeJS.ProcessEnv, deps?: FindDeps): string | null;
};

describe("isSecureNode", () => {
  it.each([
    ["22.23.4", true],
    ["22.24.0", true],
    ["24.22.1", true],
    ["24.23.0", true],
    ["26.12.1", true],
    ["27.0.0", true],
    ["30.1.2", true],
  ])("%s 는 보안 패치가 들어간 버전이다", (version, expected) => {
    expect(nodeMin.isSecureNode(version)).toBe(expected);
  });

  it.each([
    ["22.23.3"],
    ["22.22.9"],
    ["23.11.0"],
    ["24.22.0"],
    ["24.8.0"],
    ["25.9.9"],
    ["26.12.0"],
    ["20.99.99"],
    ["16.13.0"],
  ])("%s 는 패치 이전이거나 지원 종료 계열이라 거른다", (version) => {
    expect(nodeMin.isSecureNode(version)).toBe(false);
  });

  it.each([["24.22.1-rc.1"], ["27.0.0-nightly2026"], ["v24.22.1"], ["24.22"], [""], ["garbage"], ["24.22.1\n"]])(
    "프리릴리스·형식이 다른 문자열 %j 는 받지 않는다",
    (version) => {
      expect(nodeMin.isSecureNode(version)).toBe(false);
    },
  );

  it("안내 문구가 최소 버전을 모두 담는다", () => {
    expect(nodeMin.MIN_TEXT).toContain("22.23.4");
    expect(nodeMin.MIN_TEXT).toContain("24.22.1");
    expect(nodeMin.MIN_TEXT).toContain("26.12.1");
  });
});

function fakeFs(nodes: Record<string, string | null>, dirs: Record<string, string[]>): FindDeps & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    isExecutable: (file) => file in nodes,
    listDir: (dir) => dirs[dir] ?? [],
    versionOf: (node) => {
      probed.push(node);
      return nodes[node] ?? null;
    },
  };
}

describe("findSecureNode", () => {
  const env = { PATH: "/usr/bin:/custom/bin", HOME: "/Users/me" };

  it("PATH 의 node 가 충분하면 그것을 고른다", () => {
    const deps = fakeFs({ "/custom/bin/node": "24.22.1", "/Users/me/.nvm/versions/node/v26.12.1/bin/node": "26.12.1" }, {
      "/Users/me/.nvm/versions/node": ["v26.12.1"],
    });
    expect(nodeMin.findSecureNode(env, deps)).toBe("/custom/bin/node");
  });

  it("PATH 의 node 가 낡으면 nvm 설치본을 최신 버전부터 본다", () => {
    const nvm = "/Users/me/.nvm/versions/node";
    const deps = fakeFs(
      {
        "/custom/bin/node": "24.8.0",
        [`${nvm}/v9.0.0/bin/node`]: "9.0.0",
        [`${nvm}/v22.23.4/bin/node`]: "22.23.4",
        [`${nvm}/v24.22.1/bin/node`]: "24.22.1",
        [`${nvm}/v26.1.0/bin/node`]: "26.1.0",
      },
      { [nvm]: ["v22.23.4", "v24.22.1", "v26.1.0", "v9.0.0", ".cache"] },
    );
    expect(nodeMin.findSecureNode(env, deps)).toBe(`${nvm}/v24.22.1/bin/node`);
    // 26.1.0 은 버전이 더 크지만 패치 이전이라 건너뛰고, v9 는 v22 보다 뒤에 본다
    expect(deps.probed).toEqual(["/custom/bin/node", `${nvm}/v26.1.0/bin/node`, `${nvm}/v24.22.1/bin/node`]);
  });

  it("NVM_DIR 이 있으면 그 경로를 쓰고, 다음으로 Homebrew 의 node@N 을 큰 번호부터 본다", () => {
    const deps = fakeFs(
      {
        "/opt/homebrew/opt/node@22/bin/node": "22.23.4",
        "/opt/homebrew/opt/node@24/bin/node": "24.22.0",
        "/usr/local/opt/node@26/bin/node": "26.12.1",
      },
      {
        "/elsewhere/nvm/versions/node": [],
        "/opt/homebrew/opt": ["node@22", "node@24", "openssl@3"],
        "/usr/local/opt": ["node@26"],
      },
    );
    expect(nodeMin.findSecureNode({ PATH: "", HOME: "/Users/me", NVM_DIR: "/elsewhere/nvm" }, deps)).toBe("/usr/local/opt/node@26/bin/node");
  });

  it("고정 경로 /opt/homebrew/bin/node 까지 보고, 맞는 것이 없으면 null", () => {
    expect(nodeMin.findSecureNode({ PATH: "" , HOME: "/Users/me" }, fakeFs({ "/opt/homebrew/bin/node": "25.0.0", "/usr/local/bin/node": "24.22.1" }, {}))).toBe(
      "/usr/local/bin/node",
    );
    expect(nodeMin.findSecureNode({ PATH: "", HOME: "/Users/me" }, fakeFs({ "/opt/homebrew/bin/node": "25.0.0" }, {}))).toBeNull();
  });

  it("버전 확인이 실패한 후보(null)는 건너뛴다", () => {
    const deps = fakeFs({ "/custom/bin/node": null, "/usr/local/bin/node": "22.23.4" }, {});
    expect(nodeMin.findSecureNode(env, deps)).toBe("/usr/local/bin/node");
  });
});
