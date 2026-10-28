import type { JadeConfig } from "./config.js";
import { JadeHttp, type FetchLike } from "./http.js";
import { parsePage, type PageContext } from "./page.js";
import { parseJsonResponse, SessionExpiredError, UnexpectedResponseError, type JadeResponse } from "./response.js";
import { toJsonString, type Params } from "./viewstate.js";

// 로그인 화면은 평문 클래스명을 쓴다. 로그인 뒤 화면들은 화면마다 새로 발급되는 암호 토큰을 쓴다.
const LOGIN_CLASS = "biz.sys.sy_main.Sy_main_page";

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export class JadeClient {
  private readonly http: JadeHttp;
  private main: PageContext | undefined;
  private loginInFlight: Promise<void> | undefined;
  private recoveryInFlight: Promise<PageContext | undefined> | undefined;

  constructor(
    private readonly config: JadeConfig,
    private readonly getPassword: () => Promise<string>,
    fetchImpl?: FetchLike,
  ) {
    this.http = new JadeHttp(config.baseUrl, config.userAgent, fetchImpl);
  }

  /**
   * common.js 의 send + makeParameters 를 재현한다. params 의 키 순서가 __viewState 해시 순서가 된다.
   * 응답은 항상 JSON(xsheetResultJson)으로 받는다.
   */
  async call(ctx: PageContext, dsClass: string, dsMethod: string, params: Params = {}): Promise<JadeResponse> {
    const form: Params = { ...params, S_FORWARD: params.S_FORWARD ?? "xsheetResultJson" };
    form.S_PGM_OPEN_TIME = ctx.openTime;
    form.S_ENC_OTP_KEY = ctx.otpKey;
    form.S_CSRF_SALT = ctx.csrfSalt;
    if (ctx.hasMaskingVars) {
      form.S_ENC_MASKING_USE_YN = ctx.page.ENC_MASKING_USE_YN || "N";
      form.S_ENC_PER_NO_LIMIT_YN = ctx.page.ENC_PER_NO_LIMIT_YN || "N";
      form.S_ENC_RSN_POP_USE_YN = ctx.page.ENC_RSN_POP_USE_YN || "N";
      form.S_ENC_T = ctx.page.ENC_T || "";
    }
    form.S_JADE_FP = this.config.fingerprint;
    form.S_DSCLASS = dsClass;
    form.S_DSMETHOD = dsMethod;
    if (Object.keys(ctx.page).length > 0) {
      form.S_PAGE_PROFILE_ID = ctx.page.PROFILE_ID;
      form.S_PAGE_MODULE_ID = ctx.page.MODULE_ID;
      form.S_PAGE_MENU_ID = ctx.page.MENU_ID;
      form.S_PAGE_PGM_URL = ctx.page.PGM_URL;
      form.S_PAGE_POP_URL = ctx.page.POP_URL;
      form.S_PAGE_PGM_ID = ctx.page.PGM_ID;
      form.S_PAGE_ENC_VAL = ctx.page.ENC_VAL;
    }
    form.__viewState = toJsonString(form);

    const res = await this.http.request("/commonAction.do", { method: "POST", form, ajax: true });
    return parseJsonResponse(res.status, res.text);
  }

  /** 로그인된 메인 화면 컨텍스트로 fn 을 실행한다. 세션이 끊겼으면 한 번만 재로그인해 다시 시도한다. */
  async withSession<T>(fn: (main: PageContext) => Promise<T>): Promise<T> {
    const main = this.main ?? (await this.ensureLogin());
    try {
      return await fn(main);
    } catch (e) {
      if (!(e instanceof SessionExpiredError || e instanceof UnexpectedResponseError)) throw e;
      const fresh = await this.recover(main, e instanceof SessionExpiredError);
      if (!fresh) throw e;
      return fn(fresh);
    }
  }

  /**
   * 실패한 호출 뒤 세션을 되살린다. 세션이 살아 있으면 오류가 진짜이므로 undefined 를 돌려준다.
   * 동시에 실패한 호출들은 한 번의 확인·재로그인을 함께 기다린다.
   */
  private recover(failed: PageContext, knownExpired: boolean): Promise<PageContext | undefined> {
    if (this.main && this.main !== failed) return Promise.resolve(this.main);
    this.recoveryInFlight ??= (async () => {
      if (!knownExpired && (await this.sessionAlive())) return undefined;
      return this.ensureLogin(true);
    })().finally(() => {
      this.recoveryInFlight = undefined;
    });
    return this.recoveryInFlight;
  }

  /** 로그인된 세션이면 GET / 가 메인 화면을 준다. 그 화면으로 컨텍스트도 새로 고친다. */
  private async sessionAlive(): Promise<boolean> {
    const res = await this.http.request("/");
    if (!/hunelOtpVal/.test(res.text)) return false;
    this.main = parsePage(res.text);
    return true;
  }

  /**
   * 동시에 들어온 호출이 각자 로그인하면 쿠키 저장소를 서로 비워 세션이 깨진다(HTTP 500).
   * 진행 중인 로그인이 있으면 그것을 함께 기다린다.
   */
  private async ensureLogin(force = false): Promise<PageContext> {
    if (!force && this.main) return this.main;
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = undefined;
    });
    await this.loginInFlight;
    return this.main!;
  }

  private async login(): Promise<void> {
    this.main = undefined;
    this.http.jar.clear();

    const loginPage = await this.http.request("/");
    const loginCtx = parsePage(loginPage.text);
    const password = await this.getPassword();
    const params: Params = {
      S_NO_LOGIN_CHECK: "Y",
      directpage_id: "",
      firstpage_id: "",
      S_C_CD: this.config.companyCode,
      S_USER_ID: this.config.userId,
      S_PWD: password,
    };

    let before: JadeResponse;
    try {
      before = await this.call(loginCtx, LOGIN_CLASS, "login_before", params);
    } catch (e) {
      throw new LoginError(`로그인 사전 확인 실패: ${(e as Error).message}`);
    }
    if (before.etc.RESET_POP === "Y") throw new LoginError("비밀번호 초기화 상태다 — 브라우저에서 비밀번호를 다시 설정해야 한다");
    if (before.etc.AUTH_2FA_USE_YN === "Y") throw new LoginError("2차 인증이 켜진 계정이라 자동 로그인을 할 수 없다");

    try {
      await this.call(loginCtx, LOGIN_CLASS, "login", params);
    } catch (e) {
      throw new LoginError(`로그인 실패: ${(e as Error).message}`);
    }

    const entry: Params = { directpage_id: "", firstpage_id: "" };
    entry.__viewState = toJsonString(entry);
    const mainPage = await this.http.request("/", { method: "POST", form: entry });
    const main = parsePage(mainPage.text);
    if (!main.otp.hunelOtpVal) throw new LoginError("로그인 뒤 메인 화면을 받지 못했다");
    this.main = main;
  }

  /**
   * 메뉴·팝업 화면을 연다(ModalUtil.popOpen → submit2 와 같은 요청). 화면 HTML 에는 그 화면에서만 쓰는
   * 보안값과 호출 토큰이 들어 있다. 세션이 죽었으면 오류 페이지가 오므로 SessionExpiredError 로 바꾼다.
   */
  async openScreen(params: Params): Promise<{ text: string; ctx: PageContext }> {
    const form: Params = { ...params };
    form.__viewState = toJsonString(form);
    const res = await this.http.request("/menuAction.do", { method: "POST", form });
    if (/name=["']S_PWD["']/.test(res.text)) throw new SessionExpiredError();
    if (res.status !== 200) {
      if (!(await this.sessionAlive())) throw new SessionExpiredError();
      throw new UnexpectedResponseError(res.status);
    }
    return { text: res.text, ctx: parsePage(res.text) };
  }
}
