import { describe, expect, it, vi } from "vitest";
import type { JadeConfig } from "../src/config.js";
import { formatDoctor, runDoctor, type DoctorCheck, type DoctorDeps } from "../src/doctor.js";

const SECRET = "s3cret-비밀번호!";

const CONFIG: JadeConfig = {
  baseUrl: "https://jade.example.test",
  companyCode: "1000",
  userId: "user01",
  keychainService: "jade-mcp",
  fingerprint: "1a2b3c",
  userAgent: "UA",
};

function certError(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("tls"), { code }) });
}

function healthy(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    platform: "darwin",
    nodeVersion: "24.22.1",
    execArgv: ["--use-system-ca"],
    env: {},
    fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    configPath: "/Users/me/.config/jade-mcp/config.json",
    configExists: async () => true,
    loadConfig: async () => CONFIG,
    securityExists: async () => true,
    keychainHasPassword: async () => true,
    ...overrides,
  };
}

function check(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`점검 항목 ${id} 가 없다`);
  return found;
}

describe("runDoctor", () => {
  it("모두 갖춰지면 전부 ok 이고 준비 완료", async () => {
    const report = await runDoctor(healthy());
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ["os", "ok"],
      ["node", "ok"],
      ["system-ca", "ok"],
      ["security", "ok"],
      ["jade-reach", "ok"],
      ["account", "ok"],
    ]);
    expect(report.ready).toBe(true);
  });

  it("설정 파일의 baseUrl 로 접속을 확인한다", async () => {
    const urls: string[] = [];
    const fetchSpy = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 302 });
    }) as typeof fetch;
    const report = await runDoctor(healthy({ fetch: fetchSpy }));
    expect(urls).toEqual(["https://jade.example.test"]);
    expect(check(report.checks, "jade-reach").detail).toContain("HTTP 302");
  });

  it("설정이 없으면 기본 JADE 주소로 확인하고, 계정은 warn 이지만 준비 여부는 막지 않는다", async () => {
    const urls: string[] = [];
    const fetchSpy = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const report = await runDoctor(healthy({ fetch: fetchSpy, configExists: async () => false }));
    expect(urls).toEqual(["https://ehr.jadehr.co.kr"]);
    const account = check(report.checks, "account");
    expect(account.status).toBe("warn");
    expect(account.detail).toContain("계정 미설정 — 온보딩 필요");
    expect(account.fix).toBe("npx -y jade-mcp setup");
    expect(report.ready).toBe(true);
  });

  it("설정 값이 비었거나 JSON 이 깨졌으면 계정 warn — 깨진 본문은 옮기지 않는다", async () => {
    const missing = await runDoctor(healthy({ loadConfig: async () => Promise.reject(new Error("설정 파일(x)에 값이 비어 있다: userId")) }));
    expect(check(missing.checks, "account")).toMatchObject({ status: "warn" });
    expect(check(missing.checks, "account").detail).toContain("userId");

    const broken = await runDoctor(healthy({ loadConfig: async () => Promise.reject(new SyntaxError(`Unexpected token in JSON "${SECRET}"`)) }));
    expect(check(broken.checks, "account").status).toBe("warn");
    expect(JSON.stringify(broken)).not.toContain(SECRET);
  });

  it("Keychain 항목이 없으면 계정 warn", async () => {
    const asked: string[][] = [];
    const report = await runDoctor(
      healthy({
        keychainHasPassword: async (service, account) => {
          asked.push([service, account]);
          return false;
        },
      }),
    );
    expect(asked).toEqual([["jade-mcp", "user01"]]);
    expect(check(report.checks, "account").status).toBe("warn");
    expect(report.ready).toBe(true);
  });

  it("비밀번호 값은 결과 어디에도 담기지 않는다", async () => {
    // 주입한 확인 함수가 실수로 값을 들고 있어도 결과에는 존재 여부만 남는다
    const leaky = async () => SECRET.length > 0;
    const report = await runDoctor(healthy({ keychainHasPassword: leaky }));
    const text = JSON.stringify(report) + formatDoctor(report);
    expect(text).not.toContain(SECRET);
  });

  it("macOS 가 아니면 os fail 로 준비 안 됨", async () => {
    const report = await runDoctor(healthy({ platform: "linux" }));
    expect(check(report.checks, "os")).toMatchObject({ status: "fail" });
    expect(report.ready).toBe(false);
  });

  it.each([["24.22.0"], ["25.1.0"], ["24.22.1-rc.1"]])("Node %s 는 node fail", async (version) => {
    const report = await runDoctor(healthy({ nodeVersion: version }));
    const node = check(report.checks, "node");
    expect(node.status).toBe("fail");
    expect(node.detail).toContain("22.23.4");
    expect(report.ready).toBe(false);
  });

  it("실행기가 보안 Node 를 못 찾아 폴백했으면 그 사실을 알린다", async () => {
    const report = await runDoctor(healthy({ nodeVersion: "16.13.0", env: { JADE_MCP_NODE_FALLBACK: "1" } }));
    expect(check(report.checks, "node").detail).toContain("찾지 못해");
  });

  it("--use-system-ca 는 execArgv 나 NODE_OPTIONS 어느 쪽이든 인정하고, 없으면 warn", async () => {
    expect(check((await runDoctor(healthy({ execArgv: [], env: { NODE_OPTIONS: "--max-old-space-size=4096 --use-system-ca" } }))).checks, "system-ca").status).toBe("ok");
    const missing = await runDoctor(healthy({ execArgv: [], env: { NODE_OPTIONS: "--use-system-ca-x" } }));
    expect(check(missing.checks, "system-ca").status).toBe("warn");
    expect(missing.ready).toBe(true);
  });

  it("/usr/bin/security 가 없으면 fail", async () => {
    const report = await runDoctor(healthy({ securityExists: async () => false }));
    expect(check(report.checks, "security").status).toBe("fail");
    expect(report.ready).toBe(false);
  });

  it("인증서 오류는 코드와 system-ca 안내를 담아 fail", async () => {
    const report = await runDoctor(
      healthy({ execArgv: [], fetch: (async () => Promise.reject(certError("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"))) as typeof fetch }),
    );
    const reach = check(report.checks, "jade-reach");
    expect(reach.status).toBe("fail");
    expect(reach.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(reach.fix).toContain("--use-system-ca");
    expect(report.ready).toBe(false);
  });

  it("system-ca 를 켜고도 인증서 오류면 키체인 신뢰 등록을 안내한다", async () => {
    const report = await runDoctor(healthy({ fetch: (async () => Promise.reject(certError("SELF_SIGNED_CERT_IN_CHAIN"))) as typeof fetch }));
    expect(check(report.checks, "jade-reach").fix).toContain("키체인");
  });

  it("네트워크 오류는 원인 코드를 담아 fail", async () => {
    const report = await runDoctor(healthy({ fetch: (async () => Promise.reject(certError("ENOTFOUND"))) as typeof fetch }));
    const reach = check(report.checks, "jade-reach");
    expect(reach).toMatchObject({ status: "fail" });
    expect(reach.detail).toContain("ENOTFOUND");
  });

  it("5초 안에 응답이 없으면 끊고 fail", async () => {
    vi.useFakeTimers();
    try {
      const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as typeof fetch;
      const pending = runDoctor(healthy({ fetch: hanging }));
      await vi.advanceTimersByTimeAsync(5000);
      const reach = check((await pending).checks, "jade-reach");
      expect(reach.status).toBe("fail");
      expect(reach.detail).toContain("5초");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetch 가 없는 낡은 Node 에서도 죽지 않고 fail 로 보고한다", async () => {
    const report = await runDoctor(healthy({ fetch: undefined }));
    expect(check(report.checks, "jade-reach").status).toBe("fail");
  });
});

describe("formatDoctor", () => {
  it("상태별 표시와 고칠 방법을 줄로 낸다", () => {
    const text = formatDoctor({
      ready: false,
      checks: [
        { id: "os", status: "ok", label: "운영체제", detail: "macOS" },
        { id: "account", status: "warn", label: "JADE 계정", detail: "계정 미설정 — 온보딩 필요", fix: "npx -y jade-mcp setup" },
        { id: "node", status: "fail", label: "Node 버전", detail: "낡았다", fix: "nvm install 24" },
      ],
    });
    expect(text.split("\n")).toEqual([
      "✓ 운영체제: macOS",
      "! JADE 계정: 계정 미설정 — 온보딩 필요",
      "    → npx -y jade-mcp setup",
      "✗ Node 버전: 낡았다",
      "    → nvm install 24",
      "",
      "준비 안 됨 — ✗ 항목을 먼저 고쳐야 한다",
    ]);
  });

  it("점검이 비어 있어도 준비 줄은 낸다", () => {
    expect(formatDoctor({ ready: true, checks: [] })).toBe("\n준비 완료");
  });
});
