# jade-mcp

JADE eHR(`ehr.jadehr.co.kr`)을 Claude Code 같은 MCP 클라이언트에서 쓸 수 있게 해 주는 **로컬 MCP 서버**입니다.
「오늘 출근 몇 시에 찍혔어?」, 「다음 달 근무일정 09:00~20:00으로 바꿔 줘」, 「11/6 오후 반차 올려 줘」처럼 말로 요청하면 JADE 화면과 같은 요청을 대신 보냅니다.

- 계정 정보는 **내 맥에만** 저장됩니다. 비밀번호는 macOS Keychain에 들어가고, JADE 서버 말고는 어디에도 보내지 않습니다.
- JADE 화면이 보내는 HTTP 요청을 그대로 재현합니다. 브라우저는 처음 계정을 입력할 때만 엽니다.
- 기록·신청처럼 되돌리기 어려운 작업은 항상 **준비(미리보기) → 승인 → 실행** 두 단계로 나뉩니다.

> JADE 공식 도구가 아닙니다. JADE 화면 구조가 바뀌면 동작하지 않을 수 있고, 그럴 때는 요청을 보내지 않고 멈추도록 만들었습니다.

## 빠른 시작

```sh
claude mcp add jade -s user -- npx -y jade-mcp@0.2.0
```

Claude Code 를 다시 열고 「오늘 출근 시간 알려 줘」라고 요청하세요.

1. 계정이 없으면 jade 가 브라우저에 **로컬 설정 페이지**(`http://127.0.0.1:…`)를 엽니다.
2. 페이지 위쪽에 설치 점검 결과(macOS·Node·회사망 인증서·JADE 접속)가 나오고, 아래에 회사코드·아이디·비밀번호를 입력합니다.
3. 입력값으로 실제 로그인이 되는지 확인한 뒤에만 저장합니다. 비밀번호는 Keychain 에만 들어갑니다.
4. Claude Code 로 돌아가 「저장했어」라고 하면 같은 요청을 다시 합니다.

비밀번호는 Claude 에게 말하지 마세요. 설정 페이지에만 입력합니다.

터미널에서 설정하고 싶으면 `npx -y jade-mcp setup`(점검 → 계정 입력 → 로그인 확인 → Claude Code 등록)을 쓰면 됩니다.
설치 상태만 보려면 `npx -y jade-mcp doctor` 입니다.

## 할 수 있는 일

| 도구 | 하는 일 | 종류 |
|---|---|---|
| `jade_doctor` | 설치 상태 점검 (macOS·Node·회사망 인증서·JADE 접속·계정) | 조회 |
| `jade_onboarding` | 계정 입력·변경 설정 페이지 열기 | 설정 |
| `jade_today` | 오늘 근무일, 출근·퇴근 시각, 근무시간 | 조회 |
| `jade_vacation_balance` | 연차 발생·사용·잔여 | 조회 |
| `jade_recent_applications` | 메인 화면의 최근 신청서와 결재 상태 | 조회 |
| `jade_calendar` | 근태현황 달력의 한 달 치 날짜별 근무유형·실제 근무시각·날짜 칸 표시(연차휴가·출장 등) | 조회 |
| `jade_prepare_punch` → `jade_commit_punch` | 출근·퇴근 기록 | 쓰기 |
| `jade_prepare_vacation` → `jade_commit_vacation` | 휴가 신청서 상신 (시간 단위, 하루 안의 시각 범위 — 반차 등) | 쓰기 |
| `jade_prepare_condolence` → `jade_commit_condolence` | 생일반차(오전·오후) 상신 | 쓰기 |
| `jade_prepare_schedule` → `jade_commit_schedule` | 근태현황 > 일정등록: 한 달의 근무 가능일자 계획 시각을 일괄 변경 | 쓰기 |
| `jade_prepare_remote_work` → `jade_commit_remote_work` | 한 달의 지정 요일 재택근무 신청서 상신 (하루에 한 장씩, 날짜별 토큰으로 한 건씩 상신) | 쓰기 |
| `jade_prepare_remote_work_day` → `jade_commit_remote_work` | 지정한 하루의 재택근무 신청서 상신 | 쓰기 |
| `jade_prepare_remote_work_revert` → `jade_commit_remote_work_revert` | 재택근무제로 바뀐 날을 지정한 근무유형으로 되돌리는 신청서 상신 | 쓰기 |
| `jade_applications` | 신청 > 신청내역 목록 (기간·상태·키워드·신청서 유형, 페이지) | 조회 |
| `jade_prepare_delete_applications` → `jade_commit_delete_applications` | 임시저장·결재 전 신청서 삭제 (회사가 회수 기능을 쓰면 회수도) | 쓰기 |
| `jade_prepare_clock_request` → `jade_commit_clock_request` | 지난 근무일 출퇴근시각 등록 요청서 상신 (출근만·퇴근만·둘 다, 날짜별 한 장) | 쓰기 |
| `jade_prepare_overtime` → `jade_commit_overtime` | 연장 근무 신청서 상신 (익일 넘김 지원, 휴일이면 대체/보상 유형) | 쓰기 |
| `jade_prepare_overtime_cancel` → `jade_commit_overtime_cancel` | 연장 근무 취소 신청서 상신 | 쓰기 |
| `jade_attendance_cancel_candidates` | 근태/근무 취소 신청서로 취소할 수 있는 원신청 목록(출장·근태 등) | 조회 |
| `jade_prepare_attendance_cancel` → `jade_commit_attendance_cancel` | 근태/근무 취소 신청서 상신 | 쓰기 |

