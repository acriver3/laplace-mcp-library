import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { EmsService, validateSearch } from "./core.js";
import {
	EmsAdapter,
	EmsError,
	changeSchema,
	errorResult,
	idSchema,
	searchSchema,
} from "./types.js";

export function createServer(adapter: EmsAdapter, service = new EmsService(adapter)) {
	const server = new McpServer(
		{ name: "yale-som-ems-mcp", version: "0.1.0" },
		{
			instructions:
				"Use Yale SOM student EMS templates only. Show the complete ems_prepare_change preview and obtain the user's confirmation before ems_commit_change. A confirm flag is a caller attestation, not proof of human approval; retain your MCP client's approval controls. Never automatically replay a write. Pending requests are not confirmed bookings. Interview rooms may require check-in at the physical room pad; this server does not check in.",
		},
	);
	const read = {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	};
	function tool(
		name: string,
		description: string,
		schema: z.ZodType,
		annotations: typeof read,
		call: (value: any) => Promise<unknown>,
	) {
		server.registerTool(
			name,
			{ description, inputSchema: schema as z.ZodObject<any>, annotations },
			async (value: any, extra) =>
				service.queue.run(async () => {
					if (extra.signal.aborted)
						throw new EmsError("cancelled", "The tool call was cancelled before execution.");
					const abort = () => {
						void adapter.close();
					};
					extra.signal.addEventListener("abort", abort, { once: true });
					try {
						const data = await call(value);
						return {
							content: [{ type: "text" as const, text: JSON.stringify(data) }],
							structuredContent: { result: data },
						};
					} catch (e) {
						return {
							isError: true,
							content: [{ type: "text" as const, text: JSON.stringify(errorResult(e)) }],
						};
					} finally {
						extra.signal.removeEventListener("abort", abort);
					}
				}),
		);
	}
	tool(
		"ems_session_status",
		"Check the dedicated Yale SOM EMS session. If auth_required, run login locally and complete Yale SSO/MFA.",
		z.object({}).strict(),
		read,
		async () => {
			const identity = await adapter.identity();
			return { authenticated: true, account: identity.name, timezone: "America/New_York" };
		},
	);
	tool(
		"ems_list_templates",
		"Read your EMS reservation templates and rules. Discover available student template IDs; unsupported templates cannot be used for writes.",
		z.object({}).strict(),
		read,
		() => adapter.templates(),
	);
	tool(
		"ems_search_availability",
		"Search student room availability. Times must include UTC offsets; results use Eastern Time. EMS enforces booking horizons, durations, and account permissions.",
		searchSchema,
		read,
		(value) => adapter.search(validateSearch(value)),
	);
	tool(
		"ems_get_room",
		"Read a room and its details within a specific template and availability interval.",
		searchSchema.extend({ room_id: idSchema }).strict(),
		read,
		({ room_id, ...input }) => adapter.room(room_id, validateSearch(input)),
	);
	tool(
		"ems_list_my_reservations",
		"Read My Events with separate reservation identifiers. Includes all result pages. Use include_cancelled to inspect a cancelled or uncertain submission.",
		z
			.object({
				past: z.boolean().optional(),
				include_cancelled: z.boolean().optional(),
				query: z.string().max(200).optional(),
			})
			.strict(),
		read,
		(value) => adapter.reservations(value),
	);
	tool(
		"ems_get_reservation",
		"Read a reservation from your My Events list, including individual booking identifiers, status, and booking details.",
		z.object({ reservation_id: idSchema }).strict(),
		read,
		({ reservation_id }) => adapter.reservation(reservation_id),
	);
	// MCP input schemas must be object schemas; refinement restores the operation-specific contract.
	const prepareInput = z
		.object({
			operation: z.enum(["create", "update", "cancel"]),
			template_id: idSchema.optional(),
			start: z.iso.datetime({ offset: true }).optional(),
			end: z.iso.datetime({ offset: true }).optional(),
			attendance: z.number().int().min(1).max(100).optional(),
			room: z.string().max(200).optional(),
			floor: z.string().max(200).optional(),
			room_type: z.string().max(200).optional(),
			features: z.array(z.string().max(200)).max(20).optional(),
			room_id: idSchema.optional(),
			event_name: z.string().max(200).optional(),
			event_type: z.string().max(200).optional(),
			group_id: idSchema.optional(),
			contact_name: z.string().max(200).optional(),
			contact_email: z.email().optional(),
			contact_phone: z.string().max(200).optional(),
			fields: z.record(z.string(), z.string().max(2000)).optional(),
			reservation_id: idSchema.optional(),
			booking_id: idSchema.optional(),
			reason: z.string().max(200).optional(),
			notes: z.string().max(2000).optional(),
		})
		.strict();
	tool(
		"ems_prepare_change",
		"Prepare one room booking creation, update, or cancellation WITHOUT submitting. Create requires template_id, room_id, start/end, attendance, event_name, contact_name, contact_email. Update requires reservation_id, booking_id and replacement template/room/times/attendance; it never edits the shared event name. Cancel requires reservation_id and booking_id. Show all returned preview details and obtain user confirmation before committing. Drafts expire in ten minutes.",
		prepareInput,
		read,
		(value) => service.prepare(changeSchema.parse(value)),
	);
	tool(
		"ems_commit_change",
		"Submit the exact preview only AFTER the user confirms it. Revalidates the EMS session, availability, and preview. Consumes the draft once; never automatically retry. On submission_uncertain inspect My Events and reconcile locally before another change.",
		z.object({ draft_id: z.uuid(), confirm: z.literal(true) }).strict(),
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		({ draft_id, confirm }) => service.commit(draft_id, confirm),
	);
	return server;
}
