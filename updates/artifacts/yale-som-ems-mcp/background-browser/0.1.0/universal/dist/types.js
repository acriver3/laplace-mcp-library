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
export class EmsError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "EmsError";
    }
}
export function errorResult(error) {
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
        message: "The EMS interface could not be read reliably. Check EMS in the browser before retrying.",
    };
}