쓰기 도구의 동작:

1. `prepare` 가 JADE 화면과 같은 순서로 값을 채우고 **서버 검증까지 통과시킨 뒤** 미리보기와 5분짜리 일회용 토큰을 돌려줍니다. 이 단계에서는 아무것도 저장하지 않습니다.
2. 미리보기를 확인하고 승인하면 `commit` 이 그 토큰으로 실제 저장·상신을 합니다. 실행 직전에 서버 검증을 한 번 더 합니다.

`commit` 도구에는 MCP `destructiveHint` 표시가 붙어 있습니다. Claude Code는 MCP 도구를 실행하기 전에 허용 여부를 묻는데, **`commit` 도구는 「항상 허용」으로 두지 마세요.** 미리보기를 보고 한 건씩 승인하는 것이 이 구조의 안전장치입니다.

## 준비물

- macOS (비밀번호를 Keychain에 저장하고, 회사망 인증서를 시스템 인증서 저장소에서 읽습니다)
- Node.js **22.23.4 / 24.22.1 / 26.12.1 이상** — TLS 인증서 호스트 검사 우회(CVE-2026-105483 등)가 고쳐진 보안 패치 버전입니다.
  PATH 의 node 가 이보다 낮으면 nvm·Homebrew(`node@24` 같은 버전 지정 설치 포함)로 설치된 node 중 조건에 맞는 것을 찾아 쓰고, 없으면 JADE 에 요청하지 않습니다(`nvm install 24`).
- JADE 계정 (2차 인증이 꺼져 있어야 합니다)
- 출근·퇴근 기록은 JADE에 등록된 IP(회사 네트워크)에서만 저장됩니다.

## 설치와 계정 설정

