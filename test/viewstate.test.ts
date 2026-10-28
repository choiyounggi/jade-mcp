import { describe, expect, it } from "vitest";
import { calcHash, toJsonString } from "../src/viewstate.js";

// 기대값은 실제 JADE 화면의 calcHash / toJsonString 을 브라우저에서 실행해 얻은 값이다.
describe("calcHash", () => {
  it.each([
    ["", "aa6ac2d4961882f42a345c7615f4133dde8e6d6e7c1b6b40ae4ff6ee52c393d0"],
    ["abc", "f2a778f1a6ed3d5bc59a5d79104c598f3f07093f240ca4e91333fb09ed4f36da"],
    ["가나다 A,B", "aec97f51453e15989c67c6a2495d7db6e9e7d9de30e19debfe7bc258b7856a36"],
  ])("matches the browser for %j", (input, expected) => {
    expect(calcHash(input)).toBe(expected);
  });
});

describe("toJsonString", () => {
  it("hashes only EMP_ID/ORG_ID/C_CD/AUTH/APPL keys in insertion order", () => {
    const vs = toJsonString({
      S_EMP_ID: "E1 2",
      S_C_CD: "2202010",
      X_AUTH: "a/b",
      S_NOTE: "무시",
      S_APPL_TYPE: "1020",
      S_PAGE_PROFILE_ID: "ESS",
    });
    expect(vs).toBe(
      '{"order":"S_EMP_ID,S_C_CD,X_AUTH,S_APPL_TYPE,", "hash":"431d5c464b47a6224876014400a248dd835ba323f551870f38098a6bb0f894c0", "test":"E122202010a2Fb1020"}',
    );
  });

  it("treats null/undefined as empty and strips non-word characters after encoding", () => {
    const vs = toJsonString({ S_ORG_ID: null, S_APPL_ID: undefined, S_EMP_ID: "홍길동", S_ZZ_C_CD: "a,b c" });
    expect(vs).toBe(
      '{"order":"S_ORG_ID,S_APPL_ID,S_EMP_ID,S_ZZ_C_CD,", "hash":"fa8531d16159bf3dbb7df71bd7154a1b3327e8d9668f438ffe154d08a267995f", "test":"ED998DEAB8B8EB8F99abc"}',
    );
  });

  it("yields an empty order when no key is hashed and ignores an existing __viewState", () => {
    const vs = toJsonString({ S_DSCLASS: "x", __viewState: "old", S_FORWARD: "xsheetResultJson" });
    expect(vs).toBe(
      '{"order":"", "hash":"aa6ac2d4961882f42a345c7615f4133dde8e6d6e7c1b6b40ae4ff6ee52c393d0", "test":""}',
    );
  });
});
