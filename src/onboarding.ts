import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AccountInput, SavedAccount } from "./account.js";
import type { DoctorCheck, DoctorReport } from "./doctor.js";

export type { DoctorCheck, DoctorReport };


export interface OnboardingDeps {
  runDoctor: () => Promise<DoctorReport>;
  saveAccount: (input: AccountInput) => Promise<SavedAccount>;
  openBrowser?: (url: string) => void;
  ttlMs?: number;
  onSaved?: () => void;
  /** 폼에 미리 채울 값(이전 설정). 비밀번호는 받지 않는다. */
  prefill?: () => Promise<Partial<Pick<AccountInput, "companyCode" | "userId" | "baseUrl">>>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ATTEMPTS = 10;
const DEFAULT_BASE_URL = "https://ehr.jadehr.co.kr";

interface Session {
  server: Server;
  url: string;
  timer: NodeJS.Timeout;
}

let session: Session | undefined;
let starting: Promise<Session> | undefined;

function openInBrowser(url: string): void {
  try {
    const child = spawn("open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 열지 못해도 url 을 결과로 돌려주므로 사용자가 직접 열 수 있다.
  }
}

/**
 * 계정 입력용 로컬 페이지를 띄운다. 이미 떠 있으면 그 주소를 돌려주고 브라우저를 다시 열지 않는다 —
 * 도구가 여러 번 불려도 탭이 쌓이지 않게 하려는 것이다.
 */
export async function startOnboarding(deps: OnboardingDeps): Promise<{ url: string; reused: boolean }> {
  if (session) return { url: session.url, reused: true };
  if (starting) return { url: (await starting).url, reused: true };
  starting = launch(deps).finally(() => {
    starting = undefined;
  });
  const started = await starting;
  (deps.openBrowser ?? openInBrowser)(started.url);
  return { url: started.url, reused: false };
}

export function stopOnboarding(): void {
  if (session) closeServer(session.server);
}

/** 지금 세션이 아닌 서버(ttl 로 이미 닫히고 새 세션이 뜬 뒤 끝난 요청)여도 그 서버만 닫는다. */
function closeServer(server: Server): void {
  if (session?.server === server) {
    clearTimeout(session.timer);
    session = undefined;
  }
  server.close();
  server.closeAllConnections();
}

async function launch(deps: OnboardingDeps): Promise<Session> {
  const token = randomBytes(24).toString("hex");
  const tokenBytes = Buffer.from(token);
  let attempts = 0;
  let busy = false;
  // 확인 중에 ttl 이 지나면 닫기를 미룬다 — 연결을 끊어도 저장은 끝까지 진행돼, 사용자는 실패로 보는데 실제로는 저장되는 일이 생긴다.
  let expired = false;
  let port = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: "로컬 설정 서버 내부 오류" });
      else res.destroy();
    });
  });

  const tokenMatches = (candidate: string) => {
    const bytes = Buffer.from(candidate);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 다른 사이트가 자기 도메인을 127.0.0.1 로 돌려(DNS 리바인딩) 이 서버를 부르면 Host 가 그 도메인이 된다.
    if (req.headers.host !== `127.0.0.1:${port}`) return sendJson(res, 403, { ok: false, message: "허용되지 않은 주소" });
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const [first = "", ...rest] = path.slice(1).split("/");
    if (!tokenMatches(first)) return sendJson(res, 404, { ok: false, message: "없는 페이지" });

    if (rest.length === 0 && req.method === "GET") return sendPage(res, deps);
    if (rest.length === 1 && rest[0] === "save" && req.method === "POST") return save(req, res);
    return sendJson(res, 404, { ok: false, message: "없는 페이지" });
  }

  async function save(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== `http://127.0.0.1:${port}`) {
      return sendJson(res, 403, { ok: false, message: "이 페이지에서 보낸 요청이 아니다" });
    }
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return sendJson(res, 415, { ok: false, message: "JSON 으로 보내야 한다" });
    if (busy) return sendJson(res, 409, { ok: false, message: "이미 확인 중이다 — 끝날 때까지 기다려 줘" });

    busy = true;
    try {
      const body = await readBody(req);
      if (body === undefined) return sendJson(res, 413, { ok: false, message: "요청이 너무 크다" }, true);
      const input = parseInput(body);
      if (typeof input === "string") return sendJson(res, 400, { ok: false, message: input });

      attempts++;
      try {
        const saved = await deps.saveAccount(input);
        sendJson(res, 200, { ok: true, ...saved }, true, () => {
          closeServer(server);
          try {
            deps.onSaved?.();
          } catch {
            // 저장은 끝났다. 알림 실패가 응답을 바꾸지 않게 한다.
          }
        });
      } catch (e) {
        const message = safeMessage(e, input.password);
        if (attempts >= MAX_ATTEMPTS) {
          sendJson(res, 400, { ok: false, message: `${message}\n시도 횟수(${MAX_ATTEMPTS}회)를 넘어 이 페이지를 닫았다 — Claude Code 에 다시 요청해 새 페이지를 열어 줘`, closed: true }, true, () => closeServer(server));
        } else {
          sendJson(res, 400, { ok: false, message });
        }
      }
    } finally {
      busy = false;
      if (expired) {
        if (res.writableFinished) closeServer(server);
        else res.once("finish", () => closeServer(server));
      }
    }
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  // MCP 프로세스가 끝날 때 이 서버 때문에 기다리지 않게 한다.
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("로컬 설정 서버의 포트를 알 수 없다");
  port = address.port;

  const timer = setTimeout(() => {
    if (busy) expired = true;
    else closeServer(server);
  }, deps.ttlMs ?? DEFAULT_TTL_MS);
  timer.unref();
  session = { server, url: `http://127.0.0.1:${port}/${token}`, timer };
  return session;
}

