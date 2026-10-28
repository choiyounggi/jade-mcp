import type { Params } from "./viewstate.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpResult {
  status: number;
  text: string;
}

/** 단일 호스트 전용 쿠키 저장소. JADE 는 세션 쿠키만 쓰므로 경로·도메인 구분은 하지 않는다. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  ingest(setCookies: string[]): void {
    for (const header of setCookies) {
      const [pair, ...attrs] = header.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
}

/** jQuery 와 같이 null·undefined 는 아예 보내지 않는다 (서버가 "null" 문자열로 받는 것을 피한다). */
export function encodeForm(params: Params): string {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.append(k, String(v));
  }
  return form.toString();
}

export class JadeHttp {
  readonly jar = new CookieJar();

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request(
    path: string,
    opts: { method?: "GET" | "POST"; form?: Params; ajax?: boolean } = {},
  ): Promise<HttpResult> {
    let url = new URL(path, this.baseUrl).toString();
    let method = opts.method ?? "GET";
    let body: string | undefined = opts.form ? encodeForm(opts.form) : undefined;

    for (let hop = 0; hop < 5; hop++) {
      // menuAction.do 는 Referer/Origin 이 없으면 "Not Invalid Access" 로 거부하고 세션을 로그아웃시킨다.
      const origin = new URL(this.baseUrl).origin;
      const headers: Record<string, string> = { "User-Agent": this.userAgent, Referer: `${origin}/`, Origin: origin };
      const cookie = this.jar.header();
      if (cookie) headers.Cookie = cookie;
      if (opts.ajax) headers.ajax = "true";
      if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";

      const res = await this.fetchImpl(url, { method, headers, body, redirect: "manual" });
      this.jar.ingest(res.headers.getSetCookie?.() ?? []);

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        method = "GET";
        body = undefined;
        continue;
      }
      return { status: res.status, text: await res.text() };
    }
    throw new Error("JADE 리다이렉트가 너무 많다");
  }
}
