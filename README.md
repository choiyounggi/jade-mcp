# jade-mcp

JADE eHR(`ehr.jadehr.co.kr`)을 Claude Code 같은 MCP 클라이언트에서 쓸 수 있게 해 주는 **로컬 MCP 서버**입니다.
「오늘 출근 몇 시에 찍혔어?」, 「다음 달 근무일정 09:00~20:00으로 바꿔 줘」, 「11/6 오후 반차 올려 줘」처럼 말로 요청하면 JADE 화면과 같은 요청을 대신 보냅니다.

- 계정 정보는 **내 맥에만** 저장됩니다. 비밀번호는 macOS Keychain에 들어가고, JADE 서버 말고는 어디에도 보내지 않습니다.
- 브라우저를 띄우지 않고 JADE 화면이 보내는 HTTP 요청을 그대로 재현합니다.
- 기록·신청처럼 되돌리기 어려운 작업은 항상 **준비(미리보기) → 승인 → 실행** 두 단계로 나뉩니다.

> JADE 공식 도구가 아닙니다. JADE 화면 구조가 바뀌면 동작하지 않을 수 있고, 그럴 때는 요청을 보내지 않고 멈추도록 만들었습니다.

## 빠른 시작

```sh
git clone https://github.com/choiyounggi/jade-mcp.git && cd jade-mcp
npm ci
bin/jade-mcp-setup                                     # 회사코드·아이디 입력, 비밀번호는 Keychain 에 저장
claude mcp add jade -s user -- "$(pwd)/bin/jade-mcp"   # Claude Code 에 등록
```

Claude Code 를 다시 열고 「오늘 출근 시간 알려 줘」라고 요청해 보세요.

## 할 수 있는 일

| 도구 | 하는 일 | 종류 |
|---|---|---|
| `jade_today` | 오늘 근무일, 출근·퇴근 시각, 근무시간 | 조회 |
| `jade_vacation_balance` | 연차 발생·사용·잔여 | 조회 |
| `jade_recent_applications` | 메인 화면의 최근 신청서와 결재 상태 | 조회 |
| `jade_prepare_punch` → `jade_commit_punch` | 출근·퇴근 기록 | 쓰기 |
| `jade_prepare_vacation` → `jade_commit_vacation` | 휴가 신청서 상신 (시간 단위, 하루 안의 시각 범위 — 반차 등) | 쓰기 |
| `jade_prepare_condolence` → `jade_commit_condolence` | 생일반차(오전·오후) 상신 | 쓰기 |
| `jade_prepare_schedule` → `jade_commit_schedule` | 근태현황 > 일정등록: 한 달의 근무 가능일자 계획 시각을 일괄 변경 | 쓰기 |

쓰기 도구의 동작:

1. `prepare` 가 JADE 화면과 같은 순서로 값을 채우고 **서버 검증까지 통과시킨 뒤** 미리보기와 5분짜리 일회용 토큰을 돌려줍니다. 이 단계에서는 아무것도 저장하지 않습니다.
2. 미리보기를 확인하고 승인하면 `commit` 이 그 토큰으로 실제 저장·상신을 합니다. 실행 직전에 서버 검증을 한 번 더 합니다.

`commit` 도구에는 MCP `destructiveHint` 표시가 붙어 있습니다. Claude Code는 MCP 도구를 실행하기 전에 허용 여부를 묻는데, **`commit` 도구는 「항상 허용」으로 두지 마세요.** 미리보기를 보고 한 건씩 승인하는 것이 이 구조의 안전장치입니다.

## 준비물

- macOS (비밀번호를 Keychain에 저장하고, 회사망 인증서를 시스템 인증서 저장소에서 읽습니다)
- Node.js 22 이상
- JADE 계정 (2차 인증이 꺼져 있어야 합니다)
- 브라우저는 필요 없습니다. 실행 중에 브라우저를 띄우지 않습니다.
- 출근·퇴근 기록은 JADE에 등록된 IP(회사 네트워크)에서만 저장됩니다.

## 설치

```sh
git clone https://github.com/choiyounggi/jade-mcp.git
cd jade-mcp
npm ci
```

## 계정 설정

터미널에서 직접 실행합니다. 비밀번호를 입력해야 하기 때문입니다.

```sh
bin/jade-mcp-setup
```

묻는 항목은 다음과 같습니다. 대괄호 안의 값은 엔터만 치면 그대로 쓰는 기본값입니다.

| 항목 | 넣을 값 |
|---|---|
| JADE 주소 | 기본값 `https://ehr.jadehr.co.kr` |
| 회사코드 | JADE 로그인 화면의 「회사코드」 칸에 넣는 값 |
| 아이디 | JADE 로그인 아이디 |
| 브라우저 핑거프린트 | 선택. JADE에 로그인한 브라우저의 개발자도구 콘솔에서 `getJadeFP()` 를 실행한 결과. 비우면 임의 값을 만들어 계속 씁니다 |
| 비밀번호 | macOS `security` 의 입력창에 두 번 입력. 이 프로그램은 비밀번호를 받지 않고, `security` 가 바로 Keychain에 넣습니다 |

