import type { JadeClient } from "./client.js";
import { otpToken, type PageContext } from "./page.js";
import type { Params } from "./viewstate.js";

export interface MenuTarget {
  pgmId: string;
  pgmUrl: string;
  menuNm: string;
  /** 메뉴 안에서 실제로 띄울 화면. 없으면 메뉴 화면 자체를 연다. */
  popUrl?: string;
  extra?: Params;
}

/**
 * 메뉴 화면(또는 그 메뉴 권한으로 여는 하위 화면)을 연다 — hunel.js 의 메뉴 클릭이 만드는 popOpen 요청과 같다.
 * 메뉴 권한값(ENC_VAL 등)은 searchAuth 로 매번 새로 받는다.
 */
export async function openMenu(client: JadeClient, main: PageContext, target: MenuTarget) {
  const auth = await client.call(main, otpToken(main, "hunelOtpVal", "Sy_main_page"), otpToken(main, "hunelOtpVal", "searchAuth"), {
    S_PGM_ID: target.pgmId,
    S_PGM_URL: target.pgmUrl,
  });
  const page = main.page;
  const form: Params = {
    X_PROFILE_ID: auth.etc.PROFILE_ID,
    X_MODULE_ID: auth.etc.MODULE_ID,
    X_MENU_ID: auth.etc.MENU_ID,
    X_PGM_ID: target.pgmId,
    X_SQL_ID: page.SQL_ID,
    X_PRS_ID: "",
    X_EMP_SCH_AUTH_CD: page.EMP_SCH_AUTH_CD,
    X_MENU_NM: target.menuNm,
    X_ENC_VAL: auth.etc.ENC_VAL,
    X_PGM_URL: target.pgmUrl,
    X_POP_URL: target.popUrl ?? target.pgmUrl,
    X_C_CD: page.C_CD,
    X_HELP_PGM_ID: page.HELP_PGM_ID,
    GEN_YN: "",
    S_SQL_ID: page.SQL_ID ?? "",
    S_PRS_ID: "",
    S_PROFILE_ID: auth.etc.PROFILE_ID ?? "",
    S_GEN_YN_YN: "",
    S_MAIN_PAGE_YN: "",
    S_TOP_FRAME_TYPE: "",
    MASKING_USE_YN: page.MASKING_USE_YN,
    PER_NO_LIMIT_YN: page.PER_NO_LIMIT_YN,
    RSN_POP_USE_YN: page.RSN_POP_USE_YN,
    ENC_MASKING_USE_YN: page.ENC_MASKING_USE_YN,
    ENC_PER_NO_LIMIT_YN: page.ENC_PER_NO_LIMIT_YN,
    ENC_RSN_POP_USE_YN: page.ENC_RSN_POP_USE_YN,
    ENC_T: page.ENC_T,
    EXCEL_FILE_PWD_YN: page.EXCEL_FILE_PWD_YN,
    CONF_INPUT_USE_YN: page.CONF_INPUT_USE_YN,
    CLIPBOARD_YN: page.CLIPBOARD_YN,
    ...target.extra,
  };
  // submit2 는 값이 없는 파라미터도 빈 문자열로 보낸다.
  for (const k of Object.keys(form)) form[k] ??= "";
  return client.openScreen(form);
}

const APPL_MENU = { pgmId: "sy_appl_200_m03", pgmUrl: "/sys/sy_appl/sy_appl_200_m03.jsp", menuNm: "신청" } as const;

/** 「신청」 메뉴의 새 신청서 작성 화면을 연다 (sy_appl_200_f01 에서 신청서를 고른 것과 같다). */
export function openNewApplication(client: JadeClient, main: PageContext, form: { type: string; name: string; url: string }) {
  return openMenu(client, main, {
    ...APPL_MENU,
    popUrl: form.url,
    extra: {
      S_TITEL_NM: "신청서작성",
      S_APPL_TYPE: form.type,
      S_APPL_ID: "",
      S_APPL_MODE: "APPL",
      S_APPL_TYPE_NM: form.name,
      S_APPL_VERSION: "APPL_V03",
      S_LIST_SRC: "/sys/sy_appl/sy_appl_200_f01.jsp",
    },
  });
}
