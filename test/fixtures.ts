// 실제 JADE 화면의 구조만 본뜬 합성 HTML — 실제 토큰·개인정보는 담지 않는다.

export function loginHtml(): string {
  return `<html><script>
var S_PGM_OPEN_TIME = "1000";
var S_ENC_OTP_KEY   = "";
var S_CSRF_SALT     = "null";
</script>
<form id="f1" name="f1" method="post">
<input type="hidden" id="S_NO_LOGIN_CHECK" name="S_NO_LOGIN_CHECK" value="Y" />
<input type="text" id="S_USER_ID" name="S_USER_ID" />
<input type="password" id="S_PWD" name="S_PWD" />
</form></html>`;
}

export function mainHtml(tag = "A"): string {
  return `<html><script>
if ( window.Page == undefined )
{
  Page =
  {
    C_CD: "2202010",
    LANG: "ko",
    PROFILE_ID: "",
    //버튼로그 관련 시작
    PGM_ID: "main_${tag}",
    ENC_T : "",
    PGM_URL: "/main.jsp"
  }
}
var S_PGM_OPEN_TIME = "2000${tag}";
var S_ENC_OTP_KEY   = "otp-${tag}";
var S_CSRF_SALT     = "salt-${tag}";
var S_ENC_MASKING_USE_YN = (window.Page && Page.ENC_MASKING_USE_YN) || "N";
var hunelOtpVal =
{
    blockUI                     : "tok-blockUI-${tag}"
  , getMainInfo                 : "tok-getMainInfo-${tag}"  //사용
};
</script>
<input type='hidden' id='S_DSCLASS' name='S_DSCLASS' value='cls-main-${tag}' />
</html>`;
}

export function mainInfoJson(): string {
  return JSON.stringify({
    Msg: [{ Error: "" }],
    Etc: [],
    tmpInfo: [
      {
        WORK_YMD: "20261027",
        C_IN_HM_DP: "09:15",
        C_OUT_HM_DP: "--:--",
        WORK_TIME_DP: "--:--",
        INPUT_YN: "Y",
        IN_OUT_YN: "Y",
        CLOSE_YN: "N",
        PLAN_WORK_YN: "Y",
        UNPLAN_CHK_WORK_RECORD: "N",
      },
    ],
    vacCnt: [{ CRT_D_CNT: "124", USE_D_CNT: "104", BLN_D_CNT: "20", QUOTA_UNIT: "H" }],
    applList: [{ APPL_YMD: "20261020", APPL_TYPE_NM: "휴가 신청서", APPL_STAT_NM: "결재완료", APPL_ID: "A1" }],
  });
}