설정이 끝나면 실제로 로그인해서 오늘 출퇴근 정보를 보여 주고, Claude Code 등록 명령을 알려 줍니다.

- 설정 파일: `~/.config/jade-mcp/config.json` (권한 600, 비밀번호는 들어가지 않습니다)
- 비밀번호: Keychain 항목 `jade-mcp` / 계정명 = JADE 아이디
- 비밀번호를 바꿨다면 `bin/jade-mcp-setup --password` 로 다시 저장합니다.

## Claude Code에 등록

```sh
claude mcp add jade -s user -- "$(pwd)/bin/jade-mcp"
```

등록한 뒤 Claude Code를 다시 열고 `/mcp` 에서 `jade` 가 연결됐는지 확인합니다.

다른 MCP 클라이언트에서는 `bin/jade-mcp` 를 stdio 서버로 실행하도록 등록하면 됩니다.

## 요청 예시

- 「오늘 출근 시간이랑 연차 잔여 알려 줘」
- 「퇴근 찍어 줘」 → 미리보기 확인 → 승인
- 「11/6 금요일 오후 반차 올려 줘. 10시 출근 기준이야」 → 15:00~19:00, 4시간으로 미리보기 → 승인
- 「11/20 생일 오후 반차 올려 줘」
- 「다음 달 근무일정 09:00~20:00으로 바꿔 줘」 → 주말·휴일을 뺀 근무 가능일자 전체

## 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)` | 회사망의 TLS 검사 인증서를 신뢰하지 못한 경우입니다. `bin/jade-mcp` 로 실행하면 `--use-system-ca` 로 시스템 인증서를 씁니다. Node 22 이상인지 확인하세요 |
| `설정 파일 ... 이 없다` | `bin/jade-mcp-setup` 을 먼저 실행하세요 |
| `Keychain 에서 JADE 비밀번호를 찾지 못했다` | `bin/jade-mcp-setup --password` 로 비밀번호를 다시 저장하세요 |
| `2차 인증이 켜진 계정` | 2차 인증 계정은 자동 로그인을 할 수 없습니다 |
| 출퇴근 기록이 IP 때문에 막힘 | 회사 네트워크(등록된 IP)에서 다시 시도하세요 |
| `JADE 화면 구조가 예상과 달라 ... 중단한다` | JADE가 바뀐 경우입니다. 요청은 보내지 않았습니다. 이슈로 알려 주세요 |

## 자주 묻는 질문

**브라우저(Chrome·Aside 등)가 있어야 하나요?**
아니요. JADE 화면이 보내는 HTTP 요청을 직접 보냅니다. setup 의 「브라우저 핑거프린트」는 선택 항목이라, 비워 두면 자동으로 만듭니다.

**비밀번호는 어디에 저장되나요?**
macOS Keychain 에만 저장됩니다(항목 이름 `jade-mcp`). 설정 파일에는 들어가지 않고, 로그인할 때 Keychain 에서 읽어 JADE 서버로만 보냅니다.

**로그인은 언제 하나요?**
도구를 처음 부를 때 로그인하고, 세션이 끊기면 다시 로그인합니다. 따로 켜 둘 필요가 없습니다.

**Claude Code 말고 다른 클라이언트에서도 되나요?**
stdio MCP 서버라서 `bin/jade-mcp` 를 실행하도록 등록하면 됩니다.

**업데이트는 어떻게 하나요?**
`git pull && npm ci` 후 Claude Code 를 다시 엽니다. 계정 설정은 그대로 남습니다.

## 지원하지 않는 것

- 종일·여러 날 연차 신청 (하루 안의 시각 범위만 지원합니다)
- 결혼·출산·조사 등 증빙 파일이 필요한 경조 휴가
- 근무유형 변경을 결재로 처리하는 계정의 일정등록
- 신청서 회수·삭제, 결재 처리

## 개발

```sh
npm test            # 단위 테스트
npm run typecheck   # 타입 검사
```

구조:

- `src/client.ts` — 로그인, 세션 유지·복구, 공통 요청 (`commonAction.do`, `menuAction.do`)
- `src/viewstate.ts`, `src/page.ts` — JADE 화면이 요청마다 붙이는 보안값 재현, 화면 HTML 에서 호출 토큰 찾기
- `src/appl.ts` — 신청서 공통부 (결재선, 상신)
- `src/punch.ts`, `src/vacation.ts`, `src/condolence.ts`, `src/schedule.ts` — 화면별 흐름
- `src/index.ts` — MCP 도구 등록

JADE의 호출 토큰은 화면을 열 때마다 바뀌어서, 매번 화면 HTML을 받아 호출 위치의 코드 모양으로 토큰을 찾습니다. 찾지 못하면 요청을 보내지 않습니다.

## 라이선스

[MIT](LICENSE)
