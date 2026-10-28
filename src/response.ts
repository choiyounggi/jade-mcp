export type Row = Record<string, string>;

export interface JadeResponse {
  etc: Record<string, string>;
  datasets: Record<string, Row[]>;
}

export class SessionExpiredError extends Error {
  constructor() {
    super("JADE 세션이 만료되었다");
    this.name = "SessionExpiredError";
  }
}

export class JadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JadeError";
  }
}

/**
 * JSON 이 아닌 응답(대개 HTTP 500 오류 페이지). 세션이 죽은 채 암호 토큰으로 요청해도 이렇게 오고,
 * 요청 자체가 잘못돼도 이렇게 오므로 이것만으로는 둘을 구분할 수 없다.
 */
export class UnexpectedResponseError extends JadeError {
  constructor(status: number) {
    super(`JADE 가 JSON 이 아닌 응답을 돌려줬다 (HTTP ${status})`);
    this.name = "UnexpectedResponseError";
  }
}

function toRows(value: unknown): Row[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((r): r is Row => typeof r === "object" && r !== null);
}

/** S_FORWARD=xsheetResultJson 응답을 해석한다. 본문은 개인정보를 담으므로 에러 메시지에 싣지 않는다. */
export function parseJsonResponse(status: number, text: string): JadeResponse {
  let body: unknown;
  try {
    body = JSON.parse(text.trim());
  } catch {
    throw new UnexpectedResponseError(status);
  }
  if (typeof body !== "object" || body === null) {
    throw new JadeError(`JADE 응답 형식이 예상과 다르다 (HTTP ${status})`);
  }
  const record = body as Record<string, unknown>;

  const error = toRows(record.Msg)?.[0]?.Error;
  if (error) {
    if (error.startsWith("LOGIN_CHECK_FAIL")) throw new SessionExpiredError();
    throw new JadeError(`JADE 오류: ${error}`);
  }

  const etc: Record<string, string> = {};
  for (const row of toRows(record.Etc) ?? []) Object.assign(etc, row);

  const datasets: Record<string, Row[]> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "Msg" || key === "Etc") continue;
    const rows = toRows(value);
    if (rows) datasets[key] = rows;
  }
  return { etc, datasets };
}
