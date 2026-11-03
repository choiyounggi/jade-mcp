#!/usr/bin/env node
"use strict";
// npx 가 고른 Node 가 낡았어도 「Node 를 올려라」를 말해야 하므로 Node 12 가 파싱하는 문법만 쓴다.
// MCP 서버는 stdout 으로 프로토콜을 주고받는다 — 이 실행기는 stdout 에 아무것도 쓰지 않고 안내는 전부 stderr 로 낸다.

var path = require("path");
var spawn = require("child_process").spawn;
var nodeMin = require("./node-min.cjs");

var INSTALL_HINT = "보안 패치된 Node 를 설치한 뒤 다시 실행한다 (예: nvm install 24)";

// 어떤 Node 로 무엇을 실행할지 정한다. 부수효과가 없어 테스트가 입력만 바꿔 분기를 확인한다.
function planLaunch(input) {
  if (input.platform !== "darwin") {
    return { exitCode: 1, message: "jade-mcp: macOS 전용이다 — 비밀번호를 macOS Keychain 에 보관한다 (현재 " + input.platform + ")" };
  }
  var args = input.argv.slice(2);
  var node = nodeMin.isSecureNode(input.currentVersion) ? input.execPath : input.findSecureNode(input.env);
  if (node) {
    // MCP 클라이언트는 서버를 최소 환경변수로 띄워 NODE_EXTRA_CA_CERTS 가 빠진다.
    // 회사망 TLS 검사 인증서를 신뢰하도록 macOS 시스템 CA 저장소를 쓴다.
    return { node: node, args: ["--use-system-ca", input.entry].concat(args), env: input.env };
  }
  if (args[0] === "doctor") {
    // 진단은 Node 문제일 때 가장 필요하다 — 낡은 Node 라도 그대로 돌려 결과를 보여 준다.
    // --use-system-ca 는 22.15 미만에 없는 옵션이라 붙이지 않는다.
    var env = {};
    for (var key in input.env) env[key] = input.env[key];
    env.JADE_MCP_NODE_FALLBACK = "1";
    return {
      node: input.execPath,
      args: [input.entry].concat(args),
      env: env,
      notice: "jade-mcp: 보안 패치된 Node 를 찾지 못해 현재 Node(" + input.currentVersion + ")로 진단만 실행한다",
    };
  }
  return {
    exitCode: 1,
    message:
      "jade-mcp: 보안 패치된 Node 가 없다 — Node " + nodeMin.MIN_TEXT + " 이 필요하다 (현재 " + input.currentVersion + ")\n" +
      "jade-mcp: " + INSTALL_HINT,
  };
}

function run(plan) {
  if (plan.message) {
    // process.exit 은 macOS 파이프로 가는 stderr 를 다 쓰기 전에 끊을 수 있어 exitCode 로 끝낸다
    process.stderr.write(plan.message + "\n");
    process.exitCode = plan.exitCode;
    return;
  }
  if (plan.notice) process.stderr.write(plan.notice + "\n");

  var child = spawn(plan.node, plan.args, { stdio: "inherit", env: plan.env });
  var forward = function (signal) {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  child.on("error", function (e) {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
    process.stderr.write("jade-mcp: Node 를 실행하지 못했다 (" + plan.node + "): " + e.message + "\n");
    process.exitCode = 1;
  });
  child.on("exit", function (code, signal) {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
    if (signal) {
      // 자식이 시그널로 끝났으면 같은 시그널로 끝나 부모(MCP 클라이언트·셸)가 원인을 그대로 본다
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

if (require.main === module) {
  run(
    planLaunch({
      platform: process.platform,
      currentVersion: process.versions.node,
      execPath: process.execPath,
      argv: process.argv,
      env: process.env,
      // 테스트가 가짜 진입점을 끼우는 자리다 — 기본은 패키지에 든 빌드 결과
      entry: process.env.JADE_MCP_ENTRY || path.join(__dirname, "..", "dist", "main.js"),
      findSecureNode: nodeMin.findSecureNode,
    }),
  );
}

module.exports = { planLaunch: planLaunch };
