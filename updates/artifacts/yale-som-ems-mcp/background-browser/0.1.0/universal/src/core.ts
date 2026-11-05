import { createHash, randomUUID } from "node:crypto";

import {
	Change,
	EmsAdapter,
	EmsError,
	Prepared,
	Search,
	TIMEZONE,
	changeSchema,
	searchSchema,
} from "./types.js";

const clockFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: TIMEZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZoneName: "longOffset",
});
export function localTime(iso: string) {
	const p = Object.fromEntries(
		clockFormat.formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
	);
	const hours = Number(p.hour);
	return {
		date: `${p.month}/${p.day}/${p.year}`,
		time: `${hours % 12 || 12}:${p.minute} ${hours < 12 ? "AM" : "PM"}`,
		iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00${p.timeZoneName.replace("GMT", "") || "+00:00"}`,
	};
}
export function emsDateTime(date: string, time: string): string {
	if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time)) return localTime(time).iso;
	const numeric = date.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
	const iso = date.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
	const named = date.match(
		/\b(Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+(\d{1,2}),?\s+(\d{4})\b/i,
	);
	const months = [
		"jan",
		"feb",
		"mar",
		"apr",
		"may",
		"jun",
		"jul",
		"aug",
		"sep",
		"oct",
		"nov",
		"dec",
	];
	const year = Number(numeric?.[3] || iso?.[1] || named?.[3]);
	const month = numeric
		? Number(numeric[1])
		: iso
			? Number(iso[2])
			: named
				? months.indexOf(named[1].slice(0, 3).toLowerCase()) + 1
				: 0;
	const day = Number(numeric?.[2] || iso?.[3] || named?.[2]);
	const clock = time.match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\b/i);
	if (!year || !month || !day || !clock)
		throw new EmsError("page_changed", "EMS did not expose a readable booking date and time.");
	const hour = clock[3]
		? (Number(clock[1]) % 12) + (clock[3].toUpperCase() === "PM" ? 12 : 0)
		: Number(clock[1]);
	const candidate = Date.UTC(year, month - 1, day, hour, Number(clock[2]));
	const expected = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${clock[2]}:00`;
	const matches = [4, 5]
		.map((offset) => localTime(new Date(candidate + offset * 3600000).toISOString()).iso)
		.filter((value) => value.slice(0, 19) === expected);
	if (matches.length !== 1)
		throw new EmsError(
			"ambiguous_time",
			"EMS displayed an ambiguous or nonexistent Eastern Time booking. Inspect that booking directly in EMS.",
		);
	return matches[0];
}
export function validateSearch(value: unknown, now = Date.now()): Search {
	const input = searchSchema.parse(value);
	if (Date.parse(input.start) <= now || Date.parse(input.end) <= Date.parse(input.start))
		throw new EmsError("invalid_time", "Start must be in the future and end must follow start.");
	if (localTime(input.start).date !== localTime(input.end).date)
		throw new EmsError(
			"unsupported_booking",
			"V1 supports one room on one Eastern Time calendar day.",
		);
	for (const timestamp of [input.start, input.end]) {
		const local = localTime(timestamp);
		// The EMS web form cannot select between two identical fall-back clocks.
		emsDateTime(local.date, local.time);
	}
	if (
		[input.start, input.end].some(
			(s) => new Date(s).getUTCSeconds() !== 0 || new Date(s).getUTCMilliseconds() !== 0,
		)
	)
		throw new EmsError("invalid_time", "EMS bookings use whole minutes.");
	return input;
}
export function fingerprint(value: unknown): string {
	function sorted(x: unknown): unknown {
		return Array.isArray(x)
			? x.map(sorted)
			: x && typeof x === "object"
				? Object.fromEntries(
						Object.entries(x)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, v]) => [k, sorted(v)]),
					)
				: x;
	}
	return createHash("sha256")
		.update(JSON.stringify(sorted(value)))
		.digest("hex");
}
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(call: () => Promise<T>): Promise<T> {
		const result = this.tail.then(call);
		this.tail = result.catch(() => undefined);
		return result;
	}
}
type Draft = { change: Change; prepared: Prepared; expires: number };
export class EmsService {
	readonly queue = new SerialQueue();
	private drafts = new Map<string, Draft>();
	private uncertain: boolean;
	constructor(
		readonly adapter: EmsAdapter,
		private now = Date.now,
		private markUncertain: (change: Change) => Promise<void> = async () => {},
		uncertain = false,
		private clearUncertain: () => Promise<void> = async () => {},
	) {
		this.uncertain = uncertain;
	}
	private validate(change: Change) {
		if (change.operation === "cancel") return;
		const { template_id, start, end, attendance, room, floor, room_type, features } = change;
		validateSearch(
			{ template_id, start, end, attendance, room, floor, room_type, features },
			this.now(),
		);
	}
	async prepare(value: unknown) {
		if (this.uncertain)
			throw new EmsError(
				"reconciliation_required",
				"A previous submission has an uncertain outcome. Inspect My Events, then acknowledge it locally with status --acknowledge-uncertain before making another change.",
			);
		const change = changeSchema.parse(value);
		this.validate(change);
		const prepared = await this.adapter.prepare(change);
		for (const [id, draft] of this.drafts) if (draft.expires <= this.now()) this.drafts.delete(id);
		if (this.drafts.size >= 50)
			throw new EmsError(
				"too_many_drafts",
				"Finish or allow existing previews to expire before preparing more changes.",
			);
		const draft_id = randomUUID();
		const expires = this.now() + 600_000;
		this.drafts.set(draft_id, {
			change: structuredClone(change),
			prepared: structuredClone(prepared),
			expires,
		});
		return {
			draft_id,
			expires_at: new Date(expires).toISOString(),
			preview: prepared.preview,
			instructions:
				"Show this entire preview to the user. Call ems_commit_change only after they confirm these exact details.",
		};
	}
	async commit(id: string, confirm: boolean) {
		if (confirm !== true)
			throw new EmsError(
				"confirmation_required",
				"The user must confirm the displayed preview before submission.",
			);
		const draft = this.drafts.get(id);
		// Consume before any asynchronous operation; failed attempts cannot replay the same draft.
		this.drafts.delete(id);
		if (!draft || draft.expires <= this.now())
			throw new EmsError("draft_expired", "Prepare a fresh preview before submitting.");
		if (this.uncertain)
			throw new EmsError(
				"reconciliation_required",
				"Inspect the previous uncertain submission in My Events before making another change.",
			);
		this.validate(draft.change);
		const current = await this.adapter.prepare(draft.change);
		if (draft.expires <= this.now())
			throw new EmsError(
				"draft_expired",
				"The preview expired during validation. Prepare a new preview.",
			);
		if (current.identity !== draft.prepared.identity)
			throw new EmsError(
				"account_changed",
				"The EMS session changed. Prepare and confirm a new preview.",
			);
		if (fingerprint(current.preview) !== fingerprint(draft.prepared.preview))
			throw new EmsError(
				"preview_changed",
				"Availability, booking details, rules, or form fields changed. Prepare and confirm a new preview.",
				{ current_preview: current.preview },
			);
		this.validate(draft.change);
		// Persist intent BEFORE the write: process termination during submit also requires reconciliation.
		this.uncertain = true;
		await this.markUncertain(draft.change);
		try {
			const result = await this.adapter.submit(draft.change);
			await this.clearUncertain();
			this.uncertain = false;
			return { outcome: "verified", reservation: result };
		} catch {
			throw new EmsError(
				"submission_uncertain",
				"The change may have reached EMS. Inspect My Events before another attempt. This draft has been consumed and will not be replayed.",
				{
					operation: draft.change.operation,
					reservation_id:
						draft.change.operation === "create" ? undefined : draft.change.reservation_id,
				},
			);
		}
	}
}
