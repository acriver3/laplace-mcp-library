/**
 * Calendar API — events, meetings, and availability.
 */
import { owaGet, owaPost, owaPatch, owaDelete } from './client.js';
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * Validate a RecurrenceInput and translate it to the OWA `Recurrence` payload.
 * `eventStart` (the event's ISO start) seeds the range start date when omitted.
 */
export function buildRecurrence(input, eventStart, defaultTimeZone) {
    const pattern = {
        Type: capitalise(input.pattern),
        Interval: input.interval ?? 1,
    };
    const needsDays = ['weekly', 'relativeMonthly', 'relativeYearly'].includes(input.pattern);
    if (needsDays && !input.daysOfWeek?.length) {
        throw new Error(`Recurrence pattern '${input.pattern}' requires daysOfWeek.`);
    }
    if ((input.pattern === 'absoluteMonthly' || input.pattern === 'absoluteYearly') && input.dayOfMonth == null) {
        throw new Error(`Recurrence pattern '${input.pattern}' requires dayOfMonth.`);
    }
    if ((input.pattern === 'absoluteYearly' || input.pattern === 'relativeYearly') && input.month == null) {
        throw new Error(`Recurrence pattern '${input.pattern}' requires month (1-12).`);
    }
    if (input.daysOfWeek?.length)
        pattern.DaysOfWeek = input.daysOfWeek.map(capitalise);
    if (input.dayOfMonth != null)
        pattern.DayOfMonth = input.dayOfMonth;
    if (input.month != null)
        pattern.Month = input.month;
    if (input.index)
        pattern.Index = capitalise(input.index);
    if (input.pattern === 'weekly')
        pattern.FirstDayOfWeek = capitalise(input.firstDayOfWeek ?? 'sunday');
    const r = input.range;
    if (r.type === 'endDate' && !r.endDate) {
        throw new Error("Recurrence range type 'endDate' requires endDate (YYYY-MM-DD).");
    }
    if (r.type === 'numbered' && r.numberOfOccurrences == null) {
        throw new Error("Recurrence range type 'numbered' requires numberOfOccurrences.");
    }
    const startDate = r.startDate ?? eventStart.slice(0, 10);
    if (!startDate) {
        throw new Error('Recurrence requires a range startDate (or an event start to derive it from).');
    }
    const range = {
        Type: capitalise(r.type),
        StartDate: startDate,
        RecurrenceTimeZone: r.timeZone ?? defaultTimeZone,
    };
    if (r.endDate)
        range.EndDate = r.endDate;
    if (r.numberOfOccurrences != null)
        range.NumberOfOccurrences = r.numberOfOccurrences;
    return { Pattern: pattern, Range: range };
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export async function listEvents(opts = {}) {
    // calendarView (rather than /events) scopes results to [startDateTime, endDateTime]
    // and expands recurring series into individual instances within the window.
    const path = opts.calendarId ? `/calendars/${opts.calendarId}/calendarview` : '/calendarview';
    // Anchor the window on the start when given, so a future start without an end
    // produces a forward week rather than an empty/backwards window ending "now".
    const start = opts.startDateTime ? new Date(opts.startDateTime) : new Date();
    const startISO = opts.startDateTime ?? start.toISOString();
    const endISO = opts.endDateTime ?? new Date(start.getTime() + WEEK_MS).toISOString();
    const params = {
        startDateTime: startISO,
        endDateTime: endISO,
        '$top': String(opts.top ?? 50),
        '$orderby': 'start/dateTime asc',
        '$select': (opts.select ?? [
            'Id', 'Subject', 'BodyPreview', 'Start', 'End', 'Location',
            'Organizer', 'Attendees', 'IsAllDay', 'IsCancelled', 'IsOnlineMeeting',
            'OnlineMeetingUrl', 'ResponseStatus', 'WebLink',
        ]).join(','),
    };
    if (opts.filter)
        params['$filter'] = opts.filter;
    const res = await owaGet(path, params);
    return res.value;
}
// ─────────────────────────────────────────────────────────────────────────────
// Get event
// ─────────────────────────────────────────────────────────────────────────────
export async function getEvent(id) {
    return owaGet(`/events/${id}`);
}
/** Shared builder for the create/update payload fields that both endpoints accept. */
function buildEventExtras(opts, tz, eventStart) {
    const out = {};
    if (opts.recurrence)
        out.Recurrence = buildRecurrence(opts.recurrence, eventStart ?? opts.start ?? '', tz);
    if (opts.reminderMinutesBeforeStart != null)
        out.ReminderMinutesBeforeStart = opts.reminderMinutesBeforeStart;
    if (opts.isReminderOn != null)
        out.IsReminderOn = opts.isReminderOn;
    if (opts.showAs)
        out.ShowAs = capitalise(opts.showAs);
    if (opts.categories)
        out.Categories = opts.categories;
    if (opts.isPrivate != null)
        out.Sensitivity = opts.isPrivate ? 'Private' : 'Normal';
    return out;
}
export async function createEvent(opts) {
    const tz = opts.timeZone ?? 'UTC';
    const attendees = opts.attendees?.map(a => ({
        EmailAddress: { Address: a.email, Name: a.name ?? a.email },
        Type: a.type ?? 'Required',
    }));
    return owaPost('/events', {
        Subject: opts.subject,
        Body: { ContentType: opts.bodyType ?? 'Text', Content: opts.body ?? '' },
        Start: { DateTime: opts.start, TimeZone: tz },
        End: { DateTime: opts.end, TimeZone: tz },
        ...(opts.location ? { Location: { DisplayName: opts.location } } : {}),
        ...(attendees?.length ? { Attendees: attendees } : {}),
        IsOnlineMeeting: opts.isOnlineMeeting ?? false,
        Importance: opts.importance ?? 'Normal',
        IsAllDay: opts.isAllDay ?? false,
        ...buildEventExtras(opts, tz, opts.start),
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Update event
// ─────────────────────────────────────────────────────────────────────────────
export async function updateEvent(id, updates) {
    const tz = updates.timeZone ?? 'UTC';
    const body = {};
    if (updates.subject !== undefined)
        body.Subject = updates.subject;
    if (updates.body !== undefined) {
        body.Body = { ContentType: updates.bodyType ?? 'Text', Content: updates.body };
    }
    if (updates.start !== undefined)
        body.Start = { DateTime: updates.start, TimeZone: tz };
    if (updates.end !== undefined)
        body.End = { DateTime: updates.end, TimeZone: tz };
    if (updates.location !== undefined)
        body.Location = { DisplayName: updates.location };
    if (updates.isOnlineMeeting !== undefined)
        body.IsOnlineMeeting = updates.isOnlineMeeting;
    Object.assign(body, buildEventExtras(updates, tz, updates.start));
    return owaPatch(`/events/${id}`, body);
}
// ─────────────────────────────────────────────────────────────────────────────
// Delete event
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteEvent(id) {
    await owaDelete(`/events/${id}`);
}
export async function respondToEvent(id, response, comment) {
    await owaPost(`/events/${id}/${response}`, {
        Comment: comment ?? '',
        SendResponse: true,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Search events
// ─────────────────────────────────────────────────────────────────────────────
export async function searchEvents(query, fromDate, toDate) {
    return listEvents({
        startDateTime: fromDate,
        endDateTime: toDate,
        filter: `contains(subject,'${query.replace(/'/g, "''")}')`,
        top: 25,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Calendars
// ─────────────────────────────────────────────────────────────────────────────
export async function listCalendars() {
    const res = await owaGet('/calendars', {
        '$select': 'Id,Name,Color,IsDefaultCalendar,CanEdit',
    });
    return res.value;
}
/** Free/busy for a batch of addresses over a window (one digit per interval). */
export async function getSchedule(emails, start, end, intervalMinutes = 30) {
    const res = await owaPost('/calendar/getschedule', {
        Schedules: emails,
        StartTime: { DateTime: start.toISOString(), TimeZone: 'UTC' },
        EndTime: { DateTime: end.toISOString(), TimeZone: 'UTC' },
        AvailabilityViewInterval: intervalMinutes,
    });
    return res.value ?? [];
}
export async function findMeetingTimes(opts) {
    const tz = opts.timeZone ?? 'UTC';
    const now = new Date();
    const start = opts.start ?? now.toISOString();
    const end = opts.end ?? new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const minutes = opts.durationMinutes ?? 30;
    const res = await owaPost('/findmeetingtimes', {
        Attendees: opts.attendees.map(addr => ({ Type: 'Required', EmailAddress: { Address: addr } })),
        TimeConstraint: {
            Timeslots: [{ Start: { DateTime: start, TimeZone: tz }, End: { DateTime: end, TimeZone: tz } }],
        },
        MeetingDuration: `PT${minutes}M`,
        MaxCandidates: opts.maxCandidates ?? 5,
    });
    return { suggestions: res.MeetingTimeSuggestions ?? [], emptyReason: res.EmptySuggestionsReason || undefined };
}
// ─────────────────────────────────────────────────────────────────────────────
// Cancel / forward event
// ─────────────────────────────────────────────────────────────────────────────
/** Cancel an event you organize, notifying attendees. */
export async function cancelEvent(id, comment) {
    await owaPost(`/events/${id}/cancel`, { Comment: comment ?? '' });
}
/** Forward a meeting invite to additional people. */
export async function forwardEvent(id, to, comment) {
    await owaPost(`/events/${id}/forward`, {
        ToRecipients: to.map(addr => ({ EmailAddress: { Address: addr } })),
        Comment: comment ?? '',
    });
}
//# sourceMappingURL=calendar.js.map