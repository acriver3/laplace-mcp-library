import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CmsBrowser } from "../dist/browser.js";
import { CMS_ORIGIN } from "../dist/types.js";
import {
  appointmentSlotId,
  openAppointmentWorkflow,
  inspectAppointmentWorkflow,
  selectAppointmentSlot,
  appointmentSubmitControl,
  clickAppointmentSubmit,
  verifyAppointmentOutcome,
} from "../dist/appointment-workflow.js";
const start = "2027-01-05T14:00:00.000Z",
  end = "2027-01-05T14:30:00.000Z";
const slot = appointmentSlotId("42", start, end);
const change = {
  operation: "appointment_book",
  area: "appointments",
  target_id: "42",
  slot_id: slot,
  fields: { Topic: "Fixture" },
  files: [],
};
const html = `<!doctype html><body><main><section class="block-modal"><button tt-click="$ctrl.bookAppointment()" onclick="openForm()">View Available Slots</button></section></main><script>
window.TT={CurrentSession:{CurrentUser:{Id:123,TypeId:2}}};const user={Id:123,IsStudent:true,IsAdministrator:false};window.saveCount=0;window.cancelCount=0;
const time=(x)=>({toISOString:()=>x});const block={Id:42,State:{Actions:[{ActionTypeId:8,IsAvailable:true}]}};
window.c={isInitialized:true,isStudent:true,isAdmin:false,currentUser:user,appointmentBookingConfigInfo:{},form:{$valid:false},fileUploader:{isUploading:false,hasError:()=>false,getFileIds:()=>[]},appointment:{Id:0,isNew:true,hasBlock:true,StudentId:123,AppointmentBlockId:42,AppointmentBlock:block,StartTime:'${start}',EndTime:'${end}',IsAttendanceTracking:false,PreferredAppointmentTypeId:7},availableTimes:[{id:1,start:time('${start}'),end:time('${end}')},{id:2,start:time('2027-01-05T15:00:00.000Z'),end:time('2027-01-05T15:30:00.000Z')}],setAppointmentTimes(t){this.appointment.StartTime=t.start.toISOString();this.appointment.EndTime=t.end.toISOString();this.selectedTimeSpanId=t.id;}};
window.detail={currentUser:user,appointment:{Id:77,StudentId:123,AppointmentBlockId:42,StatusId:1,PreferredAppointmentTypeId:7,Topic:'Fixture',State:{Actions:[{ActionTypeId:10,IsAvailable:true}]},StartTime:'${start}',EndTime:'${end}',Attachments:[{FileId:901}]}};
window.angular={element(e){return {data(k){return {$ctrl:{block}}},controller(name){return name==='ttAppointmentForm'?c:name==='ttAppointmentDetail'?detail:name==='ttAppointmentHome'?{showDetailSlideout(){showDetail();detail.appointment.StatusId=2;}}:null},injector(){return {has:()=>false}}}}};
function openForm(){document.querySelector('main').innerHTML='<tt-appointment-form><form><label>Topic<textarea name="Topic" oninput="c.form.$valid=!!this.value;c.appointment.Topic=this.value"></textarea></label><button type="button" tt-click="$ctrl.save()" onclick="saveCount++">Book Appointment</button></form></tt-appointment-form>';history.replaceState({},'', '/appointments/create?blockId=42');}
window.showDetail=()=>{document.querySelector('main').innerHTML='<tt-appointment-home></tt-appointment-home><tt-appointment-detail><button ng-click="$ctrl.cancelAppointment()" onclick="openCancel()">Cancel Appointment</button></tt-appointment-detail>';history.replaceState({},'', '/appointments/?appointmentId=77');};
window.openCancel=()=>document.body.insertAdjacentHTML('beforeend','<section class="modal-dialog"><h3>Cancel the Appointment</h3><button onclick="cancelCount++;detail.appointment.StatusId=2;this.parentElement.remove()">Yes, cancel it</button></section>');
</script>`;
async function fixture(callback) {
  const dir = await mkdtemp(join(tmpdir(), "cms-appointment-"));
  const browser = new CmsBrowser(join(dir, "profile"));
  try {
    const page = await browser.page();
    await page
      .context()
      .route("**/*", (r) =>
        r.fulfill({ contentType: "text/html", body: html }),
      );
    await page.goto(CMS_ORIGIN + "/appointments/");
    await callback(page);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("booking opener and exact slot selection remain local and reordering cannot retarget time", async () => {
  await fixture(async (page) => {
    const workflow = await openAppointmentWorkflow(page, change);
    assert.equal(workflow.block_id, "42");
    assert.equal(workflow.slots[0].slot_id, slot);
    assert.equal(await page.evaluate(() => saveCount), 0);
    await assert.rejects(() => appointmentSubmitControl(page, change), {
      code: "action_unavailable",
    });
    await page.evaluate(() => {
      c.availableTimes.reverse();
      c.availableTimes.forEach((t, i) => (t.id = i + 1));
    });
    await page.locator("textarea").fill("Fixture");
    await selectAppointmentSlot(page, change);
    const control = await appointmentSubmitControl(page, change);
    await clickAppointmentSubmit(page, change);
    assert.equal(await page.evaluate(() => saveCount), 1);
    assert.equal(await page.evaluate(() => c.selectedTimeSpanId), 2);
    await page.evaluate(() => showDetail());
    const receipt = await verifyAppointmentOutcome(page, change, workflow, 100);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.appointment_id, "77");
    assert.deepEqual(receipt.attachment_file_ids, ["901"]);
  });
});

test("booking rejects mismatched accounts, non-new and unavailable blocks, and stale time spans", async () => {
  await fixture(async (page) => {
    await openAppointmentWorkflow(page, change);
    await page.evaluate(() => (c.appointment.StudentId = 999));
    await assert.rejects(
      () => inspectAppointmentWorkflow(page, "appointment_book", "42"),
      { code: "action_unavailable" },
    );
    await page.evaluate(() => {
      c.appointment.StudentId = 123;
      c.appointment.Id = 77;
    });
    await assert.rejects(
      () => inspectAppointmentWorkflow(page, "appointment_book", "42"),
      { code: "action_unavailable" },
    );
    await page.evaluate(() => {
      c.appointment.Id = 0;
      c.appointment.AppointmentBlock.State.Actions[0].IsAvailable = false;
    });
    await assert.rejects(
      () => inspectAppointmentWorkflow(page, "appointment_book", "42"),
      { code: "action_unavailable" },
    );
    await page.evaluate(() => {
      c.appointment.AppointmentBlock.State.Actions[0].IsAvailable = true;
      c.availableTimes.shift();
    });
    await assert.rejects(() => selectAppointmentSlot(page, change), {
      code: "invalid_slot",
    });
    assert.equal(await page.evaluate(() => saveCount), 0);
  });
});

test("cancellation only exposes the exact final confirmation for the own active appointment", async () => {
  await fixture(async (page) => {
    await page.evaluate(() => showDetail());
    const cancel = {
      operation: "appointment_cancel",
      area: "appointments",
      target_id: "77",
      fields: {},
      files: [],
    };
    const workflow = await openAppointmentWorkflow(page, cancel);
    assert.equal(await page.evaluate(() => cancelCount), 0);
    const control = await appointmentSubmitControl(page, cancel);
    await control.click();
    assert.equal(await page.evaluate(() => cancelCount), 1);
    await page.evaluate(() => {
      document.querySelector("main").innerHTML =
        "<tt-appointment-home></tt-appointment-home>";
    });
    const receipt = await verifyAppointmentOutcome(page, cancel, workflow, 100);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.state.status_id, 2);
    await assert.rejects(
      () => inspectAppointmentWorkflow(page, "appointment_cancel", "77"),
      { code: "action_unavailable" },
    );
  });
});

