# Authentication

This edition supports only interactive Patchright browser login. See [the fork setup guide](../README.md#setup). Users complete Slack sign-in and MFA in a dedicated Chromium profile. OAuth and bot tokens are rejected. The launcher extracts the selected workspace session in memory and passes it to the server. Never paste tokens into chat or connector configuration.
