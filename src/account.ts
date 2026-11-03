import { spawn } from "node:child_process";
import { JadeClient, LoginError } from "./client.js";
import { readConfigIfAny, readKeychainPassword, saveConfig, type JadeConfig } from "./config.js";
import { fetchMainInfo, toTodayStatus, type TodayStatus } from "./features.js";
import { buildConfig } from "./setup.js";

/**
 * service·account 는 security -i 의 따옴표 안에 그대로 들어간다. 이스케이프 규칙을 맞추다 틀리면 명령이
 * 다른 인자로 쪼개지므로, 깨뜨릴 수 있는 문자는 아예 받지 않는다.
 */
function assertKeychainField(name: string, value: string): void {
  if (!value) throw new Error(`Keychain ${name} 이 비어 있다`);
  if (/["\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Keychain ${name} 에 쓸 수 없는 문자(따옴표·역슬래시·줄바꿈·제어문자)가 들어 있다`);
  }
}

/**
 * security -i 의 표준입력에 넣을 한 줄. 비밀번호는 -X(16진수)로 넣는다 — 따옴표·공백·$·\ 같은 문자를
 * 이스케이프할 필요가 없고, 명령줄 인자로 넘기지 않으니 ps 에도 보이지 않는다.
 */
export function keychainAddCommand(service: string, account: string, password: string): string {
  assertKeychainField("service", service);
  assertKeychainField("account", account);
  if (!password) throw new Error("비밀번호가 비어 있다");
  const hex = Buffer.from(password, "utf8").toString("hex");
  return `add-generic-password -U -s "${service}" -a "${account}" -X ${hex}\n`;
}

/** 명령을 실행하고 input 을 표준입력으로 넣은 뒤 종료 코드를 돌려준다. 출력은 버린다. */
export type StdinRunner = (command: string, args: string[], input: string) => Promise<number>;

const runWithStdin: StdinRunner = (command, args, input) =>
  new Promise((resolvePromise, reject) => {
    // security 는 실패할 때 입력 줄을 되풀이해 출력할 수 있어 stdout·stderr 를 읽지 않는다.
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

/** 비밀번호를 터미널 입력 없이 Keychain 에 넣는다(같은 service·account 가 있으면 바꾼다). */
export async function storePasswordSilently(
  service: string,
  account: string,
  password: string,
  run: StdinRunner = runWithStdin,
): Promise<void> {
  const command = keychainAddCommand(service, account, password);
  let code: number;
  try {
    code = await run("security", ["-i"], command);
  } catch {
    throw new Error("Keychain 저장 실패 (security 를 실행하지 못했다)");
  }
  if (code !== 0) throw new Error(`Keychain 저장 실패 (security 종료 코드 ${code})`);
}

export interface AccountInput {
  companyCode: string;
  userId: string;
  password: string;
  baseUrl?: string;
}

export interface SavedAccount {
  userId: string;
  workDate: string;
  clockIn: string;
  clockOut: string;
}

export interface SaveAccountDeps {
  readPrevious?: () => Promise<Partial<JadeConfig>>;
  createClient?: (config: JadeConfig, getPassword: () => Promise<string>) => JadeClient;
  storePassword?: (service: string, account: string, password: string) => Promise<void>;
  saveConfig?: (config: JadeConfig) => Promise<void>;
  readPassword?: (service: string, account: string) => Promise<string>;
}

const NETWORK_FAILURE = /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|CERT|certificate|HTTP \d{3}/i;

/**
 * 로그인 확인 실패를 사람이 읽을 말로 바꾼다. JADE 가 돌려준 문구에 비밀번호가 섞일 일은 없겠지만,
 * 섞여 있으면 원문을 버리고 일반 문구만 낸다 — 이 메시지는 브라우저와 Claude 대화로 나간다.
 */
function explainLoginFailure(e: unknown, config: JadeConfig, password: string): Error {
  const detail = e instanceof Error ? e.message : String(e);
  if (detail.includes(password)) return new Error("JADE 로그인에 실패했다 — 회사코드·아이디·비밀번호를 확인해 줘");
  if (NETWORK_FAILURE.test(detail)) {
    return new Error(`JADE(${config.baseUrl})에 접속하지 못했다 — 주소와 네트워크(VPN·사내망)를 확인해 줘 (${detail})`);
  }
  if (e instanceof LoginError) {
    if (/2차 인증|비밀번호 초기화|메인 화면/.test(detail)) return new Error(detail);
    return new Error(`JADE 로그인에 실패했다 — 회사코드·아이디·비밀번호를 확인해 줘 (${detail})`);
  }
  return new Error(`로그인을 확인하지 못했다 (${detail})`);
}

/**
 * 계정을 확인하고 저장한다. 입력한 비밀번호로 실제 로그인이 되는 것을 본 뒤에만 Keychain·설정 파일에 쓴다 —
 * 틀린 비밀번호가 기존 Keychain 값을 덮어쓰면 그때까지 되던 MCP 가 같이 망가진다.
 */
export async function saveAccount(input: AccountInput, deps: SaveAccountDeps = {}): Promise<SavedAccount> {
  if (!input.password) throw new Error("비밀번호가 비어 있다");
  const previous = await (deps.readPrevious ?? readConfigIfAny)();
  // 핑거프린트는 이전 값을 그대로 쓴다 — 바뀌면 JADE 가 새 기기 로그인으로 기록한다.
  const config = buildConfig(
    { companyCode: input.companyCode, userId: input.userId, baseUrl: input.baseUrl ?? "" },
    previous,
  );
  assertKeychainField("service", config.keychainService);
  assertKeychainField("account", config.userId);

  const createClient = deps.createClient ?? ((c, getPassword) => new JadeClient(c, getPassword));
  let today: TodayStatus;
  try {
    const client = createClient(config, async () => input.password);
    today = toTodayStatus(await fetchMainInfo(client));
  } catch (e) {
    throw explainLoginFailure(e, config, input.password);
  }

  await (deps.storePassword ?? storePasswordSilently)(config.keychainService, config.userId, input.password);
  // 저장 명령이 성공으로 끝나도 들어간 값이 다르면 이후 모든 로그인이 실패한다 — 되읽어 같을 때만 설정을 쓴다.
  let stored: string | undefined;
  try {
    stored = await (deps.readPassword ?? readKeychainPassword)(config.keychainService, config.userId);
  } catch {
    stored = undefined;
  }
  if (stored !== input.password) throw new Error("Keychain 에 저장한 비밀번호를 다시 읽어 확인하지 못했다 — 설정은 저장하지 않았다");
  await (deps.saveConfig ?? saveConfig)(config);
  return { userId: config.userId, workDate: today.workDate, clockIn: today.clockIn, clockOut: today.clockOut };
}
