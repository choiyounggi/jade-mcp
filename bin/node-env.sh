# bin/jade-mcp 와 bin/jade-mcp-setup 이 source 한다. 보안 패치가 들어간 node 실행 파일 경로를 고른다.
#
# 최소 버전은 TLS 인증서 호스트 검사 우회(CVE-2026-105483·106069·106072)와 Brotli 메모리 오류
# (CVE-2026-111497)가 고쳐진 버전이다 — JADE 와의 HTTPS 검증이 이 패치에 기댄다.
# 다음 보안 릴리스가 나오면 아래 값과 package.json engines 를 함께 올린다.
JADE_NODE_MIN="22.23.4 / 24.22.1 / 26.12.1 이상 (23·25 는 지원 종료)"

jade_node_ok() {
  ver=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  case "$ver" in
    *[!0-9.]*) return 1 ;; # 프리릴리스(-rc 등)는 쓰지 않는다
  esac
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  patch=${rest#*.}
  case "$major" in
    22) need_minor=23 need_patch=4 ;;
    24) need_minor=22 need_patch=1 ;;
    26) need_minor=12 need_patch=1 ;;
    *) [ "$major" -gt 26 ]; return ;;
  esac
  [ "$minor" -gt "$need_minor" ] || { [ "$minor" -eq "$need_minor" ] && [ "$patch" -ge "$need_patch" ]; }
}

# 조건에 맞는 node 경로를 stdout 에 한 줄로 낸다(MCP stdio 를 더럽히지 않도록 안내는 모두 stderr).
# PATH 의 node 를 먼저 보고, 낮으면 nvm·Homebrew 설치본 중 가장 새 것을 찾는다 — MCP 클라이언트는 PATH 가 짧을 수 있다.
jade_find_node() {
  nvm_dir=${NVM_DIR:-$HOME/.nvm}
  candidates=$(
    command -v node 2>/dev/null
    ls -d "$nvm_dir"/versions/node/v*/bin/node 2>/dev/null | sort -V -r
    ls -d /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node 2>/dev/null | sort -V -r
    echo /opt/homebrew/bin/node
    echo /usr/local/bin/node
  )
  # 경로에 공백이 있어도 한 줄을 한 후보로 본다
  old_ifs=$IFS
  IFS='
'
  for candidate in $candidates; do
    if [ -x "$candidate" ] && jade_node_ok "$candidate"; then
      IFS=$old_ifs
      echo "$candidate"
      return 0
    fi
  done
  IFS=$old_ifs
  echo "jade-mcp: 보안 패치된 Node 가 없다 — Node $JADE_NODE_MIN 을 설치해야 한다 (예: nvm install 24)" >&2
  return 1
}
