import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BrowserAdapter } from "../dist/adapter.js";
import { EmsBrowser } from "../dist/browser.js";
import { EmsService, localTime } from "../dist/core.js";
import { EMS_BASE } from "../dist/types.js";

// Every request is intercepted. This suite NEVER contacts EMS or Yale SSO.
// Markup uses selectors inspected on v226.2, with synthetic identities/data.
const names = ["Evans Hall - Breakout Rooms", "Evans Hall - Interview Rooms", "Fit for Thought"];
const ids = ["23", "61", "34"];
const header = '<button id="usernameid">Test Student</button>';
const escape = (s) =>
	String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const details = `<section id="details" hidden>
  <label for="event-name">Event Name *</label><input id="event-name" required>
  <label for="event-type">Event Type *</label><select id="event-type" required><option value="12">Meeting</option><option value="20">Interview</option></select>
  <label for="availablegroups">Group *</label><select id="availablegroups" required><option value="1">Fixture Class</option></select>
  <select id="1stcontact"><option value="0">(temporary contact)</option></select>
  <label for="1stContactName">Contact Name *</label><input id="1stContactName" required>
  <label for="1stContactEmail">Contact Email *</label><input id="1stContactEmail" type="email" required>
  <input id="1stContactPhone1"><input id="add-to-calendar" type="checkbox">
  <button id="create" data-bind="click: function(){ return saveReservation(); }">Create Reservation</button><button id="create-footer" data-bind="click: function(){ return saveReservation(); }">Create Reservation</button></section>`;
const clockPicker = `<div class="bootstrap-datetimepicker-widget" hidden><div class="timepicker">
  <span data-action="togglePeriod">AM</span><button data-action="showHours">Pick Hour</button><button data-action="showMinutes">Pick Minute</button>
  <div class="timepicker-hours" hidden>${Array.from({ length: 12 }, (_, i) =>
		String(i || 12).padStart(2, "0"),
	)
		.map((h) => `<button data-action="selectHour" aria-label="${h}">${h}</button>`)
		.join("")}</div>
  <div class="timepicker-minutes" hidden>${["00", "15", "30", "45"].map((m) => `<button data-action="selectMinute" aria-label="${m}">${m}</button>`).join("")}</div>
  <button data-action="close">Close</button></div></div>`;