/** 상한을 넘으면 undefined. 넘는 순간 읽기를 멈추고 나머지는 버린다. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    req.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const MAX_PASSWORD_LENGTH = 256;

function parseInput(body: string): AccountInput | string {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return "요청 본문이 JSON 이 아니다";
  }
  if (!raw || typeof raw !== "object") return "요청 본문이 비어 있다";
  const { companyCode, userId, password, baseUrl } = raw as Record<string, unknown>;
  if (typeof companyCode !== "string" || !companyCode.trim()) return "회사코드를 입력해 줘";
  if (typeof userId !== "string" || !userId.trim()) return "아이디를 입력해 줘";
  if (typeof password !== "string" || !password) return "비밀번호를 입력해 줘";
  if (password.length > MAX_PASSWORD_LENGTH) return `비밀번호가 너무 길다 (${MAX_PASSWORD_LENGTH}자 이하)`;
  if (baseUrl !== undefined && typeof baseUrl !== "string") return "JADE 주소가 올바르지 않다";
  return { companyCode, userId, password, ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}) };
}

/** 브라우저로 나가는 메시지에 입력한 비밀번호가 섞이면 원문 대신 일반 문구를 낸다. */
function safeMessage(e: unknown, password: string): string {
  const message = e instanceof Error && e.message ? e.message : "저장하지 못했다";
  return message.includes(password) ? "저장하지 못했다 — 입력값을 확인해 줘" : message;
}