test("receipt never treats a different student or mismatched appointment time as success", async () => {
  await fixture(async (page) => {
    const workflow = await openAppointmentWorkflow(page, change);
    await page.evaluate(() => {
      showDetail();
      detail.appointment.StudentId = 999;
    });
    assert.equal(
      (await verifyAppointmentOutcome(page, change, workflow, 20)).verified,
      false,
    );
    await page.evaluate(() => {
      detail.appointment.StudentId = 123;
      detail.appointment.StartTime = "2027-01-06T14:00:00Z";
    });
    assert.equal(
      (await verifyAppointmentOutcome(page, change, workflow, 20)).verified,
      false,
    );
    assert.equal(await page.evaluate(() => saveCount), 0);
  });
});

test("receipts preserve approved Topic, appointment type, and location", async () => {
  await fixture(async (page) => {
    const workflow = await openAppointmentWorkflow(page, change);
    await page.evaluate(() => {
      showDetail();
      detail.appointment.Topic = "Changed remotely";
    });
    assert.equal(
      (await verifyAppointmentOutcome(page, change, workflow, 100)).verified,
      false,
    );
    await page.evaluate(() => {
      detail.appointment.Topic = "Fixture";
      detail.appointment.PreferredAppointmentTypeId = 99;
    });
    assert.equal(
      (await verifyAppointmentOutcome(page, change, workflow, 100)).verified,
      false,
    );
    await page.evaluate(() => {
      detail.appointment.PreferredAppointmentTypeId = 7;
      detail.appointment.LocationTypeId = 2;
    });
    assert.equal(
      (await verifyAppointmentOutcome(page, change, workflow, 100)).verified,
      false,
    );
  });
});

test("slot selection waits for appointment-type availability queries before matching time", async () => {
  await fixture(async (page) => {
    await openAppointmentWorkflow(page, change);
    await page.evaluate(() => {
      const original = angular.element;
      window.pending = [
        { url: "/api/v2/appointment-blocks/available-booking-times" },
      ];
      angular.element = (e) => {
        const value = original(e);
        value.injector = () => ({
          has: () => true,
          get: () => ({ pendingRequests: window.pending }),
        });
        return value;
      };
      setTimeout(() => {
        c.availableTimes.shift();
        window.pending = [];
      }, 80);
    });
    await assert.rejects(() => selectAppointmentSlot(page, change), {
      code: "invalid_slot",
    });
    assert.equal(await page.evaluate(() => saveCount), 0);
  });
});
