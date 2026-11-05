/**
 * Mailbox settings API: read settings and manage your own automatic replies
 * (out of office), via the OWA REST endpoint the session token can reach.
 */
import { owaGet, owaPatch } from './client.js';
export async function getMailboxSettings() {
    return owaGet('/mailboxsettings');
}
/**
 * Turn automatic replies on or off for the signed-in user. When status is
 * Scheduled, start and end define the window. The external message defaults to
 * the internal one when only the internal text is supplied.
 */
export async function setAutomaticReplies(opts) {
    const tz = opts.timeZone ?? 'UTC';
    const setting = {
        Status: opts.status,
        ExternalAudience: opts.externalAudience ?? 'All',
    };
    if (opts.status !== 'Disabled') {
        setting.InternalReplyMessage = opts.internalMessage ?? '';
        setting.ExternalReplyMessage = opts.externalMessage ?? opts.internalMessage ?? '';
    }
    if (opts.status === 'Scheduled') {
        if (opts.start)
            setting.ScheduledStartDateTime = { DateTime: opts.start, TimeZone: tz };
        if (opts.end)
            setting.ScheduledEndDateTime = { DateTime: opts.end, TimeZone: tz };
    }
    return owaPatch('/mailboxsettings', { AutomaticRepliesSetting: setting });
}
//# sourceMappingURL=mailbox.js.map