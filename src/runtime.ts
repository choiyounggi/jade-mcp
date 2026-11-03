import { createRequire } from "node:module";
import { JadeClient } from "./client.js";
import type { JadeConfig } from "./config.js";
import type { DoctorReport } from "./doctor.js";

/** 계정 설정이 없거나 Keychain 비밀번호가 없어 JADE 에 요청할 수 없는 상태. 온보딩으로 해결된다. */
export class NeedsOnboardingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NeedsOnboardingError";
  }
}

/** 보안 패치가 안 된 Node 로 돌고 있어 JADE 에 요청하지 않는다. 온보딩으로는 해결되지 않는다. */
export class UnsafeRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRuntimeError";
  }
}

// src/ 와 dist/ 모두 패키지 루트 한 단계 아래라 같은 상대경로로 최소 버전 정본을 읽는다
const nodeMin = createRequire(import.meta.url)("../bin/node-min.cjs") as { isSecureNode(version: string): boolean };

export interface RuntimeDeps {
  loadConfig: () => Promise<JadeConfig>;
  readPassword: (config: JadeConfig) => Promise<string>;
  /** 복호화 없이 Keychain 항목이 있는지. unknown(접근 거부 등)은 로그인 때 readPassword 가 원인을 알린다. */
  passwordState: (config: JadeConfig) => Promise<"present" | "missing" | "unknown">;
  nodeVersion?: string;
  runDoctor: () => Promise<DoctorReport>;
  startOnboarding: () => Promise<{ url: string; reused: boolean }>;
  env?: NodeJS.ProcessEnv;
  createClient?: (config: JadeConfig, getPassword: () => Promise<string>) => JadeClient;
}

export interface Runtime {
  /** 설정을 처음 쓸 때 읽어 클라이언트를 만든다. 계정이 없으면 NeedsOnboardingError. */
  getClient(): Promise<JadeClient>;
  /** 온보딩으로 계정이 바뀌면 다음 요청이 새 설정·비밀번호로 로그인하도록 버린다. */
  reset(): void;
  /** 온보딩 페이지를 열고(이미 열려 있으면 그 주소) Claude 가 사용자에게 전할 안내문을 만든다. */
  onboardingMessage(reason: string): Promise<string>;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const env = deps.env ?? process.env;
  const create = deps.createClient ?? ((config, getPassword) => new JadeClient(config, getPassword));
  let client: JadeClient | undefined;

  return {
    async getClient() {
      // TLS 검증이 보안 패치에 기대므로 패치 안 된 Node 로는 요청하지 않는다. 실행기를 거치지 않고 dist 를 직접 띄운 경우도 막는다.
      if (env.JADE_MCP_NODE_FALLBACK === "1" || !nodeMin.isSecureNode(deps.nodeVersion ?? process.versions.node)) {
        throw new UnsafeRuntimeError(
          `보안 패치된 Node 가 아니라 JADE 에 요청하지 않는다 (지금 Node ${deps.nodeVersion ?? process.versions.node}). ` +
            "Node 24.22.1 이상을 설치한 뒤(예: nvm install 24) Claude Code 를 다시 열어야 한다. 자세한 점검은 jade_doctor.",
        );
      }
      if (client) return client;
      let config: JadeConfig;
      try {
        config = await deps.loadConfig();
      } catch {
        throw new NeedsOnboardingError("계정 설정 파일이 없다");
      }
      if ((await deps.passwordState(config)) === "missing") throw new NeedsOnboardingError("Keychain 에 JADE 비밀번호가 없다");
      client = create(config, () => deps.readPassword(config));
      return client;
    },

    reset() {
      client = undefined;
    },

    async onboardingMessage(reason) {
      const report = await deps.runDoctor();
      const blockers = report.checks.filter((c) => c.status === "fail");
      const { url, reused } = await deps.startOnboarding();
      const lines = [
        `JADE 계정 설정이 필요하다 (${reason}).`,
        `${reused ? "이미 열어 둔" : "브라우저에 연"} 설정 페이지에서 사용자가 회사코드·아이디·비밀번호를 입력해야 한다: ${url}`,
        "비밀번호는 이 대화로 받지 말고 그 페이지에만 입력하게 안내한다. 페이지가 안 열렸으면 위 주소를 직접 연다.",
        "사용자가 저장을 마쳤다고 하면 같은 요청을 다시 한다.",
      ];
      if (blockers.length > 0) {
        lines.push("먼저 해결할 문제:", ...blockers.map((c) => `- ${c.label}: ${c.detail}${c.fix ? ` → ${c.fix}` : ""}`));
      }
      return lines.join("\n");
    },
  };
}
