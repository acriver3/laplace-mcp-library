import { z } from "zod";

export const EMS_ORIGIN = "https://yalesom.emscloudservice.com";
export const EMS_BASE = `${EMS_ORIGIN}/web/`;
export const TIMEZONE = "America/New_York";
export const SUPPORTED_TEMPLATES = [
	"Evans Hall - Breakout Rooms",
	"Evans Hall - Interview Rooms",
	"Fit for Thought",
];
export const idSchema = z.string().regex(/^\d{1,12}$/);
const text = z.string().trim().min(1).max(200);
export const searchSchema = z
	.object({
		template_id: idSchema,
		start: z.iso.datetime({ offset: true }),
		end: z.iso.datetime({ offset: true }),
		attendance: z.number().int().min(1).max(100),
		room: text.optional(),
		floor: text.optional(),
		room_type: text.optional(),
		features: z.array(text).max(20).optional(),
	})
	.strict();
export const changeSchema = z.discriminatedUnion("operation", [
	searchSchema
		.extend({
			operation: z.literal("create"),
			room_id: idSchema,
			event_name: text,
			event_type: text.optional(),
			group_id: idSchema.optional(),
			contact_name: text,
			contact_email: z.email(),
			contact_phone: text.optional(),
			fields: z.record(z.string().regex(/^[\w-]{1,100}$/), z.string().max(2000)).optional(),
		})
		.strict(),
	searchSchema
		.extend({
			operation: z.literal("update"),
			reservation_id: idSchema,
			booking_id: idSchema,
			room_id: idSchema,
		})
		.strict(),
	z
		.object({
			operation: z.literal("cancel"),
			reservation_id: idSchema,
			booking_id: idSchema,
			reason: text.optional(),
			notes: z.string().max(2000).optional(),
		})
		.strict(),
]);
export type Search = z.infer<typeof searchSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Template = {
	id: string;
	name: string;
	supported: boolean;
	rules: string;
	required_fields: Field[];
};
export type Field = {
	id: string;
	label: string;
	required: boolean;
	type: string;
	value: string;
	options?: { value: string; label: string }[];
};
export type Room = {
	id: string;
	name: string;
	location: string;
	floor: string;
	capacity: number;
	price?: string;
	available: boolean;
	details?: string;
};
export type Reservation = {
	reservation_id: string;
	name: string;
	status: string;
	location: string;
	dates: string;
	has_services: boolean;
	bookings?: Booking[];
};
export type Booking = {
	booking_id: string;
	room: string;
	start: string;
	end: string;
	status: string;
	details: string;
};
export type Preview = {
	operation: Change["operation"];
	account: string;
	timezone: string;
	template?: Template;
	room?: Room;
	start?: string;
	end?: string;
	attendance?: number;
	reservation?: Reservation;
	booking?: Booking;
	fields?: Field[];
	reason?: string;
	notes?: string;
};
export type Prepared = { identity: string; preview: Preview };
export interface EmsAdapter {
	identity(): Promise<{ key: string; name: string }>;
	templates(): Promise<Template[]>;
	search(
		input: Search,
	): Promise<{ rooms: Room[]; template: Template; start: string; end: string; timezone: string }>;
	room(id: string, search: Search): Promise<Room>;
	reservations(options?: {
		past?: boolean;
		include_cancelled?: boolean;
		query?: string;
	}): Promise<Reservation[]>;
	reservation(id: string): Promise<Reservation>;
	prepare(change: Change): Promise<Prepared>;
	submit(change: Change): Promise<Reservation>;
	close(): Promise<void>;
}
export class EmsError extends Error {
	constructor(
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "EmsError";
	}
}
export function errorResult(error: unknown) {
	if (error instanceof EmsError)
		return {
			code: error.code,
			message: error.message,
			...(error.details ? { details: error.details } : {}),
		};
	if (error instanceof z.ZodError)
		return {
			code: "invalid_input",
			message: "Check tool arguments.",
			details: error.issues.map(({ path, message }) => ({ path, message })),
		};
	// Browser errors can include URLs, form values, or source. Keep them out of tool results/logs.
	return {
		code: "page_changed",
		message:
			"The EMS interface could not be read reliably. Check EMS in the browser before retrying.",
	};
}
