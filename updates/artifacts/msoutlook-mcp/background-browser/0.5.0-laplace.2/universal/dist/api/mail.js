/**
 * Mail API — email CRUD, search, and folder operations.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { owaGet, owaPost, owaPatch, owaDelete } from './client.js';
// ─────────────────────────────────────────────────────────────────────────────
// Body formatting
// ─────────────────────────────────────────────────────────────────────────────
const HTML_TAG_RE = /<\/?[a-z][^>]*>/i;
/** True when the string already carries HTML markup we should leave untouched. */
export function looksLikeHtml(s) {
    return HTML_TAG_RE.test(s);
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * Normalise an outgoing body to HTML so line breaks survive.
 *
 * Outlook renders reply/forward comments and HTML bodies as HTML, where a raw
 * "\n" collapses and the whole message arrives as one block. To stop that:
 * - if the body already contains HTML markup, pass it through untouched, but
 * - if it is plain text, escape it and turn newlines into <br> (a blank line,
 *   i.e. a double newline, becomes <br><br> so paragraphs keep their gap).
 */
export function toHtmlBody(body) {
    if (looksLikeHtml(body))
        return body;
    return escapeHtml(body).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}
export async function listMessages(opts = {}) {
    const folder = opts.folder ?? 'Inbox';
    const params = {
        '$top': String(opts.top ?? 20),
        '$select': (opts.select ?? [
            'Id', 'Subject', 'BodyPreview', 'From', 'ToRecipients', 'ReceivedDateTime',
            'IsRead', 'HasAttachments', 'Importance', 'Flag', 'ConversationId', 'WebLink',
        ]).join(','),
    };
    if (opts.skip)
        params['$skip'] = String(opts.skip);
    // $search cannot be combined with $orderby or $filter — the API returns
    // 400 SearchWithOrderBy. Search results are relevance-ranked, so we drop
    // ordering when searching.
    if (opts.search) {
        params['$search'] = `"${opts.search}"`;
    }
    else {
        params['$orderby'] = opts.orderBy ?? 'ReceivedDateTime desc';
        if (opts.filter)
            params['$filter'] = opts.filter;
    }
    const res = await owaGet(`/MailFolders/${folder}/messages`, params);
    return res.value;
}
// ─────────────────────────────────────────────────────────────────────────────
// Get message
// ─────────────────────────────────────────────────────────────────────────────
export async function getMessage(id, includeAttachments = false) {
    const params = includeAttachments ? { '$expand': 'Attachments' } : undefined;
    return owaGet(`/messages/${id}`, params);
}
function toOwaAttachment(a) {
    return {
        '@odata.type': '#Microsoft.OutlookServices.FileAttachment',
        Name: a.name,
        ContentType: a.contentType,
        ContentBytes: a.contentBytes,
    };
}
const CONTENT_TYPES = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.json': 'application/json', '.ics': 'text/calendar',
};
/** Read a file from disk into an outgoing attachment (base64 encoded). */
export async function fileToAttachment(path) {
    const data = await readFile(path);
    return {
        name: basename(path),
        contentType: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        contentBytes: data.toString('base64'),
    };
}
export async function sendEmail(opts) {
    const toRecipients = opts.to.map(addr => ({
        EmailAddress: { Address: addr },
    }));
    const ccRecipients = opts.cc?.map(addr => ({ EmailAddress: { Address: addr } }));
    const bccRecipients = opts.bcc?.map(addr => ({ EmailAddress: { Address: addr } }));
    const bodyType = opts.bodyType ?? 'HTML';
    const content = bodyType === 'HTML' ? toHtmlBody(opts.body) : opts.body;
    await owaPost('/sendmail', {
        Message: {
            Subject: opts.subject,
            Body: { ContentType: bodyType, Content: content },
            ToRecipients: toRecipients,
            ...(ccRecipients?.length ? { CcRecipients: ccRecipients } : {}),
            ...(bccRecipients?.length ? { BccRecipients: bccRecipients } : {}),
            Importance: opts.importance ?? 'Normal',
            ...(opts.attachments?.length ? { Attachments: opts.attachments.map(toOwaAttachment) } : {}),
        },
        SaveToSentItems: opts.saveToSentItems !== false,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Create draft
// ─────────────────────────────────────────────────────────────────────────────
export async function createDraft(opts) {
    const toRecipients = opts.to.map(addr => ({ EmailAddress: { Address: addr } }));
    const ccRecipients = opts.cc?.map(addr => ({ EmailAddress: { Address: addr } }));
    const bccRecipients = opts.bcc?.map(addr => ({ EmailAddress: { Address: addr } }));
    const bodyType = opts.bodyType ?? 'HTML';
    const content = bodyType === 'HTML' ? toHtmlBody(opts.body) : opts.body;
    return owaPost('/messages', {
        Subject: opts.subject,
        Body: { ContentType: bodyType, Content: content },
        ToRecipients: toRecipients,
        ...(ccRecipients?.length ? { CcRecipients: ccRecipients } : {}),
        ...(bccRecipients?.length ? { BccRecipients: bccRecipients } : {}),
        Importance: opts.importance ?? 'Normal',
        ...(opts.attachments?.length ? { Attachments: opts.attachments.map(toOwaAttachment) } : {}),
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Reply
// ─────────────────────────────────────────────────────────────────────────────
export async function replyToMessage(id, body, replyAll = false) {
    const action = replyAll ? 'replyall' : 'reply';
    await owaPost(`/messages/${id}/${action}`, {
        Comment: toHtmlBody(body),
    });
}
/**
 * Create a reply (or reply-all) as a draft instead of sending it.
 *
 * Returns the new draft message, which already has the recipients and the
 * quoted original prefilled, with the supplied body inserted above the quote.
 * The caller can then review or edit it in Outlook and send it later with
 * sendDraft (outlook_send_draft).
 */
export async function createReplyDraft(id, body, replyAll = false) {
    const action = replyAll ? 'createreplyall' : 'createreply';
    return owaPost(`/messages/${id}/${action}`, {
        Comment: toHtmlBody(body),
    });
}
/**
 * Create a forward as a draft instead of sending it. Returns the draft message
 * with the quoted original prefilled; recipients and any final edits can be set
 * in Outlook (or via a later update) before sending with sendDraft.
 */
export async function createForwardDraft(id, body = '', to) {
    const payload = { Comment: body ? toHtmlBody(body) : '' };
    if (to?.length) {
        payload.ToRecipients = to.map(addr => ({ EmailAddress: { Address: addr } }));
    }
    return owaPost(`/messages/${id}/createforward`, payload);
}
// ─────────────────────────────────────────────────────────────────────────────
// Forward
// ─────────────────────────────────────────────────────────────────────────────
export async function forwardMessage(id, to, comment) {
    await owaPost(`/messages/${id}/forward`, {
        ToRecipients: to.map(addr => ({ EmailAddress: { Address: addr } })),
        Comment: comment ? toHtmlBody(comment) : '',
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Mark read/unread
// ─────────────────────────────────────────────────────────────────────────────
export async function markMessageRead(id, isRead = true) {
    await owaPatch(`/messages/${id}`, { IsRead: isRead });
}
// ─────────────────────────────────────────────────────────────────────────────
// Flag
// ─────────────────────────────────────────────────────────────────────────────
export async function flagMessage(id, status = 'Flagged') {
    await owaPatch(`/messages/${id}`, { Flag: { FlagStatus: status } });
}
// ─────────────────────────────────────────────────────────────────────────────
// Move
// ─────────────────────────────────────────────────────────────────────────────
export async function moveMessage(id, destinationFolderId) {
    return owaPost(`/messages/${id}/move`, {
        DestinationId: destinationFolderId,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteMessage(id) {
    await owaDelete(`/messages/${id}`);
}
/** Reduce an ISO date or datetime to the YYYY-MM-DD form KQL expects. */
function toKqlDate(value) {
    return value.slice(0, 10);
}
/**
 * Search messages with optional date range and pagination.
 *
 * The OWA REST API rejects $skip, $filter and $orderby alongside $search, so:
 * - date range is expressed as KQL constraints inside the search string
 *   (received>=START AND received<=END), and
 * - pagination uses the $skiptoken returned in @odata.nextLink.
 */
export async function searchMessages(opts) {
    const folder = opts.folder ?? 'Inbox';
    const parts = [];
    const keyword = opts.query?.trim();
    if (keyword)
        parts.push(keyword);
    if (opts.startDate)
        parts.push(`received>=${toKqlDate(opts.startDate)}`);
    if (opts.endDate)
        parts.push(`received<=${toKqlDate(opts.endDate)}`);
    if (parts.length === 0) {
        throw new Error('searchMessages needs a query and/or a date range (startDate or endDate).');
    }
    const kql = parts.join(' AND ');
    const params = {
        '$search': `"${kql}"`,
        '$top': String(opts.top ?? 20),
        '$select': 'Id,Subject,BodyPreview,From,ReceivedDateTime,IsRead,WebLink',
    };
    if (opts.skipToken)
        params['$skiptoken'] = opts.skipToken;
    const res = await owaGet(`/MailFolders/${folder}/messages`, params);
    let nextSkipToken;
    const nextLink = res['@odata.nextLink'];
    if (nextLink) {
        try {
            nextSkipToken = new URL(nextLink).searchParams.get('$skiptoken') ?? undefined;
        }
        catch {
            nextSkipToken = undefined;
        }
    }
    return { messages: res.value, nextSkipToken };
}
// ─────────────────────────────────────────────────────────────────────────────
// Folders
// ─────────────────────────────────────────────────────────────────────────────
export async function listFolders() {
    const res = await owaGet('/mailfolders', {
        '$top': '50',
        '$select': 'Id,DisplayName,UnreadItemCount,TotalItemCount,ChildFolderCount',
    });
    return res.value;
}
export async function getFolder(idOrName) {
    return owaGet(`/mailfolders/${idOrName}`);
}
// ─────────────────────────────────────────────────────────────────────────────
// Unread count
// ─────────────────────────────────────────────────────────────────────────────
export async function getUnreadMessages(top = 10) {
    return listMessages({
        filter: 'IsRead eq false',
        top,
        orderBy: 'ReceivedDateTime desc',
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Send draft
// ─────────────────────────────────────────────────────────────────────────────
export async function sendDraft(draftId) {
    await owaPost(`/messages/${draftId}/send`, {});
}
export async function updateDraft(id, opts) {
    const patch = {};
    if (opts.subject !== undefined)
        patch.Subject = opts.subject;
    if (opts.body !== undefined) {
        const bodyType = opts.bodyType ?? 'HTML';
        patch.Body = { ContentType: bodyType, Content: bodyType === 'HTML' ? toHtmlBody(opts.body) : opts.body };
    }
    if (opts.to)
        patch.ToRecipients = opts.to.map(addr => ({ EmailAddress: { Address: addr } }));
    if (opts.cc)
        patch.CcRecipients = opts.cc.map(addr => ({ EmailAddress: { Address: addr } }));
    if (opts.bcc)
        patch.BccRecipients = opts.bcc.map(addr => ({ EmailAddress: { Address: addr } }));
    if (opts.importance)
        patch.Importance = opts.importance;
    return owaPatch(`/messages/${id}`, patch);
}
export async function listAttachments(messageId) {
    const res = await owaGet(`/messages/${messageId}/attachments`, {
        '$select': 'Id,Name,ContentType,Size,IsInline',
    });
    return res.value;
}
/** Fetch one attachment including its base64 content bytes. */
export async function getAttachmentContent(messageId, attachmentId) {
    return owaGet(`/messages/${messageId}/attachments/${attachmentId}`);
}
/** Add a file attachment to an existing message/draft. */
export async function addAttachment(messageId, attachment) {
    await owaPost(`/messages/${messageId}/attachments`, toOwaAttachment(attachment));
}
// ─────────────────────────────────────────────────────────────────────────────
// Conversation (thread)
// ─────────────────────────────────────────────────────────────────────────────
export async function getConversation(conversationId, top = 50) {
    // Filtering by ConversationId cannot be combined with $orderby (the API
    // rejects it as an inefficient filter), so we sort by received date here.
    const res = await owaGet('/messages', {
        '$filter': `ConversationId eq '${conversationId.replace(/'/g, "''")}'`,
        '$top': String(top),
        '$select': 'Id,Subject,BodyPreview,From,ToRecipients,ReceivedDateTime,IsRead,HasAttachments,ConversationId,WebLink',
    });
    return res.value.sort((a, b) => (a.ReceivedDateTime ?? '').localeCompare(b.ReceivedDateTime ?? ''));
}
// ─────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────
export async function setCategories(messageId, categories) {
    return owaPatch(`/messages/${messageId}`, { Categories: categories });
}
// ─────────────────────────────────────────────────────────────────────────────
// Folder management
// ─────────────────────────────────────────────────────────────────────────────
export async function createFolder(displayName, parentFolderId) {
    const path = parentFolderId ? `/mailfolders/${parentFolderId}/childfolders` : '/mailfolders';
    return owaPost(path, { DisplayName: displayName });
}
export async function renameFolder(id, displayName) {
    return owaPatch(`/mailfolders/${id}`, { DisplayName: displayName });
}
export async function deleteFolder(id) {
    await owaDelete(`/mailfolders/${id}`);
}
//# sourceMappingURL=mail.js.map