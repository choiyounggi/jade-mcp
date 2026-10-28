import { createHash } from "node:crypto";

export type ParamValue = string | number | boolean | null | undefined;
export type Params = Record<string, ParamValue>;

// JADE 의 common.js toCheckString 과 같은 목록이어야 서버의 무결성 검사를 통과한다.
const HASHED_KEY = /EMP_ID|ORG_ID|C_CD|AUTH|APPL/;

/** jsSHA("SHA-256", { numRounds: 3 }) 와 같은 값 — 다이제스트 바이트를 다시 해시한다. */
export function calcHash(input: string, rounds = 3): string {
  let digest = createHash("sha256").update(input, "utf8").digest();
  for (let i = 1; i < rounds; i++) {
    digest = createHash("sha256").update(digest).digest();
  }
  return digest.toString("hex");
}

function hashPart(value: ParamValue): string {
  if (value === undefined || value === null) return "";
  return encodeURIComponent(String(value).replace(/ |,|\s/gi, ""))
    .replace(/\W/gi, "")
    .replace("　", "");
}

/**
 * JADE 가 모든 요청에 붙이는 __viewState 를 만든다.
 * 키 순서가 해시 입력 순서이므로 호출자는 브라우저와 같은 순서로 params 를 구성해야 한다.
 */
export function toJsonString(params: Params): string {
  let order = "";
  let hash = "";
  for (const key of Object.keys(params)) {
    if (key === "__viewState" || key === "undefined") continue;
    if (!HASHED_KEY.test(key)) continue;
    order += `${key},`;
    hash += hashPart(params[key]);
  }
  return `{"order":"${order}", "hash":"${calcHash(hash)}", "test":"${hash}"}`;
}
