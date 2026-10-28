import { describe, expect, it } from "vitest";
import { CookieJar, encodeForm, JadeHttp, type FetchLike } from "../src/http.js";

describe("CookieJar", () => {
  it("stores, overwrites and deletes cookies", () => {
    const jar = new CookieJar();
    jar.ingest(["JSESSIONID=a; Path=/; HttpOnly", "X=1"]);
    jar.ingest(["JSESSIONID=b; Path=/"]);
    expect(jar.header()).toBe("JSESSIONID=b; X=1");
    jar.ingest(["X=; Max-Age=0"]);
    expect(jar.header()).toBe("JSESSIONID=b");
  });

  it("ignores malformed headers", () => {
    const jar = new CookieJar();
    jar.ingest(["", "=novalue", "noequals"]);
    expect(jar.header()).toBe("");
  });
});

describe("encodeForm", () => {
  it("drops null and undefined like jQuery", () => {
    expect(encodeForm({ a: "1 2", b: null, c: undefined, d: 0 })).toBe("a=1+2&d=0");
  });
});

describe("JadeHttp", () => {
  it("follows redirects with GET and carries cookies across hops", async () => {
    const calls: { url: string; method?: string; cookie?: string }[] = [];
    const fake: FetchLike = async (url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method, cookie: headers.Cookie });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: [["location", "/next"], ["set-cookie", "S=1; Path=/"]] });
      }
      return new Response("ok", { status: 200 });
    };
    const http = new JadeHttp("https://jade.example", "UA", fake);
    const res = await http.request("/start", { method: "POST", form: { a: "1" } });
    expect(res).toEqual({ status: 200, text: "ok" });
    expect(calls[1]).toEqual({ url: "https://jade.example/next", method: "GET", cookie: "S=1" });
  });

  it("gives up on redirect loops", async () => {
    const loop: FetchLike = async () => new Response(null, { status: 302, headers: { location: "/again" } });
    await expect(new JadeHttp("https://jade.example", "UA", loop).request("/")).rejects.toThrow("리다이렉트");
  });
});
