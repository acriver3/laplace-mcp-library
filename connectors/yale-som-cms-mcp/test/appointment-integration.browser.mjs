import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { CmsMutations } from "../dist/mutations.js";
import { CmsService } from "../dist/core.js";
import { CMS_ORIGIN, TIMEZONE } from "../dist/types.js";
import { appointmentSlotId } from "../dist/appointment-workflow.js";
const start = "2027-01-05T14:00:00.000Z",
  end = "2027-01-05T14:30:00.000Z";
const booking = {
  operation: "appointment_book",
  area: "appointments",
  target_id: "42",
  slot_id: appointmentSlotId("42", start, end),
  fields: {
    SelectedAppointmentType: "Mock Interview",
    LocationTypeId: "Virtual",
    Topic: "Approved coaching topic",
  },
};
function render(state, input) {
  const times = state.shift
    ? { start: "2027-01-05T15:00:00.000Z", end: "2027-01-05T15:30:00.000Z" }
    : { start, end };
  return `<!doctype html><body><main role="main"></main><script>
 window.TT={CurrentSession:{CurrentUser:{Id:123,TypeId:2}}};const user={Id:123,IsStudent:true,IsAdministrator:false};
 const block={Id:42,State:{Actions:[{ActionTypeId:8,IsAvailable:true}]}};const times=${JSON.stringify(times)};const time=x=>({toISOString:()=>x});
 window.detail={currentUser:user,appointment:${JSON.stringify(state.saved)}};
 window.c={isInitialized:true,isStudent:true,isAdmin:false,currentUser:user,appointmentBookingConfigInfo:{},fileUploader:{files:[],isUploading:false,hasFiles:()=>false,hasError:()=>false,getFileIds:()=>[],AllowedExtensions:['pdf']},appointment:{Id:0,isNew:true,hasBlock:true,StudentId:123,AppointmentBlockId:42,AppointmentBlock:block,StartTime:times.start,EndTime:times.end,IsAttendanceTracking:false,PreferredAppointmentTypeId:null,LocationTypeId:null,Topic:''},availableTimes:[{id:1,start:time(times.start),end:time(times.end)}],setAppointmentTimes(t){this.appointment.StartTime=t.start.toISOString();this.appointment.EndTime=t.end.toISOString();this.selectedTimeSpanId=t.id;}};
 c.form={get $valid(){return !!c.appointment.PreferredAppointmentTypeId&&!!c.appointment.LocationTypeId&&!!c.appointment.Topic}};
 const home={async showDetailSlideout(id){detail.appointment=await(await fetch('/api/v2/appointments/'+id)).json();showDetail();}};
 window.angular={element(e){return {data(){return {$ctrl:{block}}},controller(name){return name==='ttAppointmentForm'?c:name==='ttAppointmentDetail'?detail:name==='ttAppointmentHome'?home:null},injector(){return {has:()=>false}}}}};
 function showBlock(){document.querySelector('main').innerHTML='<div class="block-modal"><h2>Appointment Block</h2><button tt-click="$ctrl.bookAppointment()" onclick="openForm()">View Available Slots</button></div>';}
 function openForm(){document.querySelector('main').innerHTML='<tt-appointment-form><form><label>Appointment Type<select name="SelectedAppointmentType" required onchange="c.appointment.PreferredAppointmentTypeId=Number(this.value.slice(7))"><option value="">Choose type</option><option value="number:7">Mock Interview</option></select></label><fieldset><legend>Location Type</legend><label>Virtual<input type="radio" name="LocationTypeId" value="1" required onchange="c.appointment.LocationTypeId=1"></label><label>In-Person<input type="radio" name="LocationTypeId" value="2" required onchange="c.appointment.LocationTypeId=2"></label></fieldset><label>Additional Information<textarea name="Topic" required oninput="c.appointment.Topic=this.value"></textarea></label><a role="button" href="javascript:void(0)" ng-click="$ctrl.setAppointmentTimes(timeSpan)" onclick="c.setAppointmentTimes(c.availableTimes[0])">9am</a><a role="button" href="javascript:void(0)" tt-click="$ctrl.save()" onclick="save()">Book Appointment</a></form></tt-appointment-form>';history.replaceState({},'', '/appointments/create?blockId=42');}
 async function save(){const response=await fetch('/api/v2/appointments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c.appointment)});detail.appointment=await response.json();showDetail();history.replaceState({},'', '/appointments/?appointmentId='+detail.appointment.Id);}
 function showDetail(){document.querySelector('main').innerHTML='<tt-appointment-home></tt-appointment-home><tt-appointment-detail><h2>Appointment</h2><button ng-click="$ctrl.cancelAppointment()" onclick="openCancel()">Cancel Appointment</button></tt-appointment-detail>';}
 function openCancel(){document.body.insertAdjacentHTML('beforeend','<section class="modal-dialog"><h3>Cancel the Appointment</h3><button onclick="cancelAppointment()">Yes, cancel it</button></section>');}
 async function cancelAppointment(){await fetch('/api/v2/appointments/77/cancel',{method:'PUT',body:'{}'});document.querySelector('.modal-dialog').remove();document.querySelector('tt-appointment-detail').remove();}
 ${input.id === "77" ? "showDetail()" : "showBlock()"};
 </script>`;
}
async function setup(callback) {
  const dir = await mkdtemp(join(tmpdir(), "cms-appointment-pipeline-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = {
    shift: false,
    effects: [],
    remote: [],
    saved: {
      Id: 77,
      StudentId: 123,
      AppointmentBlockId: 42,
      StatusId: 1,
      PreferredAppointmentTypeId: 7,
      LocationTypeId: 1,
      Topic: "Existing topic",
      State: { Actions: [{ ActionTypeId: 10, IsAvailable: true }] },
      StartTime: start,
      EndTime: end,
      Attachments: [],
    },
  };
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.pathname === "/api/v2/appointments" &&
      request.method() === "POST"
    ) {
      assert.ok(
        state.effects.some(
          (e) => e.name === "appointment_book" && e.status === "intended",
        ),
        "intent is persisted before booking",
      );
      const posted = request.postDataJSON();
      state.remote.push("book");
      state.saved = {
        ...posted,
        Id: 77,
        StatusId: 1,
        State: { Actions: [{ ActionTypeId: 10, IsAvailable: true }] },
        Attachments: [],
      };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(state.saved),
      });
    }
    if (
      url.pathname === "/api/v2/appointments/77/cancel" &&
      request.method() === "PUT"
    ) {
      assert.ok(
        state.effects.some(
          (e) => e.name === "appointment_cancel" && e.status === "intended",
        ),
        "intent is persisted before cancellation",
      );
      state.remote.push("cancel");
      state.saved.StatusId = 2;
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    if (
      url.pathname === "/api/v2/appointments/77" &&
      request.method() === "GET"
    )
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(state.saved),
      });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><main role="main">Fixture</main>',
    });
  });
  const fakeBrowser = {
    page: async () => page,
    identity: async () => ({
      key: "fixture-account",
      name: "Fixture student",
      account_id: "123",
    }),
  };
  const reads = {
    read: async (input) => {
      await page.goto(CMS_ORIGIN + "/appointments/");
      await page.setContent(render(state, input));
      assert.deepEqual(pageErrors, [], "Fixture scripts execute successfully");
      return {
        area: "appointments",
        url: page.url(),
        timezone: TIMEZONE,
        title: "Fixture",
        text: "Exact appointment fixture",
        records: [{ id: input.id || "42", name: "Fixture appointment" }],
        context: {},
      };
    },
    navigate: async (area, id) => {
      await reads.read({ area, id, limit: 100 });
      return page;
    },
    recordLocator: async () => {
      throw Error("Appointment workflow must not use row-position locators");
    },
  };
  const mutations = new CmsMutations(fakeBrowser, reads);
  const adapter = {
    ...fakeBrowser,
    read: reads.read,
    form: (c) => mutations.form(c),
    prepare: (c) => mutations.prepare(c),
    submit: (c, recordEffect) =>
      mutations.submit(c, async (effect) => {
        state.effects.push(structuredClone(effect));
        await recordEffect(effect);
        if (
          effect.name === "appointment_book" &&
          effect.status === "intended" &&
          state.afterFinalIntent
        )
          await state.afterFinalIntent(page);
      }),
    capabilities: async () => ({}),
    download: async () => ({}),
    close: async () => {},
  };
  const service = new CmsService(adapter, { profileDir: join(dir, "profile") });
  try {
    await callback({ service, state, page, mutations });
  } finally {
    await service.close();
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("pipeline books an exact slot with generic required fields and a positive own receipt", async () => {
  await setup(async ({ service, state, page }) => {
    const draft = await service.prepare(booking);
    assert.deepEqual(state.remote, []);
    assert.deepEqual(state.effects, []);
    assert.equal(await page.locator("[name=Topic]").inputValue(), "");
    const result = await service.commit(draft.draft_id, true);
    assert.equal(result.status, "verified");
    assert.deepEqual(state.remote, ["book"]);
    assert.equal(state.saved.Topic, booking.fields.Topic);
    assert.equal(state.saved.PreferredAppointmentTypeId, 7);
    assert.equal(state.saved.LocationTypeId, 1);
    assert.equal(state.saved.StartTime, start);
    assert.equal(state.saved.EndTime, end);
    await assert.rejects(() => service.commit(draft.draft_id, true), {
      code: "draft_expired",
    });
    assert.deepEqual(state.remote, ["book"]);
  });
});
test("pipeline cancels only the exact own appointment and reloads its canceled receipt", async () => {
  await setup(async ({ service, state }) => {
    const draft = await service.prepare({
      operation: "appointment_cancel",
      area: "appointments",
      target_id: "77",
    });
    assert.deepEqual(state.remote, []);
    assert.deepEqual(state.effects, []);
    const result = await service.commit(draft.draft_id, true);
    assert.equal(result.status, "verified");
    assert.deepEqual(state.remote, ["cancel"]);
    assert.equal(state.saved.StatusId, 2);
  });
});
test("pipeline rejects changed slots before any intent or provider effect", async () => {
  await setup(async ({ service, state }) => {
    const draft = await service.prepare(booking);
    state.shift = true;
    await assert.rejects(
      () => service.commit(draft.draft_id, true),
      (e) => ["invalid_slot", "preview_changed"].includes(e.code),
    );
    assert.deepEqual(state.effects, []);
    assert.deepEqual(state.remote, []);
  });
});

for (const [name, alter] of [
  [
    "Topic",
    () => {
      c.appointment.Topic = "Unapproved replacement";
    },
  ],
  [
    "appointment type",
    () => {
      c.appointment.PreferredAppointmentTypeId = 99;
    },
  ],
  [
    "location",
    () => {
      c.appointment.LocationTypeId = 2;
    },
  ],
  [
    "attachments",
    () => {
      c.fileUploader.getFileIds = () => [999];
    },
  ],
])
  test(
    "pipeline blocks " + name + " changes during the final journal write",
    async () => {
      await setup(async ({ service, state }) => {
        const draft = await service.prepare(booking);
        state.afterFinalIntent = (page) => page.evaluate(alter);
        await assert.rejects(
          () => service.commit(draft.draft_id, true),
          { code: "submission_uncertain" },
          "a recorded intention cannot be reported as verified after refusal",
        );
        assert.deepEqual(
          state.remote,
          [],
          "no altered appointment reaches the provider",
        );
        assert.ok(
          state.effects.some(
            (e) => e.name === "appointment_book" && e.status === "intended",
          ),
        );
        assert.equal(
          state.effects.some(
            (e) => e.name === "appointment_book" && e.status === "verified",
          ),
          false,
        );
      });
    },
  );
