import { describe, expect, it } from "vitest";
import { ApplicationBlockedError } from "../src/appl.js";
import { parsePage, PageStructureError } from "../src/page.js";
import { checkScheduleRequest, parseCalendar, parseScheduleTokens } from "../src/schedule.js";

const cell = (ymd: string, able: "Y" | "N", type: string, time: string) =>
  `<td class='' ymd= '${ymd}' onclick='onClickTd(this);' weekDay=2 planAbleYn='${able}'><span class='day'>  2</span>` +
  `<span class='workItem'><span>${type}</span></span><div class='contArea'><p class='workTime'>${time}</p><ul class='workTimeList'></ul></div></td>`;

describe("parseCalendar", () => {
  it("reads date, plannability, work type and plan time per cell", () => {
    expect(parseCalendar(cell("20261102", "Y", "선택근무제(IT)", "09:00~20:00") + cell("20261101", "N", "휴일", ""))).toEqual([
      { ymd: "20261102", plannable: true, workType: "선택근무제(IT)", planTime: "09:00~20:00" },
      { ymd: "20261101", plannable: false, workType: "휴일", planTime: "" },
    ]);
  });

  it("returns nothing for an empty calendar", () => {
    expect(parseCalendar("")).toEqual([]);
  });
});

const tok = (name: string) => `${name}`.padEnd(48, "A");

function popupHtml(opts: { mode?: string; appl?: string; noSave?: boolean } = {}): string {
  return `<script>
var S_PGM_OPEN_TIME = "1"; var S_ENC_OTP_KEY = "k"; var S_CSRF_SALT = "s";
function LoadPage() {
  $("#S_WORK_TYPE_CHANGE_OPT").val("${opts.mode ?? "ETC"}");
  if( "${opts.appl ?? ""}" == "APPL") {}
}
function doAction(sAction) { switch(sAction) {
  case "${tok("Calendar")}":
    {
      $(".e-cal").find('tbody').html("");
    }
}}
function getWorkTypeChangeOpt()
{
  ajaxSyncRequestXS($("#S_DSCLASS").val(), "${tok("WorkTypes")}", {}, function(xs) {});
}
</script>
<input type="hidden" id="S_DSCLASS" name="S_DSCLASS" value="${tok("Class")}" />
<input type="hidden" id="S_WORK_TYPE_OPT" name="S_WORK_TYPE_OPT" value="ETC"/>
${opts.noSave ? "" : `<input type="button" class="btnMainEm" value="등록" id="S_WORK_REG_BTN" onClick="doAction('${tok("Save")}');"`}`;
}

describe("parseScheduleTokens", () => {
  it("finds calendar, work type list and save calls", () => {
    const html = popupHtml();
    expect(parseScheduleTokens(html, parsePage(html))).toMatchObject({
      dsClass: tok("Class"),
      calendar: tok("Calendar"),
      workTypes: tok("WorkTypes"),
      save: tok("Save"),
    });
  });

  it("refuses the approval-based work type change mode", () => {
    const html = popupHtml({ mode: "WORKTYPE" });
    expect(() => parseScheduleTokens(html, parsePage(html))).toThrow(ApplicationBlockedError);
  });

  it("refuses the application mode", () => {
    const html = popupHtml({ appl: "APPL" });
    expect(() => parseScheduleTokens(html, parsePage(html))).toThrow(ApplicationBlockedError);
  });

  it("fails closed when the save button is missing", () => {
    const html = popupHtml({ noSave: true });
    expect(() => parseScheduleTokens(html, parsePage(html))).toThrow(PageStructureError);
  });
});

describe("checkScheduleRequest", () => {
  it("accepts a month and a same-day range", () => {
    expect(() => checkScheduleRequest("202611", "0900", "1900")).not.toThrow();
  });

  it("rejects month 13", () => {
    expect(() => checkScheduleRequest("202613", "0900", "1900")).toThrow("YYYYMM");
  });

  it("rejects equal start and end (boundary)", () => {
    expect(() => checkScheduleRequest("202611", "0900", "0900")).toThrow(ApplicationBlockedError);
  });
});
