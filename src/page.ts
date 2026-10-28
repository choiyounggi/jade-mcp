/** 화면 HTML 한 장에서 뽑아낸, 그 화면 안에서만 유효한 요청 재료. */
export interface PageContext {
  openTime: string;
  otpKey: string;
  csrfSalt: string;
  /** 화면이 개인정보 마스킹 전역변수를 선언했는지 — 선언된 화면만 해당 파라미터를 보낸다. */
  hasMaskingVars: boolean;
  page: Record<string, string>;
  inputs: Record<string, string>;
  otp: Record<string, Record<string, string>>;
}

export class PageStructureError extends Error {
  constructor(what: string) {
    super(`JADE 화면 구조가 예상과 달라 ${what} 를 찾지 못했다 — 요청을 보내지 않고 중단한다`);
    this.name = "PageStructureError";
  }
}

function readVar(html: string, name: string): string | undefined {
  return new RegExp(`var\\s+${name}\\s*=\\s*"([^"]*)"`).exec(html)?.[1];
}

function readStringProps(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) {
    const [, key, value] = m;
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

function readAttr(tag: string, attr: string): string | undefined {
  const m = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

export function parsePage(html: string): PageContext {
  const openTime = readVar(html, "S_PGM_OPEN_TIME");
  const otpKey = readVar(html, "S_ENC_OTP_KEY");
  const csrfSalt = readVar(html, "S_CSRF_SALT");
  if (openTime === undefined || otpKey === undefined || csrfSalt === undefined) {
    throw new PageStructureError("요청 보안값(S_PGM_OPEN_TIME/S_ENC_OTP_KEY/S_CSRF_SALT)");
  }

  const pageBlock = /\bPage\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(html)?.[1];
  const page = pageBlock ? readStringProps(pageBlock) : {};

  const otp: Record<string, Record<string, string>> = {};
  for (const m of html.matchAll(/var\s+(\w+OtpVal)\s*=\s*\{([\s\S]*?)\};?/g)) {
    const [, name, body] = m;
    if (name !== undefined && body !== undefined) otp[name] = readStringProps(body);
  }

  const inputs: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const key = readAttr(tag, "id") ?? readAttr(tag, "name");
    if (key) inputs[key] = readAttr(tag, "value") ?? "";
  }

  return {
    openTime,
    otpKey,
    csrfSalt,
    hasMaskingVars: /var\s+S_ENC_MASKING_USE_YN\s*=/.test(html),
    page,
    inputs,
    otp,
  };
}

/** 토큰이 없으면 예외 — 빈 메서드명으로 요청을 보내는 일이 없게 한다. */
export function otpToken(ctx: PageContext, map: string, key: string): string {
  const value = ctx.otp[map]?.[key];
  if (!value) throw new PageStructureError(`${map}.${key}`);
  return value;
}

export function inputValue(ctx: PageContext, id: string): string {
  const value = ctx.inputs[id];
  if (!value) throw new PageStructureError(`#${id}`);
  return value;
}

/** marker 가 들어 있는 switch 분기의 case 토큰. */
export function caseTokenOf(html: string, marker: string, what: string): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new PageStructureError(what);
  const token = [...html.slice(0, at).matchAll(/case\s+"([^"]+)"\s*:/g)].at(-1)?.[1];
  if (!token) throw new PageStructureError(what);
  return token;
}

/** anchor 뒤에서 처음 나오는 `ajaxSyncRequestXS($("#S_DSCLASS").val(), "<토큰>"` 의 토큰. */
export function callTokenAfter(html: string, anchor: string, what: string): string {
  const at = html.indexOf(anchor);
  if (at < 0) throw new PageStructureError(what);
  const token = /ajaxSyncRequestXS\(\$\("#S_DSCLASS"\)\.val\(\),\s*"([^"]+)"/.exec(html.slice(at))?.[1];
  if (!token) throw new PageStructureError(what);
  return token;
}
