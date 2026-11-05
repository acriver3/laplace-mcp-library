import { slackRead } from "./slack.js";
import { ycAction } from "./ycombinator.js";
import { outlookAction } from "./outlook.js";

// Reviewed, bundled adapters only. Desktop cannot supply code, domains, or
// arbitrary actions. New providers share discovery, consent, and session state.
export const providers = {
  outlook: {
    origins: ["https://outlook.cloud.microsoft/*", "https://outlook.office.com/*", "https://outlook.office365.com/*"],
    matches: url => /^https:\/\/outlook\.(?:cloud\.microsoft|office\.com|office365\.com)\//.test(url),
    openUrl: workspace => workspace === "https://outlook.cloud.microsoft" ? workspace + "/mail/" : null,
    label: "Outlook",
    scopes: ["Read mail, calendars, contacts, directory, and attachments", "Send and change mail, calendar events, contacts, and mailbox settings when requested"],
    identify: "account.identify",
    methods: ["owa.get", "owa.cloudSettings", "owa.post", "owa.patch", "owa.delete", "graph.getPath", "graph.binary", "account.status"],
    read: outlookAction,
    failures: {
      not_outlook_tab: "Open Outlook in this Chrome profile.",
      sign_in_required: "Finish signing in to the intended account in Outlook, then review again.",
      identity_mismatch: "The Outlook account changed. Review and approve the intended account again.",
      request_failed: "Outlook is unavailable. Check the selected tab.",
    },
  },
	ycombinator: {
		origins: ["https://apply.ycombinator.com/*"],
		matches: (url) => new URL(url).origin === "https://apply.ycombinator.com",
		openUrl: (workspace) => (workspace === "https://apply.ycombinator.com" ? workspace : null),
		label: "Y Combinator · Demo Only",
		scopes: [
			"Read applications and answers in this tab",
			"Preview edits and save draft answers when requested",
			"Never submit an application",
		],
		approvalLabel: "Approve reads and draft saves",
		identify: "account.identify",
		methods: ["applications.list", "application.read", "application.saveDraft"],
		read: ycAction,
		failures: {
			not_yc_tab: "Open apply.ycombinator.com in this tab, then review again.",
			sign_in_required: "Sign in to YC normally in this tab, then review again.",
			identity_mismatch:
				"The YC account changed. Disconnect and approve the intended account again.",
		},
	},
	slack: {
		origins: ["https://*.slack.com/*", "https://*.slack-gov.com/*"],
		matches: (url) =>
			/^https:\/\/(?:[a-z0-9-]+\.)?(?:slack\.com|slack-gov\.com)\/client\/[TE]/.test(url),
		openUrl: (workspace) =>
			/^https:\/\/[a-z0-9-]+\.(slack\.com|slack-gov\.com)$/.test(workspace) ? workspace : null,
		label: "Slack",
		scopes: ["List channels", "Read conversation history and replies", "Search messages"],
		identify: "auth.test",
		failures: {
			not_slack_tab: "Open the Slack web app in this tab, then open the extension again.",
			workspace_tab_required:
				"Open a workspace or Enterprise conversation in the Slack web app, then review again.",
			session_unavailable:
				"Slack is open, but its signed-in session is not available to the extension. Reload the Slack tab, wait for it to finish loading, and review again. If this persists, report code SLACK_SESSION_UNAVAILABLE to your agent.",
			invalid_request:
				"The Slack request is invalid. Ask your agent to update the Laplace extension.",
			request_failed:
				"The browser could not complete Slack's connection check. Check that Slack works normally in this tab and try again.",
			rate_limited:
				"Slack has temporarily limited connection checks. Wait a minute, then review again.",
			session_expired:
				"Slack rejected this browser session. Finish signing in normally in the Slack tab, then review again.",
			provider_denied:
				"Slack denied the connection check. Report code SLACK_PROVIDER_DENIED to your agent.",
			invalid_response:
				"Slack returned an unexpected response. Report code SLACK_INVALID_RESPONSE to your agent.",
			identity_mismatch:
				"Slack's account or organization does not match this tab. Reload the requested workspace and review again.",
			workspace_mismatch:
				"This Slack session belongs to a different workspace than the Desktop request. Open the requested workspace and review again.",
		},
		methods: [
			"conversations.list",
			"conversations.history",
			"conversations.replies",
			"search.messages",
		],
		read: slackRead,
	},
};
export function provider(id) {
	if (!Object.hasOwn(providers, id))
		throw new Error("This provider needs a newer Laplace extension.");
	return providers[id];
}
