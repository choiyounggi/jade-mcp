import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { CONFIG_PATH, loadConfig, type JadeConfig } from "./config.js";

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ready: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  platform: string;
  nodeVersion: string;
  execArgv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** 낡은 Node(18 미만)에는 전역 fetch 가 없다 — 실행기가 진단만은 그런 Node 로도 돌린다. */
  fetch: typeof fetch | undefined;
  configPath: string;
  configExists: (path: string) => Promise<boolean>;
  loadConfig: (path: string) => Promise<JadeConfig>;
  securityExists: () => Promise<boolean>;
  /** 항목이 있는지만 답한다. 비밀번호 값은 돌려주지 않는다. */
  keychainHasPassword: (service: string, account: string) => Promise<boolean>;
}

interface NodeMin {
  isSecureNode(version: string): boolean;
  MIN_TEXT: string;
}

// src/ 와 dist/ 모두 패키지 루트 한 단계 아래라 같은 상대경로로 정본을 읽는다
const nodeMin = createRequire(import.meta.url)("../bin/node-min.cjs") as NodeMin;

const DEFAULT_BASE_URL = "https://ehr.jadehr.co.kr";
const REACH_TIMEOUT_MS = 5000;
const SECURITY_PATH = "/usr/bin/security";
const ONBOARDING = "계정 미설정 — 온보딩 필요";
const SETUP_COMMAND = "npx -y jade-mcp setup";

