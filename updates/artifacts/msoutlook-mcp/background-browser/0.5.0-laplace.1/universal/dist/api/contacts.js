/**
 * Contacts API.
 */
import { owaGet, owaPost, owaDelete } from './client.js';
// ─────────────────────────────────────────────────────────────────────────────
// List contacts
// ─────────────────────────────────────────────────────────────────────────────
export async function listContacts(search, top = 25) {
    const params = {
        '$top': String(top),
        '$select': 'Id,DisplayName,GivenName,Surname,EmailAddresses,BusinessPhones,MobilePhone1,JobTitle,CompanyName',
    };
    // $search cannot be combined with $orderby (400 SearchWithOrderBy).
    // Search results are relevance-ranked; only order when not searching.
    if (search) {
        params['$search'] = `"${search}"`;
    }
    else {
        params['$orderby'] = 'displayName asc';
    }
    const res = await owaGet('/contacts', params);
    return res.value;
}
// ─────────────────────────────────────────────────────────────────────────────
// Get contact
// ─────────────────────────────────────────────────────────────────────────────
export async function getContact(id) {
    return owaGet(`/contacts/${id}`);
}
export async function createContact(opts) {
    const emailAddresses = opts.email ? [{ Address: opts.email }] : undefined;
    return owaPost('/contacts', {
        GivenName: opts.givenName,
        Surname: opts.surname,
        DisplayName: opts.displayName ?? `${opts.givenName ?? ''} ${opts.surname ?? ''}`.trim(),
        ...(emailAddresses ? { EmailAddresses: emailAddresses } : {}),
        ...(opts.businessPhone ? { BusinessPhones: [opts.businessPhone] } : {}),
        MobilePhone1: opts.mobilePhone,
        JobTitle: opts.jobTitle,
        CompanyName: opts.companyName,
        PersonalNotes: opts.notes,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Delete contact
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteContact(id) {
    await owaDelete(`/contacts/${id}`);
}
//# sourceMappingURL=contacts.js.map