[빠른 시작](#빠른-시작)의 한 줄이면 됩니다. 등록은 user 범위(기본 설정 `~/.claude.json`)라 모든 프로젝트·세션에서 보입니다.
버전을 고정해 등록합니다. 비밀번호를 다루는 도구라, Claude Code 를 열 때마다 레지스트리의 최신본을 자동으로 받아 실행하지 않게 했습니다. 업데이트는 [자주 묻는 질문](#자주-묻는-질문)을 보세요.

계정은 둘 중 편한 쪽으로 넣습니다.

| 방법 | 하는 일 |
|---|---|
| 설정 페이지 (기본) | 계정이 없을 때 jade 도구를 부르면 열립니다. 비밀번호를 바꿨거나 다른 계정으로 바꿀 때는 「jade 계정 다시 설정할래」라고 하면 `jade_onboarding` 이 엽니다. 페이지는 이 맥(127.0.0.1)에서만 열리고, 한 번 쓰는 주소이며, 저장하거나 10분이 지나면 닫힙니다 |
| 터미널 `npx -y jade-mcp setup` | 회사코드·아이디를 묻고, 비밀번호는 macOS `security` 입력창에 두 번 입력합니다. 로그인 확인 뒤 Claude Code 등록 여부를 묻습니다(엔터 = 등록). 비밀번호만 바꾸려면 `--password` |

- 설정 파일: `~/.config/jade-mcp/config.json` (파일 600·폴더 700, 비밀번호는 들어가지 않습니다)
- 비밀번호: Keychain 항목 `jade-mcp` / 계정명 = JADE 아이디
- 브라우저 핑거프린트: 자동으로 만들어 계속 씁니다. 터미널 setup 에서는 JADE 화면 개발자도구 콘솔의 `getJadeFP()` 값을 넣을 수도 있습니다.

## 요청 예시

- 「오늘 출근 시간이랑 연차 잔여 알려 줘」
- 「이번 달에 휴가 쓴 날 알려 줘」 → `jade_calendar` 의 날짜 칸 표시(`연차휴가(2h)` 등)로 확인
- 「퇴근 찍어 줘」 → 미리보기 확인 → 승인
- 「11/6 금요일 오후 반차 올려 줘. 10시 출근 기준이야」 → 15:00~19:00, 4시간으로 미리보기 → 승인
- 「11/20 생일 오후 반차 올려 줘」
- 「다음 달 근무일정 09:00~20:00으로 바꿔 줘」 → 주말·휴일을 뺀 근무 가능일자 전체
- 「11월 월요일 재택근무 신청해 줘」 → 11월의 주(첫 평일이 든 주부터 평일이 12월로 넘어가지 않는 주까지)마다 월요일 한 장씩.
  주중에 공휴일이 있거나 휴가가 잡힌 주, 이미 재택이거나 지난 날짜는 빼고 이유를 알려 줍니다.
  사유는 「11월 2일 재택근무 신청드립니다.」처럼 날짜마다 채웁니다. 결재 대기 중인 휴가는 달력에 안 보일 수 있어 미리보기에서 확인하세요.
- 「11/9 재택 취소하고 선택근무제(IT)로 돌려 줘」 → 그날을 그 근무유형으로 되돌리는 재택 근무 신청서 미리보기 → 승인.
  재택 취소는 근태/근무 취소 신청서 목록에 나오지 않아서 이 방식으로 처리합니다.
- 「어제 퇴근 못 찍었어. 19시로 등록 요청해 줘」 → 퇴근만 19:00 으로 출퇴근시각 등록 요청서 미리보기 → 승인 (시각은 기본값 없이 말한 값만 씁니다)
- 「내일 18:30~22:00 연장근무 신청해 줘」 → 미리보기 → 승인 (시각은 기본값 없이 말한 값만 씁니다)
- 「결재 중인 신청서 보여 줘」 → 「그중 휴가 신청서 지워 줘」 → 삭제 미리보기 → 승인.
  삭제는 되돌릴 수 없습니다.

## 구글 캘린더 동기화 (선택)

휴가(연차·반차·반반차·경조·기타), 재택, 근태/근무 신청서(출장·외근·교육 등)를 구글 캘린더에 맞춰 둡니다.

| 언제 | 무엇을 |
|---|---|
| jade 도구로 휴가·재택·경조 상신, 신청 삭제·회수, 근태 취소, 재택 취소를 한 직후 | 별도 프로세스로 바로 동기화 (도구 응답은 기다리지 않습니다) |
| 평일 9~19시 매 정각 | 웹·앱으로 한 신청까지 동기화. 정각에서 3분 넘게 늦은 실행(잠자기 중 놓친 정각)과 공휴일은 건너뜁니다 |

- 범위: 오늘 ~ 다음 달 말일. 이 기능이 만든 일정(비공개 속성 `jadeSync=1`)만 추가·수정·삭제하고 직접 넣은 일정은 건드리지 않습니다.
- 승인된 일정은 JADE 달력 기준입니다. 승인 뒤 취소하면 달력에서 사라지는 시점에 지웁니다.
- 결재 중인 신청은 제목에 `(결재중)` 을 붙여 넣고, 승인되면 제목만 바뀝니다. 반려·삭제되면 지웁니다.
- 시각: 신청서에 적힌 시각. 시각이 없는 경조휴가는 오전 09:30~13:30 · 오후 14:30~18:30 · 종일 09:30~18:30, 재택은 신청서 시각이 없으면 09:30~18:30.
- 재택 날에 8시간 이상 휴가·출장 등이 있으면 재택 일정은 넣지 않습니다. 재택은 「한가함」으로 표시하고 알림은 끕니다.

설정 (1회):

1. 구글 OAuth 클라이언트(데스크톱 앱) JSON 을 받습니다. Google Cloud Console → Calendar API 사용 → OAuth 동의 화면 대상 **내부** → 클라이언트 유형 **데스크톱 앱**.
   외부·테스트 상태로 두면 7일마다 다시 로그인해야 합니다.
2. `jade-mcp gcal auth --client ~/Downloads/client_secret_….json` — 설정 폴더로 복사하고 브라우저 로그인. 토큰은 Keychain `jade-mcp-gcal` 에 저장됩니다.
3. `jade-mcp gcal sync --dry-run` 으로 바꿀 목록을 확인한 뒤 `jade-mcp gcal sync --force`
4. `jade-mcp gcal install` — 매 정각 자동 실행 등록 (`uninstall` 로 해제, `status` 로 상태 확인)

로그: `~/Library/Logs/jade-mcp/gcal-sync.log`. 실패하면 macOS 알림이 뜹니다. 레포에서 실행하면 `jade-mcp` 대신 `bin/jade-mcp` 를 씁니다.

## 문제 해결

| 증상 | 원인과 해결 |
|---|---|
| `fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)` | 회사망의 TLS 검사 인증서를 신뢰하지 못한 경우입니다. 실행기가 `--use-system-ca` 로 시스템 인증서를 쓰게 띄웁니다. `npx -y jade-mcp doctor` 로 확인하세요 |
| `보안 패치된 Node 가 없다` | 준비물의 Node 버전을 설치하세요 (예: `nvm install 24`). 기본 node 를 바꿀 필요는 없습니다 |
| `JADE 계정 설정이 필요하다` | 열린 설정 페이지에서 계정을 입력하세요. 페이지가 안 보이면 안내된 주소를 직접 엽니다 |
| 비밀번호를 바꾼 뒤 로그인 실패 | 「jade 계정 다시 설정할래」(설정 페이지) 또는 `npx -y jade-mcp setup --password` |
| `2차 인증이 켜진 계정` | 2차 인증 계정은 자동 로그인을 할 수 없습니다 |
| 출퇴근 기록이 IP 때문에 막힘 | 회사 네트워크(등록된 IP)에서 다시 시도하세요 |
| `JADE 화면 구조가 예상과 달라 ... 중단한다` | JADE가 바뀐 경우입니다. 요청은 보내지 않았습니다. 이슈로 알려 주세요 |

## 자주 묻는 질문

**브라우저(Chrome·Aside 등)가 있어야 하나요?**
처음 계정을 넣는 설정 페이지에만 씁니다. JADE 요청은 브라우저 없이 HTTP 로 직접 보냅니다.

**비밀번호는 어디에 저장되나요?**
macOS Keychain 에만 저장됩니다(항목 이름 `jade-mcp`). 설정 파일에는 들어가지 않고, 로그인할 때 Keychain 에서 읽어 JADE 서버로만 보냅니다.

**로그인은 언제 하나요?**
도구를 처음 부를 때 로그인하고, 세션이 끊기면 다시 로그인합니다. 따로 켜 둘 필요가 없습니다.

**Claude Code 말고 다른 클라이언트에서도 되나요?**
stdio MCP 서버라서 `npx -y jade-mcp@<버전>` 을 실행하도록 등록하면 됩니다.

**업데이트는 어떻게 하나요?**
[npm 버전 목록](https://www.npmjs.com/package/jade-mcp?activeTab=versions)에서 새 버전을 확인하고 등록을 바꾼 뒤 Claude Code 를 다시 엽니다. 계정 설정은 그대로 남습니다.

```sh
claude mcp remove jade -s user && claude mcp add jade -s user -- npx -y jade-mcp@<새 버전>
```

**지우려면 어떻게 하나요?**

```sh
claude mcp remove jade -s user                   # Claude Code 등록 해제 (setup 때 CLAUDE_CONFIG_DIR 를 썼다면 그 셸에서 한 번 더)
security delete-generic-password -s jade-mcp     # Keychain 비밀번호 삭제
rm -r ~/.config/jade-mcp                         # 설정 파일 삭제
```

git clone 으로 설치했다면 그 폴더도 지웁니다.

## 지원하지 않는 것

- 종일·여러 날 연차 신청 (하루 안의 시각 범위만 지원합니다)
- 결혼·출산·조사 등 증빙 파일이 필요한 경조 휴가
- 근무유형 변경을 결재로 처리하는 계정의 일정등록
- 결재 처리(결재자 쪽 승인·반려)

## 개발

```sh
git clone https://github.com/choiyounggi/jade-mcp.git && cd jade-mcp && npm ci
npm test            # 단위 테스트
npm run typecheck   # 타입 검사
npm run build       # dist/ 빌드 (npm 패키지에 들어가는 것)
```

레포에서 바로 쓰려면 `bin/jade-mcp-setup`(터미널 setup) 또는 `claude mcp add jade -s user -- "$(pwd)/bin/jade-mcp"` 로 등록합니다. 이 실행기는 빌드 없이 `src/` 를 tsx 로 실행합니다.

배포는 자동입니다. main 에 푸시하면 CI(`.github/workflows/ci.yml`)가 macOS 에서 Node 22·24·26 으로 타입검사·테스트·빌드한 뒤 릴리스합니다.

1. 마지막 `v*` 태그 이후 커밋 메시지(Conventional Commits)로 버전을 정합니다. `feat!:`·`BREAKING CHANGE:` → major, `feat:` → minor, 그 밖의 커밋 → patch. `docs:`·`chore:`·`ci:`·`test:`·`style:` 과 Git 의 머지 커밋만 있으면 릴리스하지 않습니다.
2. `package.json`·`npm-shrinkwrap.json` 버전과 README 빠른 시작의 `jade-mcp@x.y.z` 고정 버전을 함께 올려 커밋하고, `vX.Y.Z` 태그와 GitHub Release 를 만듭니다.
3. npm 에 배포합니다(`prepublishOnly` 가 타입검사·테스트·빌드를 다시 통과해야 올라갑니다). 토큰 없이 npm trusted publishing(GitHub Actions OIDC)으로 인증하므로 npm 패키지 설정에 이 저장소의 `ci.yml` 이 신뢰할 게시자로 등록돼 있어야 합니다(`npm trust github jade-mcp --file ci.yml --repo choiyounggi/jade-mcp --allow-publish`).
4. 중간에 실패하면 그 job 을 다시 실행하세요. 이미 있는 태그·Release·npm 버전은 건너뛰고 빠진 단계만 실행합니다.

의존성은 `npm-shrinkwrap.json` 으로 고정해 함께 배포합니다. 릴리스 스크립트 테스트: `node --test scripts/release.check.mjs`.

구조:

- `bin/jade-mcp.cjs` — npm 실행기. 보안 패치된 Node 를 찾아 `--use-system-ca` 로 `dist/main.js` 를 띄운다 (`bin/node-min.cjs` 가 최소 버전 정본)
- `src/main.ts` — 하위 명령 분기 (서버 · `setup` · `doctor` · `gcal`)
- `src/gcal/` — 구글 캘린더 동기화 (`plan.ts` 순수 계산 · `google.ts` OAuth·API · `sync.ts` 실행 순서 · `launchd.ts` 정각 실행 · `cli.ts` 하위 명령 · `env.ts` 경로·상신 직후 실행)
- `src/runtime.ts`, `src/onboarding.ts`, `src/account.ts`, `src/doctor.ts` — 계정이 없을 때 설정 페이지 온보딩, Keychain 저장, 설치 점검
- `src/client.ts` — 로그인, 세션 유지·복구, 공통 요청 (`commonAction.do`, `menuAction.do`)
- `src/viewstate.ts`, `src/page.ts` — JADE 화면이 요청마다 붙이는 보안값 재현, 화면 HTML 에서 호출 토큰 찾기
- `src/appl.ts` — 신청서 공통부 (결재선, 상신)
- `src/punch.ts`, `src/vacation.ts`, `src/condolence.ts`, `src/schedule.ts`, `src/remote.ts` 등 — 화면별 흐름
- `src/index.ts` — MCP 도구 등록

JADE의 호출 토큰은 화면을 열 때마다 바뀌어서, 매번 화면 HTML을 받아 호출 위치의 코드 모양으로 토큰을 찾습니다. 찾지 못하면 요청을 보내지 않습니다.

## 라이선스

[MIT](LICENSE)
