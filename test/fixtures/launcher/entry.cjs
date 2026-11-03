"use strict";
// 실행기 테스트용 가짜 dist/main.js — 받은 인자·옵션을 stdout 에 JSON 한 줄로 내고 지시대로 끝난다.
process.stdout.write(
  JSON.stringify({
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
    fallback: process.env.JADE_MCP_NODE_FALLBACK || null,
  }) + "\n",
);
if (process.env.LAUNCHER_TEST_WAIT) {
  // 실행기가 받은 시그널을 넘겨주는지 본다 — 받으면 알리고 약속한 코드로 끝난다
  var timer = setInterval(function () {}, 1000);
  process.on("SIGTERM", function () {
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ received: "SIGTERM" }) + "\n");
    process.exitCode = 7;
  });
} else if (process.env.LAUNCHER_TEST_SIGNAL) {
  process.kill(process.pid, process.env.LAUNCHER_TEST_SIGNAL);
} else {
  process.exitCode = Number(process.env.LAUNCHER_TEST_EXIT || 0);
}