async function isExecutable(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

const defaultDeps: DoctorDeps = {
  platform: process.platform,
  nodeVersion: process.versions.node,
  execArgv: process.execArgv,
  env: process.env,
  fetch: globalThis.fetch,
  configPath: CONFIG_PATH,
  configExists: (path) => isExecutable(path, constants.R_OK),
  loadConfig,
  securityExists: () => isExecutable(SECURITY_PATH, constants.X_OK),
  // -w 없이 찾으면 비밀번호를 복호화하지 않아 값도 읽지 않고 키체인 접근 허용 창도 뜨지 않는다
  keychainHasPassword: (service, account) =>
    new Promise((resolve) => {
      execFile(SECURITY_PATH, ["find-generic-password", "-s", service, "-a", account], (error) => resolve(!error));
    }),
};

function checkOs(d: DoctorDeps): DoctorCheck {
  return d.platform === "darwin"
    ? { id: "os", status: "ok", label: "운영체제", detail: "macOS" }
    : { id: "os", status: "fail", label: "운영체제", detail: `macOS 전용이다 (현재 ${d.platform})`, fix: "macOS 에서 실행한다" };
}

function checkNode(d: DoctorDeps): DoctorCheck {
  if (nodeMin.isSecureNode(d.nodeVersion)) {
    return { id: "node", status: "ok", label: "Node 버전", detail: `Node ${d.nodeVersion}` };
  }
  const fallback = d.env.JADE_MCP_NODE_FALLBACK === "1" ? " — 보안 패치된 Node 를 찾지 못해 진단만 이 Node 로 돌렸다" : "";
  return {
    id: "node",
    status: "fail",
    label: "Node 버전",
    detail: `Node ${d.nodeVersion} 는 보안 패치가 빠졌다 (필요: ${nodeMin.MIN_TEXT})${fallback}`,
    fix: "nvm install 24 처럼 보안 패치된 Node 를 설치한다 (nvm·Homebrew 설치본은 실행기가 알아서 찾는다)",
  };
}

function hasSystemCa(d: DoctorDeps): boolean {
  return d.execArgv.includes("--use-system-ca") || (d.env.NODE_OPTIONS ?? "").split(/\s+/).includes("--use-system-ca");
}

function checkSystemCa(d: DoctorDeps): DoctorCheck {
  return hasSystemCa(d)
    ? { id: "system-ca", status: "ok", label: "시스템 인증서", detail: "macOS 시스템 CA 저장소를 쓴다 (--use-system-ca)" }
    : {
        id: "system-ca",
        status: "warn",
        label: "시스템 인증서",
        detail: "--use-system-ca 없이 돌고 있다 — 회사망이 TLS 를 검사하면 JADE 접속이 인증서 오류로 실패할 수 있다",
        fix: "npx jade-mcp 실행기로 띄우면 자동으로 붙는다 (직접 실행하면 node --use-system-ca 를 쓴다)",
      };
}

async function checkSecurity(d: DoctorDeps): Promise<DoctorCheck> {
  return (await d.securityExists())
    ? { id: "security", status: "ok", label: "Keychain 도구", detail: SECURITY_PATH }
    : {
        id: "security",
        status: "fail",
        label: "Keychain 도구",
        detail: `${SECURITY_PATH} 가 없다 — 비밀번호를 Keychain 에서 읽을 수 없다`,
        fix: "macOS 기본 도구라 OS 설치 상태를 확인한다",
      };
}

function causeCode(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

function isCertificateError(code: string): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS/.test(code);
}

async function checkReach(d: DoctorDeps, baseUrl: string): Promise<DoctorCheck> {
  const base = { id: "jade-reach", label: "JADE 접속" } as const;
  if (typeof d.fetch !== "function") {
    return { ...base, status: "fail", detail: `이 Node(${d.nodeVersion})에는 fetch 가 없어 접속을 확인하지 못했다`, fix: "보안 패치된 Node 를 설치한다" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACH_TIMEOUT_MS);
  try {
    const res = await d.fetch(baseUrl, { method: "GET", signal: controller.signal });
    // 본문은 필요 없다 — 소켓을 바로 놓아 준다
    await res.body?.cancel().catch(() => undefined);
    return { ...base, status: "ok", detail: `${baseUrl} 응답 HTTP ${res.status}` };
  } catch (e) {
    if (controller.signal.aborted) {
      return { ...base, status: "fail", detail: `${baseUrl} 가 ${REACH_TIMEOUT_MS / 1000}초 안에 응답하지 않았다`, fix: "네트워크·VPN·프록시를 확인한다" };
    }
    const code = causeCode(e);
    if (code && isCertificateError(code)) {
      return {
        ...base,
        status: "fail",
        detail: `${baseUrl} 인증서 검증 실패 (${code})`,
        fix: hasSystemCa(d)
          ? "회사망 TLS 검사 루트 인증서가 macOS 키체인에서 신뢰로 등록돼 있는지 확인한다"
          : "--use-system-ca 로 실행해 macOS 시스템 인증서를 쓰게 한다 (npx jade-mcp 실행기는 자동으로 붙인다)",
      };
    }
    return {
      ...base,
      status: "fail",
      detail: `${baseUrl} 에 연결하지 못했다 (${code ?? (e as Error).message})`,
      fix: "네트워크·VPN·프록시를 확인한다",
    };
  } finally {
    clearTimeout(timer);
  }
}

type AccountState = { config: JadeConfig; reason?: undefined } | { config?: undefined; reason: string };

async function readAccount(d: DoctorDeps): Promise<AccountState> {
  if (!(await d.configExists(d.configPath))) return { reason: `설정 파일 없음: ${d.configPath}` };
  try {
    return { config: await d.loadConfig(d.configPath) };
  } catch (e) {
    // loadConfig 는 경로와 빈 키 이름만 메시지에 담는다. JSON 파싱 오류는 본문 일부를 담을 수 있어 옮기지 않는다
    return { reason: e instanceof SyntaxError ? `설정 파일이 JSON 형식이 아니다: ${d.configPath}` : (e as Error).message };
  }
}

async function checkAccount(d: DoctorDeps, account: AccountState): Promise<DoctorCheck> {
  const base = { id: "account", label: "JADE 계정", fix: SETUP_COMMAND } as const;
  if (!account.config) return { ...base, status: "warn", detail: `${ONBOARDING} (${account.reason})` };
  const { keychainService, userId } = account.config;
  if (!(await d.keychainHasPassword(keychainService, userId))) {
    return { ...base, status: "warn", detail: `${ONBOARDING} (Keychain 에 비밀번호 항목이 없다: service=${keychainService})` };
  }
  return { id: "account", status: "ok", label: "JADE 계정", detail: `${userId} (회사코드 ${account.config.companyCode}) — Keychain 항목 있음` };
}

export async function runDoctor(deps: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  const d: DoctorDeps = { ...defaultDeps, ...deps };
  const account = await readAccount(d);
  const checks: DoctorCheck[] = [
    checkOs(d),
    checkNode(d),
    checkSystemCa(d),
    await checkSecurity(d),
    await checkReach(d, account.config?.baseUrl || DEFAULT_BASE_URL),
    await checkAccount(d, account),
  ];
  // 계정 미설정(warn)은 온보딩으로 풀리는 상태라 준비 여부를 막지 않는다
  return { ready: checks.every((c) => c.status !== "fail"), checks };
}

const MARKS: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.flatMap((c) => {
    const line = `${MARKS[c.status]} ${c.label}: ${c.detail}`;
    return c.fix && c.status !== "ok" ? [line, `    → ${c.fix}`] : [line];
  });
  lines.push("", report.ready ? "준비 완료" : "준비 안 됨 — ✗ 항목을 먼저 고쳐야 한다");
  return lines.join("\n");
}
