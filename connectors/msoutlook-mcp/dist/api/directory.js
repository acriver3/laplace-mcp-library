/**
 * Directory API: org hierarchy and rich user profiles via Microsoft Graph.
 *
 * Works with the directory read permission the Outlook app already has. Pass an
 * email/UPN to target a colleague, or omit it to target the signed-in user.
 */
import { graphGetPath, graphGetBinary } from './client.js';
const PROFILE_SELECT = 'id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,mobilePhone,businessPhones,city,country';
/** Build the base Graph path for a target: '/me' or '/users/{email}'. */
function base(email) {
    return email ? `/users/${encodeURIComponent(email)}` : '/me';
}
export async function getUserProfile(email) {
    return graphGetPath(base(email), { '$select': PROFILE_SELECT });
}
export async function getManager(email) {
    return graphGetPath(`${base(email)}/manager`, { '$select': PROFILE_SELECT });
}
export async function getDirectReports(email) {
    const res = await graphGetPath(`${base(email)}/directReports`, {
        '$select': PROFILE_SELECT,
    });
    return res.value ?? [];
}
export async function getUserPhoto(email) {
    return graphGetBinary(`${base(email)}/photo/$value`);
}
//# sourceMappingURL=directory.js.map