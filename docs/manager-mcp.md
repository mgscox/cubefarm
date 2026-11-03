# Manager MCP gateway

Connect an external agent to the same office and Joi conversation you use in the WebUI and Telegram. The gateway can check work in progress, send manager instructions, read replies and decide on existing staffing proposals. CubeFarm must stay running. The gateway and its Settings controls are available only when the office runs from a CubeFarm checkout on branch `main`. Preview and other branch offices, detached checkouts, and standalone npm installations have the gateway disabled.

1. Open CubeFarm through localhost and go to **Settings → Manager MCP**. Generate a dedicated random token with `openssl rand -hex 32`, paste it into **MCP token**, choose **Save token**, then turn on **Enable manager MCP gateway**. The token must be 32–256 URL-safe characters (letters, digits, `.`, `_`, `~`, `-`).
2. In your MCP client's server settings, choose Streamable HTTP, use `http://127.0.0.1:4317/mcp` (adjust the port if needed), and set `Authorization: Bearer <token>` using your client's secret or header configuration.
3. Check that the client discovers `get_office_status`. The server uses stateless JSON responses. Clients poll for new phone messages and proposals.

Settings changes take effect immediately and survive restart. A token saved in Settings takes precedence over the `CUBEFARM_MCP_TOKEN` environment variable and private [config file](configuration.md). **Clear saved token** restores the startup token if one is configured. The switch controls access independently of the token source. CubeFarm stores a verifier for the saved token and leaves the field blank after saving.

Give this token only to agents you trust to act as the manager, including approving hires or dismissals. Turn the switch off to revoke access, or save a new token to rotate it. For a client on another machine, use a private tunnel to the loopback address or an HTTPS proxy that exposes only `/mcp`. The gateway rejects browser-origin requests. Its token is separate from Telegram's bot token and the CEO's private session credentials.

| Tool | Use |
| --- | --- |
| `get_office_status` | Check if the office is open, see the CEO queue, and inspect project floors and current agent assignments. |
| `read_phone` | Read the latest messages, or pass `afterId` with the previous `nextCursor` to poll in order. `hasMore` means there is another page; `gap` means the cursor is older than the latest 100 messages the gateway can read. Reading does not clear the WebUI's unread indicator. |
| `send_message` | Submit up to 4000 characters with a client-generated UUID in `requestId`. Returns the shared `messageId` on acceptance; poll the phone for replies. |
| `list_proposals` | Read hiring and dismissal proposals. Pass `status: "pending"` to see those awaiting a decision. |
| `decide_proposal` | Pass `proposalId` and `decision: "approve"` or `"reject"`. The existing proposal must still be pending. If the outcome is uncertain, look it up before trying again. |

For a message retry, use the same UUID and text. CubeFarm returns the original receipt while the message remains in its 200-message phone history, including after a restart. A changed message needs a new UUID. After that history rolls over, check the outcome before resubmitting: the old key may no longer prevent another submission. Acceptance confirms that the office recorded the instruction; it does not confirm that Joi finished the work or that a later reply belongs to that specific instruction. The phone is one shared conversation.
