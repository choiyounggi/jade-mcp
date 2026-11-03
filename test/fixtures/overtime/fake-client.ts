// 연장 근무 신청·취소 흐름 테스트용 가짜 JadeClient — 실제 JADE 화면의 구조만 본뜨고 실제 토큰·개인정보는 담지 않는다.
import type { JadeClient } from "../../../src/client.js";
import { parsePage } from "../../../src/page.js";
import type { JadeResponse } from "../../../src/response.js";
import type { Params } from "../../../src/viewstate.js";

export interface RecordedCall {
  dsClass: string;
  method: string;
  params: Params;
}

const MAIN_HTML = `<script>
var S_PGM_OPEN_TIME = "1";
var S_ENC_OTP_KEY   = "otp-main";
var S_CSRF_SALT     = "salt-main";
var hunelOtpVal =
{
    Sy_main_page                : "cls-main"
  , searchAuth                  : "tok-searchAuth"
};
</script>`;

/** 신청서 화면 공통부 — 화면 고유 JS(script)와 입력칸(inputs)을 덧붙인다. */
export function applicationHtml(script: string, inputs: string): string {
  return `<script>
var S_PGM_OPEN_TIME = "2";
var S_ENC_OTP_KEY   = "otp-form";
var S_CSRF_SALT     = "salt-form";
var ApplyOtpVal = {
    Sys_appl_common : "cls-appl-common"
  , getInitInfo     : "tok-getInitInfo"
  , getCourse       : "tok-getCourse"
  , searchRetiree   : "tok-searchRetiree"
  , apply01         : "tok-apply01"
};
${script}
</script>
<form id="f1">
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="cls-form" />
<input type="hidden" id="S_DSMETHOD" name="S_DSMETHOD" />
${inputs}
<input type="hidden" id="S_LOGIN_EMP_ID" name="S_LOGIN_EMP_ID" value="E0001" />
<input type="hidden" id="S_LOGIN_EMP_NM" name="S_LOGIN_EMP_NM" value="테스트사용자" />
</form>`;
}

export const empty = (): JadeResponse => ({ etc: {}, datasets: {} });

/** 신청서 공통부(prepareEnvelope·submitApplication) 응답. 결재자 1명. */
export function commonResponse(method: string): JadeResponse | undefined {
  switch (method) {
    case "tok-searchAuth":
      return { etc: { PROFILE_ID: "ESS", MODULE_ID: "essAppl", MENU_ID: "m1", ENC_VAL: "enc" }, datasets: {} };
    case "tok-getInitInfo":
      return { etc: { S_APPL_TX_TOKEN: "tx-1" }, datasets: { ApplType: [{ APPR_PRS_YN: "Y", APPL_TO_ME: "N", APPL_TYPE_NM: "신청서" }] } };
    case "tok-getCourse":
      return {
        etc: {},
        datasets: { ApprLine: [{ COL2: "PATH-1", COL4: "Y" }], LineDetail: [{ COL3: "E0002", COL4: "결재자", COL5: "팀장", COL10: "10" }] },
      };
    case "tok-searchRetiree":
      return { etc: { RET_STAT: "Y" }, datasets: {} };
    case "tok-apply01":
      return { etc: { APPL_ID: "APPL-NEW" }, datasets: {} };
    default:
      return undefined;
  }
}

/**
 * screens 는 X_POP_URL → 화면 HTML, respond 는 화면 고유 메서드의 응답. 모르는 메서드를 부르면 실패한다 —
 * 테스트가 예상하지 못한 서버 호출(특히 저장)을 놓치지 않게 하기 위해서다.
 */
export function fakeClient(screens: Record<string, string>, respond: (method: string, params: Params) => JadeResponse | undefined) {
  const calls: RecordedCall[] = [];
  const main = parsePage(MAIN_HTML);
  const client = {
    withSession: <T>(fn: (m: typeof main) => Promise<T>) => fn(main),
    call: async (_ctx: unknown, dsClass: string, method: string, params: Params = {}) => {
      calls.push({ dsClass, method, params });
      const res = commonResponse(method) ?? respond(method, params);
      if (!res) throw new Error(`예상하지 못한 호출 ${method}`);
      return res;
    },
    openScreen: async (form: Params) => {
      const html = screens[String(form.X_POP_URL)];
      if (!html) throw new Error(`예상하지 못한 화면 ${String(form.X_POP_URL)}`);
      return { text: html, ctx: parsePage(html) };
    },
  } as unknown as JadeClient;
  return { client, calls };
}
