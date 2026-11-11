import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { storePasswordSilently } from "../account.js";
import { SYNC_KEY, SYNC_MARK, toGoogleEvent, type DesiredEvent, type ExistingEvent } from "./plan.js";

// 구글 캘린더 REST 와 OAuth(데스크톱 앱 + PKCE). refresh token 은 macOS Keychain 에만 둔다.

const run = promisify(execFile);
export const KEYCHAIN_SERVICE = "jade-mcp-gcal";
export const KEYCHAIN_ACCOUNT = "google-refresh-token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const AUTH_TIMEOUT_MS = 5 * 60_000;

export class GcalAuthError extends Error {}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

type Fetch = typeof fetch;

export async function loadOAuthClient(path: string): Promise<OAuthClient> {
  let json: { installed?: { client_id?: string; client_secret?: string } };
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new GcalAuthError(`구글 OAuth 클라이언트 파일을 읽지 못했다: ${path}`);
  }
  const c = json.installed;
  if (!c?.client_id || !c.client_secret) {
    throw new GcalAuthError(`${path} 는 데스크톱 앱 OAuth 클라이언트가 아니다 (JSON 최상위에 "installed" 가 있어야 한다)`);
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export async function readRefreshToken(): Promise<string> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // 아래 안내로 대신한다
  }
  throw new GcalAuthError("구글 캘린더 인증 정보가 없다 — `jade-mcp gcal auth` 를 먼저 실행해야 한다");
}

export async function hasRefreshToken(): Promise<boolean> {
  return run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]).then(
    () => true,
    () => false,
  );
}

async function saveRefreshToken(token: string): Promise<void> {
  // 명령줄 인자로 넘기면 실행 중 ps 에 토큰이 보인다 — JADE 비밀번호와 같은 표준입력 경로를 쓴다.
  await storePasswordSilently(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token).catch(() => {
    throw new Error("Keychain 에 구글 인증 정보를 저장하지 못했다");
  });
}

async function postToken(params: Record<string, string>, fetchImpl: Fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
  return { ok: res.ok, status: res.status, body };
}

export async function getAccessToken(client: OAuthClient, refreshToken: string, fetchImpl: Fetch = fetch): Promise<string> {
  const { ok, status, body } = await postToken(
    { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" },
    fetchImpl,
  );
  if (ok && body.access_token) return body.access_token;
  if (body.error === "invalid_grant") throw new GcalAuthError("구글 인증이 만료되거나 취소됐다 — `jade-mcp gcal auth` 를 다시 실행해야 한다");
  throw new Error(`구글 토큰 갱신 실패 (${status} ${body.error ?? ""})`.trim());
}

/** 브라우저로 구글 로그인을 받아 refresh token 을 Keychain 에 저장한다. */
export async function authorize(client: OAuthClient, log: (line: string) => void = console.log): Promise<void> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  let redirectUri = "";

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const received = url.searchParams.get("code");
      const ok = url.searchParams.get("state") === state && received;
      res
        .writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" })
        .end(ok ? "인증 완료 — 이 창을 닫아도 됩니다." : "인증 실패 — 터미널을 확인하세요.");
      clearTimeout(timer);
      server.close();
      if (ok) resolve(received);
      else reject(new GcalAuthError(`구글 인증 거부: ${url.searchParams.get("error") ?? "state 불일치"}`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new GcalAuthError("5분 안에 구글 로그인이 끝나지 않았다"));
    }, AUTH_TIMEOUT_MS);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      log(`브라우저에서 구글 로그인을 진행한다. 창이 안 열리면 아래 주소를 연다:\n${auth}\n`);
      execFile("open", [auth.toString()], () => {});
    });
  });

  const { ok, status, body } = await postToken(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetch,
  );
  if (!ok || !body.refresh_token) throw new GcalAuthError(`구글 토큰 발급 실패 (${status} ${body.error ?? "refresh_token 없음"})`);
  await saveRefreshToken(body.refresh_token);
}

export interface CalendarApi {
  listManaged(timeMin: string, timeMax: string): Promise<ExistingEvent[]>;
  insert(event: DesiredEvent): Promise<void>;
  update(id: string, event: DesiredEvent): Promise<void>;
  remove(id: string): Promise<void>;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export function createCalendarApi(accessToken: string, calendarId: string, fetchImpl: Fetch = fetch): CalendarApi {
  const eventsUrl = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;

  async function call(method: string, url: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 이미 지워진 일정을 다시 지우는 건 성공으로 본다.
    if (method === "DELETE" && (res.status === 404 || res.status === 410)) return null;
    if (!res.ok) throw new Error(`구글 캘린더 ${method} 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }

  return {
    async listManaged(timeMin, timeMax) {
      const events: ExistingEvent[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          privateExtendedProperty: `${SYNC_MARK}=1`,
          singleEvents: "true",
          maxResults: "250",
          timeMin,
          timeMax,
        });
        if (pageToken) params.set("pageToken", pageToken);
        const res = (await call("GET", `${eventsUrl}?${params}`)) as { items?: GoogleEvent[]; nextPageToken?: string };
        for (const e of res.items ?? []) {
          events.push({
            id: e.id,
            key: e.extendedProperties?.private?.[SYNC_KEY],
            summary: e.summary ?? "",
            start: e.start?.dateTime ?? e.start?.date,
            end: e.end?.dateTime ?? e.end?.date,
          });
        }
        pageToken = res.nextPageToken;
      } while (pageToken);
      return events;
    },
    async insert(event) {
      await call("POST", eventsUrl, toGoogleEvent(event));
    },
    async update(id, event) {
      await call("PATCH", `${eventsUrl}/${encodeURIComponent(id)}`, toGoogleEvent(event));
    },
    async remove(id) {
      await call("DELETE", `${eventsUrl}/${encodeURIComponent(id)}`);
    },
  };
}
