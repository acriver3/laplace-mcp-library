import { Page, Locator } from "playwright-core";

import { EmsBrowser } from "./browser.js";
import { localTime, validateSearch, emsDateTime } from "./core.js";
import {
	Booking,
	Change,
	EmsAdapter,
	EmsError,
	EMS_BASE,
	Field,
	Prepared,
	Reservation,
	Room,
	Search,
	SUPPORTED_TEMPLATES,
	Template,
	TIMEZONE,
} from "./types.js";

// Selectors were inspected against Yale SOM EMS Web App v226.2. Read only DOM
// data; never call EMS's private AJAX endpoints or access Knockout model state.
const quotedId = (id: string) => `[id=${JSON.stringify(id)}]`;
const normal = (s: string) => s.replace(/\s+/g, " ").trim();
export class BrowserAdapter implements EmsAdapter {
	private urls = new Map<string, string>();
	private selected?: {
		operation: Change["operation"];
		button: Locator;
		identity: string;
		room?: Room;
		before?: Reservation;
		reservationIds?: string[];
	};
	constructor(readonly browser: EmsBrowser) {}
	close() {
		return this.browser.close();
	}
	async identity() {
		await this.goto("Default.aspx");
		return this.browser.identity();
	}
	private async goto(path: string) {
		const url = new URL(path, EMS_BASE);
		if (url.origin !== new URL(EMS_BASE).origin || !url.pathname.startsWith("/web/"))
			throw new EmsError("invalid_url", "Only Yale SOM EMS pages are supported.");
		const page = await this.browser.page();
		await page.goto(url.href, { waitUntil: "domcontentloaded" });
		try {
			await this.browser.identity();
		} catch (error) {
			// Release the profile so the separate headed login CLI can acquire it.
			await this.browser.close();
			throw error;
		}
		await this.settled(page);
		return page;
	}
	private async settled(page: Page) {
		await page.waitForFunction(
			() =>
				![
					...document.querySelectorAll(
						".events-loading-overlay,.results-loader,#page-loading,#page-loading-overlay",
					),
				].some((e) => e.getClientRects().length && getComputedStyle(e).display !== "none"),
			undefined,
			{ timeout: 30_000 },
		);
	}
	private async errors(page: Page) {
		const errors = await page
			.locator(
				'[id$="validation-error-message"]:visible,label.error:visible,.validation-summary-errors:visible,.toast-error .toast-message:visible',
			)
			.allTextContents();
		const text = errors.map(normal).filter(Boolean).join("\n");
		if (text) throw new EmsError("ems_validation", text);
	}
	private async templateRows(page: Page) {
		await page.locator("#templates-grid").waitFor();
		await page.waitForFunction(
			() =>
				!!document.querySelector("#templates-grid button[data-templateid]") ||
				/no templates configured/i.test(
					document.querySelector("#templates-grid")?.textContent || "",
				),
		);
		return page.locator("#templates-grid button[data-templateid]").evaluateAll((elements) =>
			elements.map((el) => ({
				id: el.getAttribute("data-templateid") || "",
				name: (el.getAttribute("aria-label") || "").replace(/^About The "|" Template$/g, ""),
				url: el.getAttribute("data-navigateurl") || "",
			})),
		);
	}
	async templates(includeFields = true): Promise<Template[]> {
		const page = await this.goto("RoomRequest.aspx");
		const rows = await this.templateRows(page);
		const result: Template[] = [];
		for (const row of rows) {
			let rules = "";
			const button = page.locator(`#templates-grid button[data-templateid="${row.id}"]`);
			await button.click();
			await page.locator("#template-modal").waitFor({ state: "visible" });
			await this.settled(page);
			const body = page.locator("#template-modal .modal-body");
			const loaded = await body.waitFor({ state: "visible", timeout: 2000 }).then(
				() => true,
				() => false,
			);
			rules = loaded
				? normal(await body.innerText())
				: "EMS did not expose template information. The reservation form enforces booking rules; inspect EMS if rule details are needed.";
			const close = page.locator('#template-modal [data-dismiss="modal"]');
			if (await close.count()) await close.first().click();
			else await page.locator("#template-modal").press("Escape");
			await page.locator("#template-modal").waitFor({ state: "hidden" });
			result.push({
				id: row.id,
				name: row.name,
				supported: SUPPORTED_TEMPLATES.includes(row.name),
				rules,
				required_fields: [],
			});
		}
		for (const template of result.filter((t) => t.supported && includeFields)) {
			await this.goto(rows.find((row) => row.id === template.id)!.url);
			await page.locator("#booking-date-input").waitFor();
			template.required_fields = (await this.fields(page, true)).filter((f) => f.required);
		}
		return result;
	}
	private async openTemplate(id: string) {
		const templates = await this.templates(false);
		const template = templates.find((t) => t.id === id);
		if (!template || !template.supported)
			throw new EmsError(
				"unsupported_template",
				"Choose one of the student templates returned by ems_list_templates.",
			);
		const page = await this.browser.page();
		const row = (await this.templateRows(page)).find((r) => r.id === id);
		if (!row?.url)
			throw new EmsError("page_changed", "EMS did not provide a template navigation link.");
		await this.goto(row.url);
		await page.locator("#booking-date-input").waitFor();
		template.required_fields = (await this.fields(page, true)).filter((f) => f.required);
		return { page, template };
	}
	private async filter(page: Page, type: "Floors" | "RoomTypes" | "Features", values: string[]) {
		if (!values.length) return;
		const toggle = page.getByRole("button", { name: /Let Me Search For A Room/ });
		if (!(await page.locator("#search-room-collapse").isVisible())) await toggle.click();
		await page.getByRole("link", { name: `Add/Remove ${type}`, exact: true }).click();
		const modal = page.locator(".modal:visible");
		await modal.first().waitFor();
		if ((await modal.count()) !== 1)
			throw new EmsError("page_changed", "EMS filter dialog could not be identified.");
		const all = modal.getByLabel(/Select All/);
		for (const checkbox of await all.all())
			if (await checkbox.isChecked()) await checkbox.uncheck();
		for (const value of values) {
			const checkbox = modal.getByLabel(value, { exact: true });
			if ((await checkbox.count()) !== 1)
				throw new EmsError("invalid_filter", `EMS does not offer the ${type} filter: ${value}`);
			await checkbox.check();
		}
		await modal.getByRole("button", { name: "Close", exact: true }).last().click();
		await modal.waitFor({ state: "hidden" });
	}
	private async setTime(page: Page, kind: "start" | "end", value: string) {
		// v226.2 nests the text input in a span. Use the actual picker actions,
		// which update EMS's bound time, rather than changing only display text.
		await page.locator(`#booking-${kind} .input-group-addon`).click();
		const picker = page
			.locator(".bootstrap-datetimepicker-widget:visible")
			.filter({ has: page.locator(".timepicker") });
		await picker.waitFor();
		const [clock, period] = value.split(" ");
		const [hour, minute] = clock.split(":");
		const periodControl = picker.locator('[data-action="togglePeriod"]');
		if ((await periodControl.innerText()).trim() !== period) await periodControl.click();
		await picker.locator('[data-action="showHours"]').click();
		await picker
			.locator(`[data-action="selectHour"][aria-label="${hour.padStart(2, "0")}"]:not(.disabled)`)
			.click();
		await picker.locator('[data-action="showMinutes"]').click();
		const choice = picker.locator(
			`[data-action="selectMinute"][aria-label="${minute}"]:not(.disabled)`,
		);
		if ((await choice.count()) !== 1)
			throw new EmsError(
				"unsupported_time_granularity",
				"EMS's time picker does not offer this minute. Choose an offered minute.",
				{
					minutes: await picker
						.locator('[data-action="selectMinute"]')
						.evaluateAll((elements) => elements.map((e) => e.getAttribute("aria-label"))),
				},
			);
		await choice.click();
		await picker.locator('[data-action="close"]').first().click();
		await picker.waitFor({ state: "hidden" });
	}
	private async searchOnPage(
		page: Page,
		input: Search,
		discoverTemplate?: (id: string) => void,
		editing = false,
	) {
		const start = localTime(input.start),
			end = localTime(input.end);
		const timezone = page.locator("#timeZoneDrop");
		if ((await timezone.locator("option:checked").textContent())?.trim() !== "Eastern Time") {
			if (!(await timezone.isEnabled()))
				throw new EmsError(
					"unsupported_timezone",
					"This booking is locked to a timezone other than Eastern Time.",
				);
			await timezone.selectOption({ label: "Eastern Time" });
		}
		await page.locator("#booking-date-input").fill(start.date);
		await page.locator("#booking-date-input").dispatchEvent("change");
		await page.locator("#booking-date-input").press("Tab");
		await this.setTime(page, "start", start.time);
		await this.setTime(page, "end", end.time);
		const attendance = page.locator('[id="Number of People-input-box"]');
		if ((await attendance.count()) && !editing) {
			if (!(await attendance.isVisible()))
				await page.getByRole("button", { name: /Let Me Search For A Room/ }).click();
			await attendance.fill(String(input.attendance));
		}
		if (input.floor) await this.filter(page, "Floors", [input.floor]);
		if (input.room_type) await this.filter(page, "RoomTypes", [input.room_type]);
		if (input.features) await this.filter(page, "Features", input.features);
		const response = page
			.waitForResponse(
				(r) =>
					r.url().startsWith(EMS_BASE) &&
					/\/Get(?:AvailabilityList|BrowseLocationsRoomsForRoomRequest|BrowseLocationsBookingsForRoomRequest)(?:\?|$)/i.test(
						r.url(),
					),
				{ timeout: 30_000 },
			)
			.catch(() => null);
		await page
			.locator("#date-time-collapse")
			.getByRole("button", { name: "Search", exact: true })
			.click();
		// Wait for EMS's actual search response, not a fixed delay or a previous result table.
		const reply = await response;
		if (!reply) {
			await this.errors(page);
			throw new EmsError("page_changed", "Could not observe an EMS room search completing.");
		}
		await this.settled(page);
		await this.errors(page);
		const listResponse = page
			.waitForResponse(
				(r) => r.url().startsWith(EMS_BASE) && /\/GetAvailabilityList(?:\?|$)/i.test(r.url()),
				{ timeout: 30_000 },
			)
			.catch(() => null);
		await page.getByRole("tab", { name: "List", exact: true }).click();
		const listReply = await listResponse;
		if (!listReply)
			throw new EmsError("page_changed", "EMS did not complete a list availability search.");
		const payload = listReply.request().postDataJSON()?.searchData;
		if (
			!payload ||
			(!discoverTemplate && String(payload.TemplateId) !== input.template_id) ||
			!sameSearchTime(payload.Start, input.start) ||
			!sameSearchTime(payload.End, input.end) ||
			payload.Dates?.length !== 1 ||
			!sameSearchDate(payload.Dates[0], input.start)
		)
			throw new EmsError(
				"page_changed",
				"EMS searched a different template or interval. Check the date and time before retrying.",
			);
		if (discoverTemplate) discoverTemplate(String(payload.TemplateId));
		if ([401, 403].includes(listReply.status()))
			throw new EmsError(
				listReply.status() === 401 ? "auth_required" : "permission_denied",
				"EMS rejected the room search.",
			);
		const responseBody = await listReply.json();
		const result = typeof responseBody.d === "string" ? JSON.parse(responseBody.d) : responseBody.d;
		if (result?.ErrorMessage)
			throw new EmsError("ems_validation", normal(String(result.ErrorMessage)));
		await this.settled(page);
		const rooms = await page.locator("#available-list tbody tr[data-room-id]").evaluateAll((rows) =>
			rows.map((row) => {
				const cells = [...row.querySelectorAll("td")];
				const value = (i: number) => cells[i]?.textContent?.replace(/\s+/g, " ").trim() || "";
				const add = row.querySelector("a.add-to-cart");
				return {
					id: row.getAttribute("data-room-id") || "",
					name: value(2),
					location: value(4),
					floor: value(5),
					capacity: Number(value(7)),
					price: value(8),
					available:
						!!add && !add.classList.contains("disabled") && !row.classList.contains("unavailable"),
				};
			}),
		);
		// Edit forms hide the capacity filter. The final setup dialog supplies
		// attendance; reject insufficient capacity before selecting a replacement.
		return rooms.map((room) => ({
			...room,
			available: room.available && room.capacity >= input.attendance,
		}));
	}
	async search(input: Search) {
		validateSearch(input);
		const { page, template } = await this.openTemplate(input.template_id);
		let rooms = await this.searchOnPage(page, input);
		if (input.room)
			rooms = rooms.filter((r) => r.name.toLowerCase().includes(input.room!.toLowerCase()));
		return {
			rooms,
			template,
			start: localTime(input.start).iso,
			end: localTime(input.end).iso,
			timezone: TIMEZONE,
		};
	}
	async room(id: string, input: Search): Promise<Room> {
		const result = await this.search(input);
		const room: Room | undefined = result.rooms.find((r) => r.id === id);
		if (!room)
			throw new EmsError("room_not_found", "The room is not in this template and search interval.");
		const page = await this.browser.page();
		await page
			.locator(`#available-list tr[data-room-id="${id}"] td`)
			.nth(2)
			.getByRole("link")
			.click();
		const dialog = page.locator(".modal:visible");
		await dialog.waitFor();
		room.details = normal(await dialog.innerText());
		await dialog.locator('[data-dismiss="modal"]').first().click();
		return room;
	}
	async reservations(
		options: { past?: boolean; include_cancelled?: boolean; query?: string } = {},
	): Promise<Reservation[]> {
		const page = await this.goto("BrowseReservations.aspx");
		await page.locator("#reservations-container").waitFor();
		const refresh = async (action: () => Promise<unknown>) => {
			const response = page
				.waitForResponse(
					(r) => r.url().startsWith(EMS_BASE) && /\/PopulateReservationList(?:\?|$)/.test(r.url()),
				)
				.catch(() => null);
			await action();
			const reply = await response;
			if (!reply) throw new EmsError("page_changed", "EMS did not refresh My Events.");
			await reply.finished();
			await this.settled(page);
		};
		if (options.include_cancelled) {
			const toggle = page
				.locator(".webapp-checkbox")
				.filter({ hasText: "Include cancelled reservations" });
			if ((await toggle.getAttribute("aria-checked")) !== "true")
				await refresh(() => toggle.click());
		}
		if (options.past)
			await refresh(() => page.getByRole("tab", { name: "Past", exact: true }).click());
		if (options.query) {
			await page.locator("#reservation-search").fill(options.query);
			await refresh(() =>
				page.getByRole("button", { name: "Search Reservations", exact: true }).click(),
			);
		}
		await this.settled(page);
		const panel = page.locator(
			options.past ? "#reservations-grid-past" : "#reservations-grid-current",
		);
		const result: Reservation[] = [];
		for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
			const rows = await panel.locator("tbody tr").evaluateAll((rows) =>
				rows.flatMap((row) => {
					const cells = [...row.querySelectorAll("td")];
					if (cells.length < 7) return [];
					const value = (i: number) =>
						(cells[i] as HTMLElement)?.innerText?.replace(/\s+/g, " ").trim() || "";
					const link = cells[0]?.querySelector("a");
					return [
						{
							reservation_id: value(5),
							name: value(0),
							dates: value(1),
							location: value(2),
							has_services:
								[...(cells[4]?.querySelectorAll("i") || [])].some(
									(e) =>
										e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden",
								) || /yes/i.test(value(4)),
							status: value(6),
							href: link?.getAttribute("href") || "",
						},
					];
				}),
			);
			for (const { href, ...reservation } of rows) {
				if (!/^\d+$/.test(reservation.reservation_id) || !href)
					throw new EmsError(
						"page_changed",
						"EMS reservation identity or summary link could not be read.",
					);
				this.urls.set(reservation.reservation_id, href);
				result.push(reservation);
			}
			const next = panel.locator(".grid-page-text-right:not(.disabled)");
			if (!(await next.count())) return result;
			const before = await panel.locator("tbody").innerText();
			await refresh(() => next.click());
			await page.waitForFunction(
				({ selector, before }) =>
					document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() !==
					before.replace(/\s+/g, " ").trim(),
				{
					selector: options.past
						? "#reservations-grid-past tbody"
						: "#reservations-grid-current tbody",
					before,
				},
			);
			await this.settled(page);
		}
		throw new EmsError(
			"too_many_results",
			"Narrow the reservation search; the result exceeds 100 pages.",
		);
	}
	async reservation(id: string): Promise<Reservation> {
		let reservation = (await this.reservations({ include_cancelled: true })).find(
			(r) => r.reservation_id === id,
		);
		if (!reservation)
			reservation = (await this.reservations({ past: true, include_cancelled: true })).find(
				(r) => r.reservation_id === id,
			);
		if (!reservation)
			throw new EmsError(
				"reservation_not_found",
				"This reservation is not in your My Events list.",
			);
		const page = await this.goto(this.urls.get(id)!);
		const toggle = page.locator("#include-cancelled");
		if ((await toggle.count()) && (await toggle.locator(".fa-square-o").count()))
			await toggle.click();
		reservation.bookings = await this.readBookings(page);
		return reservation;
	}
	private async readBookings(page: Page): Promise<Booking[]> {
		const table = page.locator("#bookings-grid:visible");
		if ((await table.count()) !== 1)
			throw new EmsError("page_changed", "The individual booking table could not be identified.");
		const rows = await table.locator("tbody tr").evaluateAll((rows) =>
			rows.flatMap((row) => {
				const attr = row.getAttribute("data-bookingid");
				const bound = [...row.querySelectorAll("[data-bind]")];
				const find = (pattern: RegExp) =>
					bound.find((e) => pattern.test(e.getAttribute("data-bind") || ""))?.textContent?.trim() ||
					"";
				const id = attr || find(/text:\s*(?:\$data\.)?(?:BookingId|ID|Id)\b/);
				if (!id) return [];
				return [
					{
						booking_id: id,
						room: find(/text:.*(?:RoomDescription|RoomName|Room\b|Location)/),
						date: find(/text:.*(?:TimeBookingStart|EventDate|BookingDate|Date\b)/),
						start: find(/text:.*\b(?:EventStart|StartTime|Start)\b/),
						end: find(/text:.*\b(?:EventEnd|EndTime|End)\b/),
						status: find(/text:.*Status/),
						details: row.textContent?.replace(/\s+/g, " ").trim() || "",
					},
				];
			}),
		);
		if (!rows.length || rows.some((b) => !/^\d+$/.test(b.booking_id) || !b.room || !b.status))
			throw new EmsError(
				"page_changed",
				"EMS booking identifiers and status could not be read reliably.",
			);
		return rows.map(({ date, ...booking }) => ({
			...booking,
			start: emsDateTime(date || booking.details, booking.start),
			end: emsDateTime(date || booking.details, booking.end),
		}));
	}
	private async fields(page: Page, includeHidden = false): Promise<Field[]> {
		const visibility = includeHidden ? "" : ":visible";
		return page
			.locator(
				`#details input${visibility}:not([type=checkbox]),#details select${visibility},#details textarea${visibility}`,
			)
			.evaluateAll((elements) =>
				elements.flatMap((e) => {
					const input = e as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
					if (!input.id || input.id === "1stcontact" || input.id === "2ndcontact") return [];
					const label =
						document
							.querySelector(`label[for="${input.id}"]`)
							?.textContent?.replace(/\s+/g, " ")
							.replace(/\*/g, "")
							.trim() ||
						input.getAttribute("aria-label") ||
						input.id;
					return [
						{
							id: input.id,
							label,
							required: input.required,
							type: input.type,
							value: input.value,
							options:
								input.tagName === "SELECT"
									? [...(input as HTMLSelectElement).options].map((o) => ({
											value: o.value,
											label: o.text,
										}))
									: undefined,
						},
					];
				}),
			);
	}
	private async enterFields(page: Page, change: Extract<Change, { operation: "create" }>) {
		await page.locator("#event-name").fill(change.event_name);
		if (change.event_type)
			await page.locator("#event-type").selectOption({ label: change.event_type });
		if (change.group_id) await page.locator("#availablegroups").selectOption(change.group_id);
		await page.locator('[id="1stcontact"]').selectOption("0");
		await page.locator('[id="1stContactName"]').fill(change.contact_name);
		await page.locator('[id="1stContactEmail"]').fill(change.contact_email);
		if (change.contact_phone)
			await page.locator('[id="1stContactPhone1"]').fill(change.contact_phone);
		const invitation = page.locator("#add-to-calendar");
		if ((await invitation.isVisible()) && (await invitation.isChecked()))
			await invitation.uncheck();
		const fields = await this.fields(page);
		for (const [id, value] of Object.entries(change.fields || {})) {
			const field = fields.find((f) => f.id === id);
			if (!field || !/^udf|user.?defined/i.test(id))
				throw new EmsError(
					"unsupported_field",
					"Only discovered user-defined fields can be supplied through fields.",
				);
			const control = page.locator(quotedId(id));
			if (field.options) await control.selectOption({ label: value });
			else await control.fill(value);
		}
		const finalFields = await this.fields(page);
		const missing = finalFields.filter(
			(f) => f.required && (!f.value || (f.options && f.value === "0")),
		);
		if (missing.length)
			throw new EmsError(
				"required_fields",
				"Complete the required EMS fields before preparing a preview.",
				{ required_fields: missing },
			);
		return finalFields;
	}
	async prepare(change: Change): Promise<Prepared> {
		this.selected = undefined;
		const identity = await this.identity();
		if (change.operation === "create") {
			const reservationIds = (await this.reservations()).map((r) => r.reservation_id);
			const input = searchSchemaForChange(change);
			const result = await this.search(input);
			const room = result.rooms.find((r) => r.id === change.room_id && r.available);
			if (room?.price && Number(room.price.replace(/[^\d.]/g, "")) !== 0)
				throw new EmsError("unsupported_services", "Paid room bookings are outside V1.");
			if (!room)
				throw new EmsError(
					"availability_conflict",
					"This room is no longer available for the requested interval.",
				);
			const page = await this.browser.page();
			await page
				.locator(`#available-list tr[data-room-id="${room.id}"] a.add-to-cart:not(.disabled)`)
				.click();
			const modal = page.locator("#setup-add-modal");
			if (await modal.isVisible()) {
				await page.locator("#setup-add-count").fill(String(change.attendance));
				await page.locator("#setup--add-modal-save").click();
				await modal.waitFor({ state: "hidden" });
			}
			await this.settled(page);
			if (await page.locator('#main-tabs a[href="#services"]:visible').count())
				throw new EmsError(
					"unsupported_services",
					"This template exposes a service workflow that V1 does not support.",
				);
			if (await page.locator("#responsive-save-btn").isVisible())
				await page.locator("#responsive-save-btn").click();
			else await page.locator('#main-tabs a[href="#details"]').click();
			await this.settled(page);
			await this.errors(page);
			if (await page.locator("#services:visible").count())
				throw new EmsError(
					"unsupported_services",
					"This template requires a service workflow that V1 does not support.",
				);
			await page.locator("#event-name:visible").waitFor();
			const fields = await this.enterFields(page, change);
			const buttons = page.getByRole("button", { name: "Create Reservation", exact: true });
			// EMS renders the same save action at both the top and bottom of details.
			const bindings = await buttons.evaluateAll((elements) =>
				elements.map((e) => e.getAttribute("data-bind")),
			);
			if (
				!bindings.length ||
				!bindings.every((binding) => binding === "click: function(){ return saveReservation(); }")
			)
				throw new EmsError("page_changed", "The final create action could not be identified.");
			const button = buttons.first();
			this.selected = { operation: "create", button, identity: identity.key, room, reservationIds };
			return {
				identity: identity.key,
				preview: {
					operation: "create",
					account: identity.name,
					timezone: TIMEZONE,
					template: { ...result.template, required_fields: fields.filter((f) => f.required) },
					room,
					start: result.start,
					end: result.end,
					attendance: change.attendance,
					fields,
				},
			};
		}
		const templates = await this.templates(false);
		const requestedTemplate =
			change.operation === "update"
				? templates.find((t) => t.id === change.template_id && t.supported)
				: undefined;
		if (change.operation === "update" && !requestedTemplate)
			throw new EmsError(
				"unsupported_template",
				"Choose one of the supported student templates returned by ems_list_templates.",
			);
		const reservation = await this.reservation(change.reservation_id);
		const booking = reservation.bookings?.find((b) => b.booking_id === change.booking_id);
		if (!booking)
			throw new EmsError(
				"booking_not_found",
				"This individual booking does not belong to the selected reservation.",
			);
		if (reservation.has_services)
			throw new EmsError("unsupported_services", "Bookings with services are outside V1.");
		const page = await this.browser.page();
		let template = requestedTemplate;
		const row = page.locator(`#bookings-grid tbody tr[data-bookingid="${booking.booking_id}"]`);
		if ((await row.count()) !== 1)
			throw new EmsError(
				"page_changed",
				"EMS did not expose an unambiguous individual booking action.",
			);
		if (/cancel/i.test(booking.status))
			throw new EmsError("booking_restricted", "This booking is already cancelled.");
		const edit = row.getByRole("link", { name: "Edit Booking", exact: true });
		if (!(await edit.isVisible()))
			throw new EmsError(
				"booking_restricted",
				"EMS does not allow editing this booking; V1 cannot verify its template.",
			);
		await edit.click();
		await page.locator("#booking-date-input").waitFor();
		if (change.operation === "cancel") {
			// Summary pages omit the template. Observe the selected booking's own
			// read-only availability search to identify its workflow before cancellation.
			await this.searchOnPage(
				page,
				{
					template_id: "",
					start: booking.start,
					end: booking.end,
					attendance: 1,
				},
				(id) => {
					template = templates.find((t) => t.id === id && t.supported);
					if (!template)
						throw new EmsError(
							"unsupported_template",
							"This booking does not use a supported student template.",
						);
				},
				true,
			);
			await this.goto(this.urls.get(change.reservation_id)!);
			const cancel = row.getByRole("link", { name: "Delete Booking", exact: true });
			if (!(await cancel.isVisible()))
				throw new EmsError(
					"booking_restricted",
					"EMS does not allow cancelling this individual booking.",
				);
			await cancel.click();
			const modal = page.locator("#cancel-modal:visible");
			await modal.waitFor();
			const reason = modal.locator(".reason select:visible");
			if (await reason.count()) {
				if (!change.reason)
					throw new EmsError("required_fields", "EMS requires a cancellation reason.", {
						reasons: await reason.locator("option").allTextContents(),
					});
				await reason.selectOption({ label: change.reason });
			}
			const notes = modal.locator(".notes textarea:visible");
			if (change.notes && (await notes.count())) await notes.fill(change.notes);
			const button = modal.locator("#cancel-btn-yes");
			this.selected = { operation: "cancel", button, identity: identity.key, before: reservation };
			return {
				identity: identity.key,
				preview: {
					operation: "cancel",
					account: identity.name,
					timezone: TIMEZONE,
					template,
					reservation,
					booking,
					reason: change.reason,
					notes: change.notes,
				},
			};
		}
		const result = await this.searchOnPage(page, searchSchemaForChange(change), undefined, true);
		const room = result.find((r) => r.id === change.room_id && r.available);
		if (room?.price && Number(room.price.replace(/[^\d.]/g, "")) !== 0)
			throw new EmsError("unsupported_services", "Paid room bookings are outside V1.");
		if (!room)
			throw new EmsError(
				"availability_conflict",
				"The requested replacement room/time is not available.",
			);
		const select = page.locator(
			`#available-list tr[data-room-id="${room.id}"] a.add-to-cart:not(.disabled)`,
		);
		if ((await select.count()) !== 1)
			throw new EmsError(
				"page_changed",
				"The individual replacement room selector could not be identified.",
			);
		await select.click();
		if (await page.locator("#setup-add-modal").isVisible()) {
			await page.locator("#setup-add-count").fill(String(change.attendance));
			await page.locator("#setup--add-modal-save").click();
			await page.locator("#setup-add-modal").waitFor({ state: "hidden" });
		}
		await this.settled(page);
		const buttons = page.getByRole("button", { name: "Update Booking", exact: true });
		const bindings = await buttons.evaluateAll((elements) =>
			elements.map((e) => e.getAttribute("data-bind")),
		);
		if (
			!bindings.length ||
			!bindings.every((binding) =>
				[
					"click: $root.cart.updateBooking, visible: $root.cart.bookingEditing() != null",
					"click: $root.cart.updateBooking, visible: vems.roomRequest.pageMode != 'AddPamLocation'",
				].includes(binding || ""),
			)
		)
			throw new EmsError("page_changed", "EMS did not provide a single-booking update action.", {
				bindings,
			});
		const button = buttons.first();
		this.selected = {
			operation: "update",
			button,
			identity: identity.key,
			room,
			before: reservation,
		};
		return {
			identity: identity.key,
			preview: {
				operation: "update",
				account: identity.name,
				timezone: TIMEZONE,
				template,
				reservation,
				booking,
				room,
				start: localTime(change.start).iso,
				end: localTime(change.end).iso,
				attendance: change.attendance,
			},
		};
	}
	async submit(change: Change): Promise<Reservation> {
		const selected = this.selected;
		this.selected = undefined;
		if (!selected || selected.operation !== change.operation)
			throw new EmsError("not_prepared", "Prepare the final form before submitting.");
		const page = await this.browser.page();
		if ((await this.browser.identity()).key !== selected.identity)
			throw new EmsError("account_changed", "The EMS session changed before submission.");
		const navigation =
			change.operation === "create"
				? undefined
				: page
						.waitForEvent("framenavigated", {
							predicate: (frame) => frame === page.mainFrame(),
							timeout: 30_000,
						})
						.catch(() => null);
		await selected.button.click();
		if (navigation) {
			if (!(await navigation))
				throw new EmsError(
					"verification_failed",
					"EMS did not navigate after changing the booking. Inspect My Events before another attempt.",
				);
			await page.waitForLoadState("domcontentloaded");
		}
		await this.settled(page);
		await this.errors(page);
		if (change.operation === "create") {
			await page.locator("#reservation-created-dialog").waitFor({ state: "visible" });
			const link = page
				.locator("#view-this-reservation-action,#edit-this-reservation-action")
				.first();
			const href = await link.getAttribute("href");
			if (!href)
				throw new EmsError("verification_failed", "EMS did not return a reservation summary link.");
			// Verify through My Events, rather than interpreting a success dialog as booked.
			const all = await this.reservations();
			const matches = all.filter(
				(r) => r.name === change.event_name && !selected.reservationIds?.includes(r.reservation_id),
			);
			if (matches.length !== 1)
				throw new EmsError(
					"verification_failed",
					"The new reservation could not be identified uniquely in My Events.",
				);
			const reservation = await this.reservation(matches[0].reservation_id);
			if (
				reservation.bookings?.length !== 1 ||
				!sameRoom(reservation.bookings[0].room, selected.room) ||
				reservation.bookings[0].start !== localTime(change.start).iso ||
				reservation.bookings[0].end !== localTime(change.end).iso
			)
				throw new EmsError(
					"verification_failed",
					"The expected single room and interval could not be verified.",
				);
			return reservation;
		}
		const reservation = await this.reservation(change.reservation_id);
		const booking = reservation.bookings?.find((b) => b.booking_id === change.booking_id);
		if (!booking)
			throw new EmsError(
				"verification_failed",
				"The changed booking could not be located for verification.",
			);
		if (change.operation === "cancel" && !/cancel/i.test(booking.status))
			throw new EmsError(
				"verification_failed",
				"EMS has not verified cancellation of this booking.",
			);
		if (change.operation === "update") {
			if (
				!sameRoom(booking.room, selected.room) ||
				booking.start !== localTime(change.start).iso ||
				booking.end !== localTime(change.end).iso
			)
				throw new EmsError(
					"verification_failed",
					"The requested room and interval update could not be verified.",
				);
		}
		const siblings =
			selected.before?.bookings?.filter((b) => b.booking_id !== change.booking_id) || [];
		if (
			siblings.some(
				(b) =>
					reservation.bookings?.find((x) => x.booking_id === b.booking_id)?.details !== b.details,
			)
		)
			throw new EmsError(
				"verification_failed",
				"Another booking changed; inspect the entire reservation in EMS.",
			);
		return reservation;
	}
}
function sameRoom(location: string, room?: Room) {
	return !!room && (location === room.name || location.endsWith(` - ${room.name}`));
}
function searchSchemaForChange(change: Exclude<Change, { operation: "cancel" }>): Search {
	return {
		template_id: change.template_id,
		start: change.start,
		end: change.end,
		attendance: change.attendance,
		room: change.room,
		floor: change.floor,
		room_type: change.room_type,
		features: change.features,
	};
}
function sameSearchTime(value: unknown, iso: string) {
	if (typeof value !== "string") return false;
	const p = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):00$/);
	if (!p) return false;
	const expected = localTime(iso).iso.slice(0, 19);
	return (
		`${p[1]}-${p[2].padStart(2, "0")}-${p[3].padStart(2, "0")}T${p[4].padStart(2, "0")}:${p[5]}:00` ===
		expected
	);
}
function sameSearchDate(value: unknown, iso: string) {
	return (
		typeof value === "string" &&
		sameSearchTime(
			value.replace(/[ T]\d{1,2}:\d{2}:\d{2}$/, "T00:00:00"),
			localTime(iso).iso.slice(0, 10) + "T00:00:00" + localTime(iso).iso.slice(19),
		)
	);
}
