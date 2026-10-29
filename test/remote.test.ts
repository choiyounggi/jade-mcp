import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import { PageStructureError } from "../src/page.js";
import {
  isWorkName,
  parseDefaultWorkTypes,
  parseRemoteWorkTokens,
  planRemoteWorkDates,
  remoteWorkReason,
  weeksOfMonth,
  type CalendarCell,
} from "../src/remote.js";

const tok = (name: string) => `${name}`.padEnd(48, "A");

// 실제 재택 근무 신청서 화면의 doAction2 분기 배치만 본뜬 합성 HTML
function formHtml(opts: { dropClose?: boolean; same?: boolean } = {}): string {
  const t = opts.same ? () => tok("Same") : tok;
  return `<script>
function LoadPage() {
  setCombo(cbTM80, "S_ORG_WORK_TYPE", null, "N");
  setCombo("고정근무제□1010■선택근무제(IT)□2021■재택근무제□2040■휴일□3010■선택불가□9900", "S_WORK_TYPE", null, "N");
}
function doAction2(sAction, p1) { switch(sAction) {
  case "${t("Target")}": { Apply.changeTRG(); } break;
  case "${t("Org")}": {
    $("#S_ORG_WORK_TYPE").val("");
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) {});
  } break;
  ${opts.dropClose ? "" : `case "${t("Close")}" : {
    ajaxSyncRequestXS($("#S_DSCLASS").val(), $("#S_DSMETHOD").val(), serializeForm("f1"), function(xs) {
      var msg = xs.GetEtcData("rtnMsg");
    });
  } break;`}
  case "${t("List")}": {
    $("#S_WORK_TYPE").empty();
  } break;
}}
</script>`;
}

describe("parseRemoteWorkTokens", () => {
  it("분기 안의 코드 모양으로 원근무유형·목록·마감 검사 토큰을 찾는다", () => {
    expect(parseRemoteWorkTokens(formHtml())).toEqual({ orgWorkType: tok("Org"), workTypes: tok("List"), closeCheck: tok("Close") });
  });

  it("마감 검사 분기가 없으면 요청을 보내지 않고 멈춘다", () => {
    expect(() => parseRemoteWorkTokens(formHtml({ dropClose: true }))).toThrow(PageStructureError);
  });

  it("서로 다른 분기가 같은 토큰으로 잡히면 멈춘다", () => {
    expect(() => parseRemoteWorkTokens(formHtml({ same: true }))).toThrow(PageStructureError);
  });
});

describe("parseDefaultWorkTypes", () => {
  it("S_WORK_TYPE 기본 목록을 이름·코드로 읽는다", () => {
    expect(parseDefaultWorkTypes(formHtml())).toContainEqual({ code: "2040", name: "재택근무제" });
  });

  it("목록이 없으면 멈춘다", () => {
    expect(() => parseDefaultWorkTypes("<script></script>")).toThrow(PageStructureError);
  });
});

describe("weeksOfMonth", () => {
  it("평일이 다음 달로 넘어가는 마지막 주는 뺀다 (2026-11: 11/30 주 제외)", () => {
    expect(weeksOfMonth("202611").map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
  });

  it("1일이 주중이면 전달에서 시작하는 주를 첫 주로 넣는다 (2026-10: 9/28 주)", () => {
    expect(weeksOfMonth("202610")[0]!.toISOString().slice(0, 10)).toBe("2026-09-28");
  });

  it("월 형식이 틀리면 막는다", () => {
    expect(() => weeksOfMonth("202613")).toThrow(ApplicationBlockedError);
  });
});

const WORK = new Set(["고정근무제", "선택근무제(IT)", "재택근무제"]);

function novemberCalendar(edit: (c: CalendarCell[]) => void = () => {}): CalendarCell[] {
  const cells: CalendarCell[] = [];
  for (let d = 1; d <= 30; d++) {
    const dow = new Date(Date.UTC(2026, 10, d)).getUTCDay();
    cells.push({ ymd: `202611${String(d).padStart(2, "0")}`, workType: dow === 0 || dow === 6 ? "휴일" : "선택근무제(IT)", remarks: [] });
  }
  edit(cells);
  return cells;
}

describe("planRemoteWorkDates", () => {
  it("각 주의 요청 요일을 고른다", () => {
    const r = planRemoteWorkDates("202611", "mon", novemberCalendar(), WORK, "20261029");
    expect(r.dates).toEqual(["20261102", "20261109", "20261116", "20261123"]);
    expect(r.skipped).toEqual([]);
  });

  it("주중에 공휴일이 있는 주는 통째로 뺀다", () => {
    const cal = novemberCalendar((c) => (c[10]!.workType = "개천절")); // 11/11 수
    const r = planRemoteWorkDates("202611", "mon", cal, WORK, "20261029");
    expect(r.dates).toEqual(["20261102", "20261116", "20261123"]);
    expect(r.skipped[0]!.reason).toContain("개천절");
  });

  it("휴가 표시가 있는 주는 통째로 뺀다", () => {
    const cal = novemberCalendar((c) => (c[19]!.remarks = ["연차휴가(2h)"])); // 11/20 금
    const r = planRemoteWorkDates("202611", "mon", cal, WORK, "20261029");
    expect(r.dates).toEqual(["20261102", "20261109", "20261123"]);
    expect(r.skipped[0]!.reason).toContain("휴가");
  });

  it("지난 날짜와 이미 재택인 날은 뺀다", () => {
    const cal = novemberCalendar((c) => (c[8]!.workType = "재택근무제")); // 11/9
    const r = planRemoteWorkDates("202611", "mon", cal, WORK, "20261102");
    expect(r.dates).toEqual(["20261116", "20261123"]);
    expect(r.skipped).toHaveLength(2);
  });

  it("달력에 없는 날이 있는 주는 확인 불가로 뺀다", () => {
    const r = planRemoteWorkDates("202611", "fri", [], WORK, "20261029");
    expect(r.dates).toEqual([]);
    expect(r.skipped).toHaveLength(4);
  });
});

describe("isWorkName", () => {
  it("근무제는 근무일, 휴일·선택불가·(X) 유형은 휴무로 본다", () => {
    expect(isWorkName("선택근무제(IT)")).toBe(true);
    expect(isWorkName("휴일")).toBe(false);
    expect(isWorkName("재택근무제(X)")).toBe(false);
  });
});

describe("remoteWorkReason", () => {
  it("월·일을 앞자리 0 없이 쓴다", () => {
    expect(remoteWorkReason("20261102")).toBe("11월 2일 재택근무 신청드립니다.");
  });
});
