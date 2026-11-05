import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";

import { outlookAction } from "../extension/outlook.js";
const clientId = "9199bf20-a13f-4107-85dc-02114787ef48";
const activeKey = `msal.${clientId}.active-account-filters`;
const account = {
	homeAccountId: "home.account",
	localAccountId: "user-one",
	tenantId: "tenant-one",
};
const identity = {
	workspace: "https://outlook.cloud.microsoft",
	userId: "user-one",
	tenantId: "tenant-one",
	accountId: "home.account",
};
function storage(values = {}) {
	const store = { ...values };
	Object.defineProperty(store, "getItem", { value: (key) => store[key] ?? null });
	return store;
}
function fixture(options = {}) {
	const values = { [activeKey]: JSON.stringify(account) };
	const token = (target, id = account) =>
		JSON.stringify({
			homeAccountId: id.homeAccountId,
			realm: id.tenantId,
			clientId,
			target,
			secret: "synthetic-browser-only-secret",
			expiresOn: String(Math.floor(Date.now() / 1000) + 3600),
		});
	values["msal.owa-accesstoken"] = token("https://outlook.office.com/.default");
	values["msal.graph-accesstoken"] = token("https://graph.microsoft.com/.default");
	values["msal.other-accesstoken"] = token("https://outlook.office.com/.default", {
		homeAccountId: "other",
		tenantId: "other",
	});
	const localStorage = storage(values),
		calls = [],
		document = { cookie: "" };
	const context = vm.createContext({
		location: { protocol: "https:", hostname: "outlook.cloud.microsoft" },
		document,
		localStorage,
		sessionStorage: storage(),
		crypto: webcrypto,
		atob,
		btoa,
		TextEncoder,
		TextDecoder,
		URL,
		AbortSignal,
		Uint8Array,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return options.fetch
				? options.fetch(url, init)
				: new Response(JSON.stringify({ value: [{ Id: "fixture" }] }), {
						headers: { "content-type": "application/json" },
					});
		},
	});
	const call = vm.runInContext(`(${outlookAction.toString()})`, context);
	return {
		call: (method, args = {}, expected = identity) =>
			call(method, args, expected, identity.workspace),
		calls,
		localStorage,
		document,
	};
}
test("identifies only active account, never returns credentials", async () => {
	const f = fixture();
	const response = await f.call("account.identify", {}, null);
	assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, result: identity });
	assert.equal(JSON.stringify(response).includes("synthetic-browser-only-secret"), false);
	assert.equal(f.calls.length, 0);
});
test("rejects account changes and ambiguous active state before any request", async () => {
	const f = fixture();
	assert.equal(
		(await f.call("owa.get", { path: "/messages" }, { ...identity, userId: "other" })).error,
		"identity_mismatch",
	);
	delete f.localStorage[activeKey];
	assert.equal((await f.call("owa.get", { path: "/messages" })).error, "sign_in_required");
	assert.equal(f.calls.length, 0);
});
test("decrypts encrypted access-token cache inside the tab", async () => {
	const f = fixture();
	// Exercise the actual MSAL AES-GCM/HKDF format rather than mocking decryption.
	const raw = new Uint8Array(32).fill(7),
		nonce = new Uint8Array(16).fill(2);
	const base = await webcrypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
	const key = await webcrypto.subtle.deriveKey(
		{ name: "HKDF", salt: nonce, hash: "SHA-256", info: new TextEncoder().encode("") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const encrypted = await webcrypto.subtle.encrypt(
		{ name: "AES-GCM", iv: new Uint8Array(12) },
		key,
		new TextEncoder().encode(f.localStorage["msal.owa-accesstoken"]),
	);
	f.localStorage["msal.owa-accesstoken"] = JSON.stringify({
		id: "fixture-key",
		nonce: Buffer.from(nonce).toString("base64url"),
		data: Buffer.from(encrypted).toString("base64url"),
	});
	// Missing session key fails closed, even with a valid token for another account.
	assert.equal((await f.call("account.identify", {}, null)).error, "sign_in_required");
	f.document.cookie =
		"msal.cache.encryption=" +
		encodeURIComponent(
			JSON.stringify({ id: "fixture-key", key: Buffer.from(raw).toString("base64url") }),
		);
	assert.equal((await f.call("account.identify", {}, null)).ok, true);
});
test("preserves registered mail, calendar, contact, directory and attachment routes", async () => {
	const routes = [
		["owa.get", "/MailFolders/inbox/messages"],
		["owa.get", "/messages/one/attachments/two"],
		["owa.get", "/calendarview"],
		["owa.get", "/calendars/one/calendarview"],
		["owa.get", "/contacts/one"],
		["owa.get", "/people"],
		["owa.get", "/mailboxsettings"],
		["owa.cloudSettings", "/settings/account"],
		["graph.getPath", "/users/fixture%40example.com/directReports"],
		["owa.post", "/calendar/getschedule"],
		["owa.post", "/getmailtips"],
		["owa.post", "/findmeetingtimes"],
		["owa.post", "/messages/one/createreplyall"],
		["owa.post", "/events/one/tentativelyaccept"],
		["owa.patch", "/messages/one"],
		["owa.delete", "/contacts/one"],
	];
	const f = fixture();
	for (const [method, path] of routes)
		assert.equal((await f.call(method, { path, body: {} })).ok, true, method + path);
	assert.equal(f.calls.length, routes.length);
	assert(
		f.calls.every((c) => c.init.headers.Authorization === "Bearer synthetic-browser-only-secret"),
	);
});
test("rejects arbitrary proxy, traversal, batch, headers and unregistered operations", async () => {
	const f = fixture();
	for (const path of [
		"https://example.com",
		"/messages/../../users",
		"/messages/%2e%2e",
		"/messages/a%2fb",
		"/messages/a?foo=bar",
		"/messages/a\\b",
		"/$batch",
		"/tokens",
	])
		assert.equal((await f.call("owa.post", { path })).ok, false, path);
	assert.equal(
		(await f.call("owa.get", { path: "/messages", params: { unregistered: "x" } })).ok,
		false,
	);
	assert.equal((await f.call("graph.post", { path: "/me/messages" })).ok, false);
	assert.equal(f.calls.length, 0);
});
test("dispatches writes once and marks a lost response uncertain", async () => {
	const f = fixture({
		fetch: () => {
			throw Error("socket closed after commit");
		},
	});
	const response = await f.call("owa.post", {
		path: "/sendmail",
		body: { Message: { Subject: "fixture" } },
	});
	assert.equal(response.error, "SAVE_UNVERIFIED");
	assert.equal(f.calls.length, 1);
});
test("returns binary photo contents and large attachment data without a small JSON cutoff", async () => {
	const photo = Buffer.alloc(2 * 1024 * 1024, 3);
	const f = fixture({
		fetch: () => new Response(photo, { headers: { "content-type": "image/jpeg" } }),
	});
	const response = await f.call("graph.binary", { path: "/me/photo/$value" });
	assert.equal(response.ok, true);
	assert.equal(Buffer.from(response.result.base64, "base64").equals(photo), true);
});
