"use strict";
// 보안 패치된 Node 판정의 정본이다. 실행기(bin/jade-mcp.cjs)와 doctor(src/doctor.ts)가 함께 쓴다.
// 실행기는 오래된 Node 에서도 「Node 를 올려라」를 말해야 하므로 Node 12 가 파싱하는 문법만 쓴다
// (?.·??·클래스 필드 금지).
//
// 최소 버전은 TLS 인증서 호스트 검사 우회(CVE-2026-105483·106069·106072)와 Brotli 메모리 오류
// (CVE-2026-111497)가 고쳐진 버전이다 — JADE 와의 HTTPS 검증이 이 패치에 기댄다.
// 값을 올릴 때는 bin/node-env.sh 와 package.json engines 를 함께 올린다.

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

var MINIMUMS = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1],
};
// MINIMUMS 의 마지막 계열보다 큰 메이저는 모두 받는다 — 그 사이 홀수 메이저(23·25)는 지원 종료라 거른다.
var LAST_LISTED_MAJOR = 26;

var MIN_TEXT = "22.23.4 / 24.22.1 / 26.12.1 이상 (23·25 는 지원 종료)";

function isSecureNode(version) {
  // 프리릴리스(-rc 등)·빌드 메타데이터가 붙은 버전은 쓰지 않는다
  var match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  var major = Number(match[1]);
  var minor = Number(match[2]);
  var patch = Number(match[3]);
  var need = MINIMUMS[major];
  if (!need) return major > LAST_LISTED_MAJOR;
  return minor > need[0] || (minor === need[0] && patch >= need[1]);
}

function versionParts(text) {
  var match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return [-1, -1, -1];
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

// 경로 속 버전(v24.22.1·node@24)이 큰 것부터 — sort -V -r 과 같은 순서
function newestFirst(paths, versionSegment) {
  return paths.slice().sort(function (a, b) {
    var va = versionParts(versionSegment(a));
    var vb = versionParts(versionSegment(b));
    for (var i = 0; i < 3; i++) {
      if (va[i] !== vb[i]) return vb[i] - va[i];
    }
    return 0;
  });
}

var defaultDeps = {
  isExecutable: function (file) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch (e) {
      return false;
    }
  },
  listDir: function (dir) {
    try {
      return fs.readdirSync(dir);
    } catch (e) {
      return [];
    }
  },
  versionOf: function (node) {
    try {
      return childProcess
        .execFileSync(node, ["-p", "process.versions.node"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10000,
        })
        .trim();
    } catch (e) {
      return null;
    }
  },
};

function candidateNodes(env, deps) {
  var candidates = [];
  var pathDirs = String(env.PATH || "").split(path.delimiter);
  for (var i = 0; i < pathDirs.length; i++) {
    if (!pathDirs[i]) continue;
    var onPath = path.join(pathDirs[i], "node");
    if (deps.isExecutable(onPath)) {
      candidates.push(onPath);
      break; // command -v 처럼 PATH 의 첫 node 만 본다
    }
  }

  var home = env.HOME || os.homedir();
  var nvmVersions = path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node");
  var nvmNodes = deps
    .listDir(nvmVersions)
    .filter(function (name) {
      return /^v\d/.test(name);
    })
    .map(function (name) {
      return path.join(nvmVersions, name, "bin", "node");
    });
  candidates = candidates.concat(
    newestFirst(nvmNodes, function (p) {
      return path.basename(path.dirname(path.dirname(p)));
    }),
  );

  var brewNodes = [];
  ["/opt/homebrew/opt", "/usr/local/opt"].forEach(function (optDir) {
    deps.listDir(optDir).forEach(function (name) {
      if (/^node@\d/.test(name)) brewNodes.push(path.join(optDir, name, "bin", "node"));
    });
  });
  candidates = candidates.concat(
    newestFirst(brewNodes, function (p) {
      return path.basename(path.dirname(path.dirname(p))).replace(/^node@/, "");
    }),
  );

  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  return candidates;
}

// MCP 클라이언트는 서버를 짧은 PATH 로 띄우므로 PATH 밖의 nvm·Homebrew 설치본까지 본다.
// 찾지 못하면 null — 안내는 호출한 쪽이 stderr 로 낸다.
function findSecureNode(env, deps) {
  var d = deps || defaultDeps;
  var candidates = candidateNodes(env || process.env, d);
  var seen = {};
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (seen[candidate]) continue;
    seen[candidate] = true;
    if (!d.isExecutable(candidate)) continue;
    var version = d.versionOf(candidate);
    if (version && isSecureNode(version)) return candidate;
  }
  return null;
}

module.exports = {
  isSecureNode: isSecureNode,
  MIN_TEXT: MIN_TEXT,
  findSecureNode: findSecureNode,
};
