import { describe, expect, it } from "vitest";
import { ApplicationBlockedError, checkApprovers, initFormFields, toApprovers } from "../src/appl.js";

describe("toApprovers", () => {
  it("reads LineDetail columns as approvers", () => {
    expect(toApprovers([{ COL3: "100", COL4: "결재자", COL5: "팀장", COL10: "10" }])).toEqual([
      { empId: "100", name: "결재자", title: "팀장", type: "10" },
    ]);
  });

  it("skips rows without an employee id", () => {
    expect(toApprovers([{ COL3: "", COL4: "빈 행" }])).toEqual([]);
  });
});

describe("checkApprovers", () => {
  const boss = { empId: "100", name: "결재자", title: "팀장", type: "10" };

  it("passes with a decider on a process that needs approval", () => {
    expect(() => checkApprovers([boss], { APPR_PRS_YN: "Y", APPL_TO_ME: "Y" }, "200")).not.toThrow();
  });

  it("blocks when only references are on the line", () => {
    const ref = { ...boss, type: "40" };
    expect(() => checkApprovers([ref], { APPR_PRS_YN: "Y" }, "200")).toThrow(ApplicationBlockedError);
  });

  it("blocks self-approval when the form forbids it", () => {
    expect(() => checkApprovers([{ ...boss, empId: "200" }], { APPR_PRS_YN: "Y", APPL_TO_ME: "N" }, "200")).toThrow("자신을");
  });
});

describe("initFormFields", () => {
  it("falls back to the screen defaults when the type row is empty", () => {
    expect(initFormFields({})).toMatchObject({ S_PROC_FLAG: "10", S_PROC_TYPE: "10", S_INF_USE_YN: "N", S_APPL_TYPE_NM: "" });
  });

  it("uses the configured values", () => {
    expect(initFormFields({ PROC_FLAG: "20", APPR_LINE_EDIT_YN: "Y" })).toMatchObject({ S_PROC_FLAG: "20", S_APPR_LINE_EDIT_YN: "Y" });
  });
});
