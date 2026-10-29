import assert from "node:assert/strict";
import { test } from "node:test";

import { EmsService, SerialQueue, localTime, validateSearch, emsDateTime } from "../dist/core.js";
import { EmsError, changeSchema, errorResult } from "../dist/types.js";

const now = () => Date.parse("2026-10-09T12:00:00Z");
const input = {
	operation: "create",
	template_id: "23",
	room_id: "125",
	start: "2026-10-10T10:00:00-04:00",
	end: "2026-10-10T11:00:00-04:00",
	attendance: 2,
	event_name: "Fixture booking",
	contact_name: "Test Student",
	contact_email: "student@fixture.invalid",
};
function fixture() {
	let clock = now(),
		identity = "account-one",
		changed = false,
		calls = 0,
		uncertain = false;
	const adapter = {
		async prepare(change) {
			return {
				identity,
				preview: {
					operation: change.operation,
					account: "Test Student",
					timezone: "America/New_York",
					start: changed ? "different" : change.start,
				},
			};
		},
		async submit() {
			calls++;
			if (uncertain) throw new Error("lost response");
			return { reservation_id: "101", status: "Pending Approval" };
		},
	};
	const journal = [];
	const service = new EmsService(
		adapter,
		() => clock,
		async () => {
			journal.push("intent");
		},
		false,
		async () => {
			journal.push("verified");
		},
	);
	return {
		service,
		journal,
		get calls() {
			return calls;
		},
		expire: () => {
			clock += 600001;
		},
		advance: (ms) => {
			clock += ms;
		},
		switchAccount: () => {
			identity = "account-two";
		},
		change: () => {
			changed = true;
		},
		uncertain: () => {
			uncertain = true;
		},
	};
}
void test("Eastern Time offsets and daylight-saving transitions remain explicit", () => {
	assert.equal(localTime("2026-01-10T15:00:00Z").iso, "2026-01-10T10:00:00-05:00");
	assert.equal(localTime("2026-10-10T14:00:00Z").iso, "2026-10-10T10:00:00-04:00");
	assert.equal(localTime("2026-11-01T05:30:00Z").iso, "2026-11-01T01:30:00-04:00");
	assert.equal(localTime("2026-11-01T06:30:00Z").iso, "2026-11-01T01:30:00-05:00");
});
void test("reject past/reversed/overnight times, seconds, invalid dates and unknown fields", () => {
	const search = {
		template_id: input.template_id,
		start: input.start,
		end: input.end,
		attendance: 2,
	};
	assert.equal(validateSearch(search, now()).attendance, 2);
	for (const change of [
		{ start: "2026-10-08T10:00:00-04:00" },
		{ end: search.start },
		{ end: "2026-10-11T01:00:00-04:00" },
		{ start: "2026-10-10T10:00:30-04:00" },
		{ start: "2026-02-30T10:00:00-05:00" },
		{ start: "2026-10-10T10:00:00" },
		{ unknown: true },
	])
		assert.throws(() => validateSearch({ ...search, ...change }, now()));
	assert.throws(() => changeSchema.parse({ ...input, contact_email: undefined }));
	assert.throws(() =>
		changeSchema.parse({
			operation: "update",
			event_name: "Changes all bookings",
			reservation_id: "101",
			booking_id: "201",
		}),
	);
});
void test("EMS display dates become explicit Eastern offsets and ambiguous displays fail closed", () => {
	assert.equal(emsDateTime("Sat Oct 10, 2026", "10:00 AM"), "2026-10-10T10:00:00-04:00");
	assert.equal(emsDateTime("01/10/2026", "10:00 AM"), "2026-01-10T10:00:00-05:00");
	assert.throws(() => emsDateTime("11/01/2026", "1:30 AM"), { code: "ambiguous_time" });
	assert.throws(() => emsDateTime("03/08/2026", "2:30 AM"), { code: "ambiguous_time" });
	assert.throws(
		() =>
			validateSearch(
				{
					template_id: "23",
					start: "2026-11-01T01:30:00-04:00",
					end: "2026-11-01T02:30:00-05:00",
					attendance: 1,
				},
				now(),
			),
		{ code: "ambiguous_time" },
	);
});
void test("prepare does not submit; commit preserves pending approval and consumes draft", async () => {
	const f = fixture(),
		draft = await f.service.prepare(input);
	assert.equal(f.calls, 0);
	assert.equal(Date.parse(draft.expires_at), now() + 600000);
	await assert.rejects(() => f.service.commit(draft.draft_id, false), {
		code: "confirmation_required",
	});
	const result = await f.service.commit(draft.draft_id, true);
	assert.equal(result.reservation.status, "Pending Approval");
	assert.equal(f.calls, 1);
	assert.deepEqual(f.journal, ["intent", "verified"]);
	await assert.rejects(() => f.service.commit(draft.draft_id, true), { code: "draft_expired" });
	assert.equal(f.calls, 1);
});
for (const [scenario, modify, code] of [
	["expiry", "expire", "draft_expired"],
	["account switch", "switchAccount", "account_changed"],
	["changed preview", "change", "preview_changed"],
]) {
	void test(`${scenario} prevents submission`, async () => {
		const f = fixture(),
			draft = await f.service.prepare(input);
		f[modify]();
		await assert.rejects(() => f.service.commit(draft.draft_id, true), { code });
		assert.equal(f.calls, 0);
	});
}
void test("a booking that starts during the preview window cannot be submitted in the past", async () => {
	const f = fixture();
	const draft = await f.service.prepare({
		...input,
		start: "2026-10-09T08:05:00-04:00",
		end: "2026-10-09T08:30:00-04:00",
	});
	f.advance(360000);
	await assert.rejects(() => f.service.commit(draft.draft_id, true), { code: "invalid_time" });
	assert.equal(f.calls, 0);
	assert.deepEqual(f.journal, []);
});
void test("booking conflict and permission/auth failures are not converted into success", async () => {
	for (const code of [
		"availability_conflict",
		"auth_required",
		"permission_denied",
		"unsupported_services",
		"unsupported_template",
		"required_fields",
	]) {
		const service = new EmsService(
			{
				async prepare() {
					throw new EmsError(code, "Fixture rejection");
				},
			},
			now,
		);
		await assert.rejects(() => service.prepare(input), { code });
	}
});
void test("uncertain write is journaled, never replayed, and blocks subsequent writes", async () => {
	const f = fixture(),
		draft = await f.service.prepare(input);
	f.uncertain();
	await assert.rejects(() => f.service.commit(draft.draft_id, true), {
		code: "submission_uncertain",
	});
	assert.deepEqual(f.journal, ["intent"]);
	assert.equal(f.calls, 1);
	await assert.rejects(() => f.service.commit(draft.draft_id, true), { code: "draft_expired" });
	await assert.rejects(() => f.service.prepare(input), { code: "reconciliation_required" });
	const restart = new EmsService({}, now, async () => {}, true);
	await assert.rejects(() => restart.prepare(input), { code: "reconciliation_required" });
});
void test("single booking changes require reservation and booking identity", () => {
	assert.deepEqual(
		changeSchema.parse({ operation: "cancel", reservation_id: "101", booking_id: "201" }),
		{ operation: "cancel", reservation_id: "101", booking_id: "201" },
	);
	assert.throws(() => changeSchema.parse({ operation: "cancel", reservation_id: "101" }));
	assert.throws(() =>
		changeSchema.parse({
			operation: "cancel",
			reservation_id: "101",
			booking_id: "201",
			entire_series: true,
		}),
	);
});
void test("queue serializes operations, including after failure", async () => {
	const queue = new SerialQueue(),
		events = [];
	const first = queue.run(async () => {
		events.push("first");
		await Promise.resolve();
		throw new Error("fixture");
	});
	const second = queue.run(async () => events.push("second"));
	await assert.rejects(first);
	await second;
	assert.deepEqual(events, ["first", "second"]);
});
void test("generic browser errors do not disclose private URLs or credentials", () => {
	assert.ok(!JSON.stringify(errorResult(new Error("cookie=secret"))).includes("secret"));
});