void test("browser adapter exercises discovery, empty/conflicting searches and create/update/cancel against an isolated EMS fixture", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ems-browser-"));
	const browser = new EmsBrowser(join(dir, "profile"), "chrome");
	const adapter = new BrowserAdapter(browser);
	let writes = 0,
		state = null,
		empty = false,
		wrongInterval = false,
		emptyInfo = false,
		unknownTemplate = false,
		sibling = false,
		delayedIdentity = true;
	const start = new Date(Date.now() + 172800000);
	start.setUTCHours(14, 0, 0, 0);
	const end = new Date(start.getTime() + 3600000);
	const input = {
		operation: "create",
		template_id: "23",
		room_id: "125",
		start: start.toISOString(),
		end: end.toISOString(),
		attendance: 2,
		event_name: "Fixture booking",
		contact_name: "Test Student",
		contact_email: "student@fixture.invalid",
	};
	const startIso = localTime(input.start).iso,
		endIso = localTime(input.end).iso;
	try {
		const page = await browser.page();
		await page
			.context()
			.addCookies([{ name: "FixtureSession", value: "synthetic", url: EMS_BASE, httpOnly: true }]);
		await page.context().route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (url.origin !== new URL(EMS_BASE).origin) return route.abort();
			if (url.pathname.endsWith("/GetAvailabilityList")) {
				return route.fulfill({ json: { d: JSON.stringify({ Success: true, Availability: [] }) } });
			}
			if (url.pathname.endsWith("/PopulateReservationList"))
				return route.fulfill({ json: { d: "[]" } });
			if (url.pathname.endsWith("/FixtureSubmit")) {
				const change = route.request().postDataJSON();
				writes++;
				if (change.operation === "cancel") state.status = "Cancelled";
				else
					state = {
						name: "Fixture booking",
						status: "Pending Approval",
						start: change.start,
						end: change.end,
						room: "2260 Demo Breakout",
					};
				return route.fulfill({ json: { ok: true } });
			}
			let html =
				delayedIdentity && url.pathname.endsWith("/Default.aspx")
					? '<button id="usernameid">Welcome, Guest.</button><script>setTimeout(()=>document.querySelector("#usernameid").textContent="Test Student",80)</script>'
					: header;
			if (url.pathname.endsWith("/RoomRequest.aspx") && !url.search) {
				html += `<div id="templates-grid">${names.map((n, i) => `<button data-templateid="${ids[i]}" data-navigateurl="RoomRequest.aspx?data=${ids[i]}" aria-label="About The &quot;${n}&quot; Template" onclick="document.querySelector('#template-modal').hidden=false">About</button>`).join("")}</div><div id="template-modal" style="min-height:1px;min-width:1px" tabindex="-1" hidden onkeydown="if(event.key==='Escape')this.hidden=true">${emptyInfo ? "" : '<div class="modal-body">Fixture rule: one-time bookings, maximum three hours.</div><button data-dismiss="modal" onclick="this.parentElement.hidden=true">Close</button>'}</div>`;
			} else if (url.pathname.endsWith("/RoomRequest.aspx")) {
				const editing = url.searchParams.get("data") === "edit";
				html += `<div id="date-time-collapse"><input id="booking-date-input"><div id="booking-start"><input id="start-time-input" value="8:30 AM"><button class="input-group-addon">Edit booking start time</button></div><div id="booking-end"><input id="end-time-input" value="9:30 AM"><button class="input-group-addon">Edit booking end time</button></div><select id="timeZoneDrop" ${editing ? "disabled" : ""}><option>Eastern Time</option>${editing ? "" : "<option selected>UTC</option>"}</select><button onclick="document.querySelector('#search-room-collapse').hidden=false">Let Me Search For A Room</button><section id="search-room-collapse" hidden><input id="Number of People-input-box" type="number"></section><button id="search">Search</button></div>${clockPicker}
          <a role="tab" id="list-tab">List</a><table id="available-list"><tbody></tbody></table>
          <div id="setup-add-modal" hidden><input id="setup-add-count"><button id="setup--add-modal-save">Add Room</button></div>
          <nav id="main-tabs"><a href="#details" onclick="document.querySelector('#details').hidden=false">Reservation Details</a></nav>
          <button id="responsive-save-btn" hidden>Next Step</button>${details}
          ${editing ? '<button id="update" data-bind="click: $root.cart.updateBooking, visible: $root.cart.bookingEditing() != null">Update Booking</button><button id="update-footer" data-bind="click: $root.cart.updateBooking, visible: $root.cart.bookingEditing() != null">Update Booking</button>' : ""}
          <div id="reservation-created-dialog" hidden><a id="view-this-reservation-action" href="ReservationSummary.aspx?data=101">View Reservation</a></div>
          <script>
          const editing=${editing};
          document.querySelector('#timeZoneDrop').onchange=()=>{document.querySelector('#start-time-input').value='8:30 AM';document.querySelector('#end-time-input').value='9:30 AM';};
          const picker=document.querySelector('.bootstrap-datetimepicker-widget');let selectedClock,hour,minute,period;
          const hours=picker.querySelector('.timepicker-hours'),minutes=picker.querySelector('.timepicker-minutes'),periodControl=picker.querySelector('[data-action="togglePeriod"]');
          function updateTime(){document.querySelector('#'+selectedClock+'-time-input').value=hour+':'+minute+' '+period;periodControl.textContent=period;}
          for(const kind of ['start','end'])document.querySelector('#booking-'+kind+' .input-group-addon').onclick=()=>{selectedClock=kind;const t=document.querySelector('#'+kind+'-time-input').value.match(/(\\d+):(\\d+) (AM|PM)/);hour=Number(t[1]);minute=t[2];period=t[3];periodControl.textContent=period;hours.hidden=true;minutes.hidden=true;picker.hidden=false;};
          periodControl.onclick=()=>{period=period==='AM'?'PM':'AM';updateTime();};
          picker.querySelector('[data-action="showHours"]').onclick=()=>hours.hidden=false;
          picker.querySelector('[data-action="showMinutes"]').onclick=()=>minutes.hidden=false;
          for(const cell of hours.children)cell.onclick=()=>{hour=Number(cell.getAttribute('aria-label'));updateTime();hours.hidden=true;};
          for(const cell of minutes.children)cell.onclick=()=>{minute=cell.getAttribute('aria-label');updateTime();minutes.hidden=true;};
          picker.querySelector('[data-action="close"]').onclick=()=>picker.hidden=true;
          function data(){const d=document.querySelector('#booking-date-input').value.split('/');const parse=(id)=>{const t=document.querySelector(id).value.match(/(\\d+):(\\d+) (AM|PM)/);return String(Number(t[1])%12+(t[3]==='PM'?12:0)).padStart(2,'0')+':'+t[2]+':00';};const date=d[2]+'-'+d[0]+'-'+d[1];return {searchData:{TemplateId:'${wrongInterval || (editing && unknownTemplate) ? "999" : editing ? "23" : url.searchParams.get("data")}',Start:date+' '+parse('#start-time-input'),End:date+' '+parse('#end-time-input'),Dates:[date+' 00:00:00']}};}
          async function search(){await fetch('Server.aspx/GetAvailabilityList',{method:'POST',body:JSON.stringify(data()),headers:{'content-type':'application/json'}});document.querySelector('#available-list tbody').innerHTML=${JSON.stringify(empty ? "" : `<tr data-room-id="125"><td><a href="#" class="add-to-cart" onclick="document.querySelector('#setup-add-modal').hidden=false">Add Room</a></td><td></td><td><a href="#">2260 Demo Breakout</a></td><td hidden></td><td>Evans Hall</td><td>Second Floor</td><td>ET</td><td>8</td><td></td></tr>`)};}
          document.querySelector('#search').onclick=search;document.querySelector('#list-tab').onclick=search;
          document.querySelector('#setup--add-modal-save').onclick=()=>document.querySelector('#setup-add-modal').hidden=true;
          async function submit(operation){const d=data().searchData;await fetch('FixtureSubmit',{method:'POST',body:JSON.stringify({operation,start:d.Start.replace(' ','T')+'${startIso.slice(19)}',end:d.End.replace(' ','T')+'${endIso.slice(19)}'}),headers:{'content-type':'application/json'}});document.querySelector('#reservation-created-dialog').hidden=false;}
          document.querySelector('#create').onclick=()=>submit('create');
          document.querySelector('#create-footer').onclick=()=>submit('create');
          if(editing)document.querySelector('#update').onclick=()=>submit('update').then(()=>location.href='ReservationSummary.aspx?data=101');
          </script>`;
			} else if (url.pathname.endsWith("/BrowseReservations.aspx")) {
				const row = state
					? `<tr><td><span hidden>(CANCELLED) </span><a href="ReservationSummary.aspx?data=101">${escape(state.name)}</a></td><td>Fixture dates</td><td>Evans Hall</td><td>Fixture Class</td><td><i title="Has Services" style="display:none"></i></td><td>101</td><td>${state.status}</td></tr>`
					: '<tr><td colspan="7">There are no current reservations to show.</td></tr>';
				html += `<div id="reservations-container"><span class="webapp-checkbox" role="checkbox" aria-checked="false" onclick="this.setAttribute('aria-checked','true');fetch('ServerApi.aspx/PopulateReservationList',{method:'POST'})"><span>Include cancelled reservations</span></span><input id="reservation-search"><button>Search Reservations</button><a role="tab">Past</a><div id="reservations-grid-current"><table><tbody>${row}</tbody></table></div><div id="reservations-grid-past" hidden><table><tbody></tbody></table></div></div>`;
			} else if (url.pathname.endsWith("/ReservationSummary.aspx") && state) {
				html += `<table id="bookings-grid"><thead><tr><th>Status</th></tr></thead><tbody><tr data-bookingid="201"><td><span data-bind="text: moment(TimeBookingStart).format('ddd ll')">${localTime(state.start).date}</span></td><td data-bind="text: Location">Evans Hall - ${state.room}</td><td data-bind="text: moment(EventStart).format('LT')">${localTime(state.start).time}</td><td data-bind="text: moment(EventEnd).format('LT')">${localTime(state.end).time}</td><td data-bind="text: Status">${state.status}</td><td><a aria-label="Edit Booking" href="RoomRequest.aspx?data=edit">Edit</a><a aria-label="Delete Booking" href="#" onclick="document.querySelector('#cancel-modal').hidden=false">Delete</a></td></tr>${sibling ? `<tr data-bookingid="202"><td data-bind="text: Location">Sibling Room</td><td data-bind="text: EventStart">${startIso}</td><td data-bind="text: EventEnd">${endIso}</td><td data-bind="text: Status">Confirmed</td></tr>` : ""}</tbody></table><div id="cancel-modal" hidden><button id="cancel-btn-yes" onclick="fetch('FixtureSubmit',{method:'POST',body:JSON.stringify({operation:'cancel'}),headers:{'content-type':'application/json'}}).then(()=>location.reload())">Yes</button></div>`;
			}
			return route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><html><body>${html}</body></html>`,
			});
		});
		assert.equal((await adapter.identity()).name, "Test Student");
		delayedIdentity = false;
		const templates = await adapter.templates();
		assert.equal(templates.length, 3);
		assert.ok(templates.every((t) => t.supported));
		assert.ok(templates[0].required_fields.some((f) => f.id === "event-name"));
		const search = {
			template_id: input.template_id,
			start: input.start,
			end: input.end,
			attendance: input.attendance,
		};
		assert.equal((await adapter.search(search)).rooms[0].capacity, 8);
		await assert.rejects(
			() =>
				adapter.search({ ...search, start: new Date(start.getTime() + 7 * 60000).toISOString() }),
			{ code: "unsupported_time_granularity" },
		);
		empty = true;
		assert.deepEqual((await adapter.search(search)).rooms, []);
		await assert.rejects(() => adapter.prepare(input), { code: "availability_conflict" });
		empty = false;
		wrongInterval = true;
		await assert.rejects(() => adapter.search(search), { code: "page_changed" });
		wrongInterval = false;
		const service = new EmsService(adapter);
		const draft = await service.prepare(input);
		assert.equal(writes, 0);
		assert.equal(
			draft.preview.fields.find((f) => f.id === "1stContactEmail").value,
			"student@fixture.invalid",
		);
		const created = await service.commit(draft.draft_id, true);
		assert.equal(writes, 1);
		assert.equal(created.reservation.status, "Pending Approval");
		sibling = true;
		await assert.rejects(
			() =>
				service.prepare({
					...search,
					operation: "update",
					template_id: "999",
					reservation_id: "101",
					booking_id: "201",
					room_id: "125",
				}),
			{ code: "unsupported_template" },
		);
		const update = await service.prepare({
			...search,
			operation: "update",
			reservation_id: "101",
			booking_id: "201",
			room_id: "125",
			start: new Date(start.getTime() + 3600000).toISOString(),
			end: new Date(end.getTime() + 3600000).toISOString(),
		});
		assert.equal(writes, 1);
		const updated = await service.commit(update.draft_id, true);
		assert.equal(writes, 2);
		assert.equal(
			updated.reservation.bookings[0].start,
			localTime(new Date(start.getTime() + 3600000).toISOString()).iso,
		);
		unknownTemplate = true;
		await assert.rejects(
			() => service.prepare({ operation: "cancel", reservation_id: "101", booking_id: "201" }),
			{ code: "unsupported_template" },
		);
		unknownTemplate = false;
		const cancel = await service.prepare({
			operation: "cancel",
			reservation_id: "101",
			booking_id: "201",
		});
		assert.equal(writes, 2);
		const cancelled = await service.commit(cancel.draft_id, true);
		assert.equal(writes, 3);
		assert.equal(cancelled.reservation.bookings[0].status, "Cancelled");
		assert.equal(cancelled.reservation.bookings[1].status, "Confirmed");
		emptyInfo = true;
		assert.ok((await adapter.templates()).every((t) => t.rules.includes("did not expose")));
		assert.equal(writes, 3);
	} finally {
		await adapter.close();
		await rm(dir, { recursive: true, force: true });
	}
});
