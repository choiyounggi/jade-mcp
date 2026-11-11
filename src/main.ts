import { createRequire } from "node:module";

// 패키지의 단일 진입점이다. 서버 모드는 stdout 이 MCP 프로토콜 통로라 안내·사용법은 stderr 로만 낸다.
const USAGE = `사용법: jade-mcp [serve | setup | doctor | gcal | --version]
  serve     MCP 서버 실행 (기본값 — Claude Code 가 띄운다)
  setup     JADE 계정 설정과 Claude Code 등록
  doctor    실행 환경 점검
  gcal      근태(휴가·재택·출장 등)를 구글 캘린더에 동기화 — jade-mcp gcal 로 사용법 확인`;

const command = process.argv[2];

switch (command) {
  case undefined:
  case "serve":
    await import("./index.js");
    break;
  case "doctor": {
    const { formatDoctor, runDoctor } = await import("./doctor.js");
    const report = await runDoctor();
    console.log(formatDoctor(report));
    if (!report.ready) process.exitCode = 1;
    break;
  }
  case "setup": {
    const { runSetup } = await import("./setup.js");
    try {
      await runSetup();
    } catch (e) {
      console.error(`설정 실패: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    break;
  }
  case "gcal": {
    const { runGcalCommand } = await import("./gcal/cli.js");
    await runGcalCommand(process.argv.slice(3));
    break;
  }
  case "--version":
  case "version": {
    // src/ 와 dist/ 모두 패키지 루트 한 단계 아래다
    const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
    console.log(version);
    break;
  }
  default:
    console.error(`알 수 없는 명령: ${command}\n${USAGE}`);
    process.exitCode = 2;
}
