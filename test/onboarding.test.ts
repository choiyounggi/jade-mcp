import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startOnboarding, stopOnboarding, type DoctorReport, type OnboardingDeps } from "../src/onboarding.js";

const PASSWORD = `pw "<b>" $X 한글`;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** fetch 는 Host·Origin 같은 헤더를 마음대로 못 바꾸므로 http.request 로 보낸다. */
function send(url: string, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function origin(url: string): string {
  return new URL(url).origin;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return send(url, {
    method: "POST",
    path: `${new URL(url).pathname}/save`,
    headers: { "Content-Type": "application/json", Origin: origin(url), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function closed(url: string): Promise<boolean> {
  return send(url).then(
    () => false,
    (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED",
  );
}

const okReport: DoctorReport = {
  ready: true,
  checks: [{ id: "node", status: "ok", label: "Node.js", detail: "v24.22.1" }],
};

function deps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    runDoctor: async () => okReport,
    saveAccount: async () => ({ userId: "user01", workDate: "20261103", clockIn: "09:01", clockOut: "" }),
    openBrowser: (url) => opened.push(url),
    opened,
    ...overrides,
  };
}

const account = { companyCode: "1000", userId: "user01", password: PASSWORD };

afterEach(() => {
  stopOnboarding();
});

describe("startOnboarding", () => {
  it("127.0.0.1 임의 포트에 토큰 주소로 띄우고 브라우저를 연다", async () => {
    const d = deps();
    const { url, reused } = await startOnboarding(d);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);
    expect(reused).toBe(false);
    expect(d.opened).toEqual([url]);
  });

  it("진행 중이면 같은 주소를 돌려주고 브라우저를 다시 열지 않는다", async () => {
    const d = deps();
    const first = await startOnboarding(d);
    const second = await startOnboarding(d);
    expect(second).toEqual({ url: first.url, reused: true });
    expect(d.opened).toHaveLength(1);
  });

  it("동시에 불려도 서버는 하나만 띄운다", async () => {
    const d = deps();
    const [a, b] = await Promise.all([startOnboarding(d), startOnboarding(d)]);
    expect(a.url).toBe(b.url);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
  });

  it("ttl 이 지나면 닫힌다", async () => {
    const { url } = await startOnboarding(deps({ ttlMs: 50 }));
    await vi.waitFor(async () => expect(await closed(url)).toBe(true), { timeout: 2000, interval: 20 });
    const next = await startOnboarding(deps());
    expect(next.reused).toBe(false);
    expect(next.url).not.toBe(url);
  });
});

describe("페이지", () => {
  it("폼과 점검 결과를 보안 헤더와 함께 준다", async () => {
    const { url } = await startOnboarding(deps());
    const res = await send(url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">`);
    expect(res.body).toContain('autocomplete="current-password"');
    expect(res.body).toContain('value="https://ehr.jadehr.co.kr"');
    expect(res.body).toContain("Node.js");
    expect(res.body).not.toMatch(/<(link|img)\b|src="http/);
  });

  it("요청마다 nonce 가 바뀐다", async () => {
    const { url } = await startOnboarding(deps());
    const a = await send(url);
    const b = await send(url);
    expect(a.headers["content-security-policy"]).not.toBe(b.headers["content-security-policy"]);
  });

  it("점검에 실패가 있으면 해결 방법을 폼보다 먼저 보여 주고 폼은 그대로 둔다", async () => {
    const report: DoctorReport = {
      ready: false,
      checks: [
        { id: "node", status: "fail", label: "Node.js 버전", detail: "v20 은 지원하지 않는다", fix: "brew upgrade node" },
        { id: "keychain", status: "warn", label: "Keychain", detail: "아직 비밀번호가 없다" },
      ],
    };
    const { url } = await startOnboarding(deps({ runDoctor: async () => report }));
    const { body } = await send(url);
    const fixAt = body.indexOf("brew upgrade node");
    expect(fixAt).toBeGreaterThan(0);
    expect(fixAt).toBeLessThan(body.indexOf('<form id="account"'));
    expect(body).toContain('name="password"');
  });

  it("점검 자체가 실패해도 폼은 보여 준다", async () => {
    const { url } = await startOnboarding(deps({ runDoctor: async () => Promise.reject(new Error("security 없음")) }));
    const { status, body } = await send(url);
    expect(status).toBe(200);
    expect(body).toContain("security 없음");
    expect(body).toContain('name="companyCode"');
  });

  it("동적 값은 모두 HTML 이스케이프한다", async () => {
    const evil = `"><img src=x onerror=alert(1)><script>alert(2)</script>`;
    const { url } = await startOnboarding(
      deps({
        runDoctor: async () => ({ ready: false, checks: [{ id: "x", status: "fail", label: evil, detail: evil, fix: evil }] }),
        prefill: async () => ({ companyCode: evil, userId: evil, baseUrl: evil }),
      }),
    );
    const { body } = await send(url);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("틀린 토큰·다른 경로는 404", async () => {
    const { url } = await startOnboarding(deps());
    const token = new URL(url).pathname.slice(1);
    const wrong = token.replace(/^./, (c) => (c === "a" ? "b" : "a"));
    expect((await send(url, { path: `/${wrong}` })).status).toBe(404);
    expect((await send(url, { path: "/" })).status).toBe(404);
    expect((await send(url, { path: `/${token}x` })).status).toBe(404);
    expect((await send(url, { path: `/${token}/other` })).status).toBe(404);
    expect((await send(url, { path: `/${token}/save` })).status).toBe(404);
  });

  it("Host 가 127.0.0.1:<포트> 가 아니면 403 (DNS 리바인딩)", async () => {
    const { url } = await startOnboarding(deps());
    const port = new URL(url).port;
    expect((await send(url, { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await send(url, { headers: { Host: `localhost:${port}` } })).status).toBe(403);
    expect((await send(url, { headers: { Host: "127.0.0.1" } })).status).toBe(403);
  });
});

describe("저장", () => {
  it("확인 중에 ttl 이 지나도 연결을 끊지 않고 결과를 돌려준 뒤 닫는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const saveAccount = vi.fn(async () => {
      await gate;
      return { userId: "user01", workDate: "20261103", clockIn: "09:01", clockOut: "" };
    });
    const { url } = await startOnboarding(deps({ ttlMs: 30, saveAccount }));
    const pending = post(url, account);
    await new Promise((r) => setTimeout(r, 80));
    release();
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).ok).toBe(true);
    await vi.waitFor(async () => expect(await closed(url)).toBe(true), { timeout: 2000, interval: 20 });
  });

  it("비밀번호가 256자를 넘으면 저장 함수를 부르지 않는다", async () => {
    const saveAccount = vi.fn(deps().saveAccount);
    const { url } = await startOnboarding(deps({ saveAccount }));
    const reply = await post(url, { ...account, password: "x".repeat(257) });
    expect(reply.status).toBe(400);
    expect(saveAccount).not.toHaveBeenCalled();
    expect((await post(url, { ...account, password: "x".repeat(256) })).status).toBe(200);
  });

  it("저장된 주소가 기본값과 다르면 고급 칸을 펼치고 경고한다", async () => {
    const { url } = await startOnboarding(deps({ prefill: async () => ({ baseUrl: "https://jade.attacker.example" }) }));
    const page = await send(url);
    expect(page.body).toMatch(/<details open>/);
    expect(page.body).toContain("기본값(https://ehr.jadehr.co.kr)과 다르다");
  });

  it("기본 주소면 고급 칸을 접어 두고 경고하지 않는다", async () => {
    const { url } = await startOnboarding(deps({ prefill: async () => ({ baseUrl: "https://ehr.jadehr.co.kr/" }) }));
    const page = await send(url);
    expect(page.body).toMatch(/<details>/);
    expect(page.body).not.toContain("기본값(");
  });

  it("Origin 이 없거나 다르면 403, 저장 함수를 부르지 않는다", async () => {
    const saveAccount = vi.fn(deps().saveAccount);
    const { url } = await startOnboarding(deps({ saveAccount }));
    const path = `${new URL(url).pathname}/save`;
    const noOrigin = await send(url, { method: "POST", path, headers: { "Content-Type": "application/json" }, body: JSON.stringify(account) });
    expect(noOrigin.status).toBe(403);
    expect((await post(url, account, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(url, account, { Origin: "null" })).status).toBe(403);
    expect((await post(url, account, { Origin: "http://localhost:" + new URL(url).port })).status).toBe(403);
    expect(saveAccount).not.toHaveBeenCalled();
  });

  it("JSON 이 아니면 415", async () => {
    const saveAccount = vi.fn(deps().saveAccount);
    const { url } = await startOnboarding(deps({ saveAccount }));
    expect((await post(url, "companyCode=1000", { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(url, JSON.stringify(account), { "Content-Type": "text/plain" })).status).toBe(415);
    expect(saveAccount).not.toHaveBeenCalled();
  });

  it("본문이 16KB 를 넘으면 413", async () => {
    const saveAccount = vi.fn(deps().saveAccount);
    const { url } = await startOnboarding(deps({ saveAccount }));
    const res = await post(url, { ...account, companyCode: "x".repeat(17 * 1024) });
    expect(res.status).toBe(413);
    expect(saveAccount).not.toHaveBeenCalled();
    // 상한 바로 아래는 받는다
    const ok = await post(url, { ...account, userId: "u".repeat(16 * 1024 - 200) });
    expect(ok.status).toBe(200);
  });

  it("깨진 JSON·빠진 값은 400", async () => {
    const { url } = await startOnboarding(deps());
    expect((await post(url, "{ not json")).status).toBe(400);
    const missing = await post(url, { companyCode: "1000", userId: "user01" });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body).message).toContain("비밀번호");
  });

  it("성공하면 결과를 돌려준 뒤 서버를 닫고 onSaved 를 부른다", async () => {
    const onSaved = vi.fn();
    const saveAccount = vi.fn(deps().saveAccount);
    const { url } = await startOnboarding(deps({ saveAccount, onSaved }));
    const res = await post(url, { ...account, baseUrl: " https://ehr.example.com " });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, userId: "user01", workDate: "20261103", clockIn: "09:01", clockOut: "" });
    expect(res.body).not.toContain(PASSWORD);
    expect(saveAccount).toHaveBeenCalledWith({ ...account, baseUrl: "https://ehr.example.com" });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(await closed(url)).toBe(true);
  });

  it("실패하면 400 과 메시지를 주고, 메시지에 비밀번호가 섞여 있으면 걸러 낸다", async () => {
    const { url } = await startOnboarding(
      deps({ saveAccount: async (input) => Promise.reject(new Error(`JADE 로그인에 실패했다 (${input.password})`)) }),
    );
    const res = await post(url, account);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).ok).toBe(false);
    expect(res.body).not.toContain(PASSWORD);
    expect(JSON.stringify(JSON.parse(res.body))).not.toContain(PASSWORD);
    expect(await closed(url)).toBe(false);
  });

  it("실패가 10회가 되면 서버를 닫는다", async () => {
    const saveAccount = vi.fn(async () => Promise.reject(new Error("JADE 로그인에 실패했다")));
    const onSaved = vi.fn();
    const { url } = await startOnboarding(deps({ saveAccount, onSaved }));
    for (let i = 1; i <= 9; i++) {
      const res = await post(url, account);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).closed).toBeUndefined();
    }
    const last = await post(url, account);
    expect(last.status).toBe(400);
    expect(JSON.parse(last.body)).toMatchObject({ ok: false, closed: true });
    await vi.waitFor(async () => expect(await closed(url)).toBe(true), { timeout: 2000, interval: 20 });
    expect(saveAccount).toHaveBeenCalledTimes(10);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("확인 중에 들어온 두 번째 요청은 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url } = await startOnboarding(
      deps({
        saveAccount: async () => {
          await gate;
          return { userId: "user01", workDate: "20261103", clockIn: "", clockOut: "" };
        },
      }),
    );
    const first = post(url, account);
    await new Promise((r) => setTimeout(r, 30));
    expect((await post(url, account)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});