function securityHeaders(nonce: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

function sendJson(res: ServerResponse, status: number, body: object, close = false, after?: () => void): void {
  const headers: Record<string, string> = {
    ...securityHeaders(randomBytes(16).toString("base64")),
    "Content-Type": "application/json; charset=utf-8",
  };
  if (close) headers.Connection = "close";
  res.writeHead(status, headers);
  res.end(JSON.stringify(body), after);
}

async function sendPage(res: ServerResponse, deps: OnboardingDeps): Promise<void> {
  const [report, prefill] = await Promise.all([
    deps.runDoctor().then(
      (r) => ({ report: r }),
      (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
    ),
    (deps.prefill?.() ?? Promise.resolve({})).catch(() => ({})),
  ]);
  const nonce = randomBytes(16).toString("base64");
  res.writeHead(200, { ...securityHeaders(nonce), "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage(report, prefill, nonce));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STATUS_TEXT: Record<DoctorCheck["status"], string> = { ok: "통과", warn: "주의", fail: "실패" };

function renderChecks(result: { report: DoctorReport } | { error: string }): string {
  if ("error" in result) {
    return `<p class="note bad">환경 점검을 하지 못했다 — ${escapeHtml(result.error)}. 계정 저장은 그대로 할 수 있다.</p>`;
  }
  const fails = result.report.checks.filter((c) => c.status === "fail");
  const fixes = fails.length
    ? `<section class="fixes" aria-labelledby="fix-title">
  <h2 id="fix-title">먼저 해결할 것</h2>
  <ol>${fails
    .map((c) => `<li><strong>${escapeHtml(c.label)}</strong><span>${escapeHtml(c.fix ?? c.detail)}</span></li>`)
    .join("")}</ol>
</section>`
    : "";
  const rows = result.report.checks
    .map(
      (c) => `<li class="check ${c.status}"><span class="tag">${STATUS_TEXT[c.status]}</span><span class="what">${escapeHtml(c.label)}</span><span class="detail">${escapeHtml(c.detail)}</span></li>`,
    )
    .join("");
  return `${fixes}
<section class="checks" aria-labelledby="check-title">
  <h2 id="check-title">이 맥 점검 결과</h2>
  ${rows ? `<ul>${rows}</ul>` : `<p class="note">점검 항목이 없다.</p>`}
</section>`;
}

function renderPage(
  doctor: { report: DoctorReport } | { error: string },
  prefill: Partial<Pick<AccountInput, "companyCode" | "userId" | "baseUrl">>,
  nonce: string,
): string {
  const value = (v: string | undefined) => escapeHtml(v ?? "");
  const customBaseUrl = !!prefill.baseUrl && prefill.baseUrl.replace(/\/+$/, "") !== DEFAULT_BASE_URL;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JADE 계정 연결</title>
<style>
:root {
  color-scheme: light dark;
  --h: 262;
  --paper: oklch(96.8% 0.011 var(--h));
  --surface: oklch(99.2% 0.005 var(--h));
  --ink: oklch(22% 0.035 var(--h));
  --ink-soft: oklch(46% 0.03 var(--h));
  --line: oklch(87% 0.016 var(--h));
  --accent: oklch(50% 0.16 var(--h));
  --on-ink: oklch(97% 0.01 var(--h));
  --ok: oklch(52% 0.11 150);
  --warn: oklch(58% 0.12 75);
  --bad: oklch(52% 0.16 25);
  --bad-wash: oklch(95% 0.03 25);
  --ok-wash: oklch(95% 0.035 150);
  --font-body: "Apple SD Gothic Neo", "AppleGothic", system-ui, sans-serif;
  --font-mono: ui-monospace, Menlo, Monaco, monospace;
  --s1: .25rem; --s2: .5rem; --s3: 1rem; --s4: 1.5rem; --s5: 2.5rem; --s6: 4rem;
  --radius: 6px;
  --ease: cubic-bezier(.2, .6, .3, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: oklch(16% 0.018 var(--h));
    --surface: oklch(19% 0.02 var(--h));
    --ink: oklch(92% 0.015 var(--h));
    --ink-soft: oklch(70% 0.02 var(--h));
    --line: oklch(31% 0.022 var(--h));
    --accent: oklch(74% 0.12 var(--h));
    --on-ink: oklch(16% 0.018 var(--h));
    --ok: oklch(74% 0.12 150);
    --warn: oklch(80% 0.12 75);
    --bad: oklch(72% 0.14 25);
    --bad-wash: oklch(24% 0.04 25);
    --ok-wash: oklch(24% 0.04 150);
  }
  body { font-weight: 350; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--paper);
  color: var(--ink);
  font: 1rem/1.6 var(--font-body);
}
main {
  max-width: 34rem;
  margin: 0 auto 0 max(var(--s3), 9vw);
  padding: var(--s6) var(--s3) var(--s5) 0;
}
.eyebrow { margin: 0 0 var(--s2); font: .78rem/1.4 var(--font-mono); color: var(--ink-soft); letter-spacing: .02em; }
h1 { margin: 0; font-size: clamp(2.1rem, 8vw, 3.2rem); line-height: 1.1; font-weight: 800; letter-spacing: -.03em; font-style: normal; }
.lede { margin: var(--s3) 0 var(--s5); color: var(--ink-soft); max-width: 30rem; }
h2 { margin: 0 0 var(--s2); font-size: .82rem; font-weight: 700; letter-spacing: .04em; color: var(--ink-soft); }
section { margin-bottom: var(--s5); }
ul, ol { margin: 0; padding: 0; list-style: none; }
.checks li {
  display: grid;
  grid-template-columns: 3.2rem minmax(0, 1fr);
  gap: 0 var(--s2);
  padding: var(--s2) 0;
  border-top: 1px solid var(--line);
}
.checks li:last-child { border-bottom: 1px solid var(--line); }
.tag { font: 700 .75rem/1.9 var(--font-mono); }
.check.ok .tag { color: var(--ok); }
.check.warn .tag { color: var(--warn); }
.check.fail .tag { color: var(--bad); }
.what { font-weight: 600; }
.detail { grid-column: 2; color: var(--ink-soft); font-size: .88rem; overflow-wrap: anywhere; }
.fixes { padding: var(--s3); background: var(--bad-wash); border-left: 3px solid var(--bad); border-radius: 0 var(--radius) var(--radius) 0; }
.fixes h2 { color: var(--bad); }
.fixes li { display: grid; gap: var(--s1); padding: var(--s2) 0; overflow-wrap: anywhere; }
.fixes li + li { border-top: 1px solid var(--line); }
.fixes span { font-size: .9rem; white-space: pre-wrap; }
form { padding: var(--s4) 0 0; border-top: 3px solid var(--ink); }
fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
label { display: block; margin-bottom: var(--s3); font-weight: 600; font-size: .92rem; }
input {
  display: block;
  width: 100%;
  margin-top: var(--s1);
  padding: .7rem .8rem;
  font: 1rem/1.3 var(--font-body);
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: border-color .15s var(--ease);
}
input:hover { border-color: var(--ink-soft); }
input:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:disabled { opacity: .55; cursor: not-allowed; }
details { margin: 0 0 var(--s4); font-size: .9rem; }
summary { cursor: pointer; color: var(--ink-soft); min-height: 24px; }
details label { margin-top: var(--s3); }
.hint { display: block; margin-top: var(--s1); font-weight: 400; font-size: .8rem; color: var(--ink-soft); }
.hint.warn { color: var(--warn); font-weight: 600; }
button {
  min-height: 2.9rem;
  padding: 0 var(--s4);
  font: 700 1rem/1 var(--font-body);
  color: var(--on-ink);
  background: var(--ink);
  border: 0;
  border-radius: var(--radius);
  cursor: pointer;
  transition: opacity .15s var(--ease);
}
button:hover { opacity: .88; }
button:active { opacity: .75; }
button:disabled { opacity: .45; cursor: progress; }
.status { min-height: 1.6rem; margin: var(--s3) 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.status[data-state="busy"] { color: var(--ink-soft); }
.status[data-state="error"] { color: var(--bad); font-weight: 600; }
.done { padding: var(--s4); background: var(--ok-wash); border-left: 3px solid var(--ok); border-radius: 0 var(--radius) var(--radius) 0; }
.done strong { display: block; font-size: 1.35rem; font-weight: 800; letter-spacing: -.01em; }
#done-today { font-variant-numeric: tabular-nums; }
.note { color: var(--ink-soft); font-size: .88rem; }
.note.bad { color: var(--bad); }
footer { margin-top: var(--s5); color: var(--ink-soft); font-size: .8rem; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
<p class="eyebrow">jade-mcp · 이 맥 안에서만 열리는 설정 페이지</p>
<h1>JADE 계정 연결</h1>
<p class="lede">JADE 에 실제로 로그인해 본 뒤에만 저장한다. 비밀번호는 macOS Keychain 에만 들어가고 Claude 대화나 설정 파일에는 남지 않는다.</p>
${renderChecks(doctor)}
<form id="account" novalidate>
  <fieldset id="fields">
    <label>회사코드
      <input name="companyCode" autocomplete="organization" required value="${value(prefill.companyCode)}">
      <span class="hint">JADE 로그인 화면에 넣는 회사코드</span>
    </label>
    <label>아이디
      <input name="userId" autocomplete="username" autocapitalize="off" spellcheck="false" required value="${value(prefill.userId)}">
    </label>
    <label>비밀번호
      <input name="password" type="password" autocomplete="current-password" required>
    </label>
    <details${customBaseUrl ? " open" : ""}>
      <summary>고급 — JADE 주소</summary>${customBaseUrl ? `
      <p class="hint warn">저장된 주소가 기본값(${value(DEFAULT_BASE_URL)})과 다르다. 비밀번호는 이 주소로 전송되니 회사 JADE 주소가 맞는지 확인한다.</p>` : ""}
      <label>JADE 주소
        <input name="baseUrl" type="url" inputmode="url" autocapitalize="off" spellcheck="false" value="${value(prefill.baseUrl || DEFAULT_BASE_URL)}">
        <span class="hint">회사가 따로 쓰는 주소가 있을 때만 바꾼다</span>
      </label>
    </details>
    <button type="submit" id="submit">로그인 확인 후 저장</button>
  </fieldset>
  <p class="status" id="status" role="status" aria-live="polite"></p>
</form>
<section class="done" id="done" hidden aria-live="polite">
  <strong>저장했다</strong>
  <p id="done-today"></p>
  <p>Claude Code 로 돌아가 요청을 다시 하면 된다. 이 창은 닫아도 된다.</p>
</section>
<footer>이 페이지는 일정 시간이 지나거나 저장이 끝나면 닫힌다.</footer>
</main>
<script nonce="${nonce}">
(() => {
  const form = document.getElementById("account");
  const fields = document.getElementById("fields");
  const button = document.getElementById("submit");
  const status = document.getElementById("status");
  const setStatus = (state, text) => {
    status.dataset.state = state;
    status.textContent = text;
  };
  const day = (v) => /^\\d{8}$/.test(v) ? v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6) : v;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const data = new FormData(form);
    const body = {
      companyCode: String(data.get("companyCode") || ""),
      userId: String(data.get("userId") || ""),
      password: String(data.get("password") || ""),
      baseUrl: String(data.get("baseUrl") || ""),
    };
    if (!body.companyCode.trim() || !body.userId.trim() || !body.password) {
      setStatus("error", "회사코드·아이디·비밀번호를 모두 넣어 줘");
      return;
    }
    button.disabled = true;
    button.textContent = "확인하는 중…";
    setStatus("busy", "JADE 에 로그인해 보는 중이다. 몇 초 걸린다.");
    try {
      // 페이지의 Referrer-Policy(no-referrer) 를 따르면 브라우저가 Origin 을 null 로 보낸다. 서버는 Origin 을 확인한다.
      const res = await fetch(location.pathname + "/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        referrerPolicy: "same-origin",
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({ ok: false, message: "응답을 읽지 못했다 (HTTP " + res.status + ")" }));
      if (json.ok) {
        form.elements.password.value = "";
        form.hidden = true;
        document.getElementById("done-today").textContent =
          "오늘(" + day(json.workDate || "") + ") 출근 " + (json.clockIn || "기록 없음") + " · 퇴근 " + (json.clockOut || "기록 없음");
        document.getElementById("done").hidden = false;
        return;
      }
      setStatus("error", json.message || "저장하지 못했다");
      if (json.closed) {
        fields.disabled = true;
        return;
      }
    } catch {
      setStatus("error", "설정 서버에 닿지 못했다 — 페이지가 닫혔을 수 있다. Claude Code 에 다시 요청해 새 페이지를 열어 줘");
      fields.disabled = true;
      return;
    }
    button.disabled = false;
    button.textContent = "로그인 확인 후 저장";
  });
})();
</script>
</body>
</html>
`;
}
