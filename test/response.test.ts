import { describe, expect, it } from "vitest";
import { JadeError, parseJsonResponse, SessionExpiredError, UnexpectedResponseError } from "../src/response.js";

describe("parseJsonResponse", () => {
  it("splits datasets and merges Etc rows", () => {
    const res = parseJsonResponse(
      200,
      JSON.stringify({ Msg: [{ Error: "" }], Etc: [{ A: "1" }, { B: "2" }], rows: [{ X: "x" }], note: "skip" }),
    );
    expect(res.etc).toEqual({ A: "1", B: "2" });
    expect(res.datasets).toEqual({ rows: [{ X: "x" }] });
  });

  it("maps LOGIN_CHECK_FAIL to SessionExpiredError", () => {
    expect(() => parseJsonResponse(200, '{"Msg":[{"Error":"LOGIN_CHECK_FAIL:LOGOUT"}],"Etc":[]}')).toThrow(
      SessionExpiredError,
    );
  });

  it("surfaces other server errors", () => {
    expect(() => parseJsonResponse(200, '{"Msg":[{"Error":"권한이 없습니다"}]}')).toThrow("JADE 오류: 권한이 없습니다");
  });

  it("rejects non-JSON bodies without echoing them", () => {
    const run = () => parseJsonResponse(500, "<html>secret-ish body</html>");
    expect(run).toThrow(UnexpectedResponseError);
    expect(run).toThrow(JadeError);
    expect(run).not.toThrow(/secret-ish/);
  });

  it("handles an empty Msg/Etc", () => {
    expect(parseJsonResponse(200, "{}")).toEqual({ etc: {}, datasets: {} });
  });
});
