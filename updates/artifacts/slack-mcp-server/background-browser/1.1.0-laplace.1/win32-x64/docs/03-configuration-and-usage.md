# Configuration

Use the Patchright launcher and absolute paths in [README](../README.md#connect-to-laplace-local). Both login and serve require `--workspace`. Optional `--profile-dir` selects a dedicated profile. `serve` accepts `--binary` to select a locally built patched Go binary. The launcher uses stdio transport. Keep the default profile outside the source directory.

The server retains upstream tool filters, caching, proxy and TLS options. Set `SLACK_MCP_ENABLED_TOOLS` to limit available tools. Do not configure Slack token environment variables in the MCP client. Tokens come from the Patchright session. The launcher propagates the browser's user agent and GovSlack selection.
