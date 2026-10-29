/**
 * People and directory lookup API.
 */
import { owaGet } from './client.js';
// ─────────────────────────────────────────────────────────────────────────────
// Search people
// ─────────────────────────────────────────────────────────────────────────────
export async function searchPeople(query, top = 10) {
    const res = await owaGet('/people', {
        '$search': `"${query}"`,
        '$top': String(top),
        '$select': 'DisplayName,GivenName,Surname,ScoredEmailAddresses,JobTitle,Department,UserPrincipalName',
    });
    return res.value;
}
//# sourceMappingURL=people.js.map