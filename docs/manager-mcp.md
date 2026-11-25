# Manager MCP gateway

Connect an external agent to the same office and Joi conversation you use in the WebUI and Telegram. The gateway exposes manager console commands for fleet, desks, floors, delivery, office lifecycle and work intake, alongside the shared phone and staffing proposals. CubeFarm must stay running. The gateway and its Settings controls are available only when the office runs from a CubeFarm checkout on branch `main`. Preview and other branch offices, detached checkouts, and standalone npm installations have the gateway disabled.

1. Open CubeFarm through localhost and go to **Settings → Manager MCP**. Generate a dedicated random token with `openssl rand -hex 32`, paste it into **MCP token**, choose **Save token**, then turn on **Enable manager MCP gateway**. The token must be 32–256 URL-safe characters (letters, digits, `.`, `_`, `~`, `-`).
2. In your MCP client's server settings, choose Streamable HTTP, use `http://127.0.0.1:4317/mcp` (adjust the port if needed), and set `Authorization: Bearer <token>` using your client's secret or header configuration.
3. Check that the client discovers `get_office_status`. The server uses stateless JSON responses. Clients poll for new phone messages and proposals.

Settings changes take effect immediately and survive restart. A token saved in Settings takes precedence over the `CUBEFARM_MCP_TOKEN` environment variable and private [config file](configuration.md). **Clear saved token** restores the startup token if one is configured. The switch controls access independently of the token source. CubeFarm stores a verifier for the saved token and leaves the field blank after saving.

Give this token only to agents you trust to act as the manager, including removing floors and desks, merging pulls and closing the office. All manager tools use the same bearer token; destructive annotations describe effects and do not add another permission gate. Turn the switch off to revoke access, or save a new token to rotate it. For a client on another machine, use a private tunnel to the loopback address or an HTTPS proxy that exposes only `/mcp`. The gateway rejects browser-origin requests. Its token is separate from Telegram's bot token and the CEO's private session credentials.

| Tool | Use |
| --- | --- |
| `get_office_status` | Check if the office is open, see the CEO queue, and inspect project floors and current agent assignments. |
| `read_phone` | Read the latest messages, or pass `afterId` with the previous `nextCursor` to poll in order. `hasMore` means there is another page; `gap` means the cursor is older than the latest 100 messages the gateway can read. Reading does not clear the WebUI's unread indicator. |
| `send_message` | Submit up to 4000 characters with a client-generated UUID in `requestId`. Returns the shared `messageId` on acceptance; poll the phone for replies. |
| `list_proposals` | Read hiring and dismissal proposals. Pass `status: "pending"` to see those awaiting a decision. |
| `decide_proposal` | Pass `proposalId` and `decision: "approve"` or `"reject"`. The existing proposal must still be pending. If the outcome is uncertain, look it up before trying again. |

Console commands call the same office methods as their HTTP counterparts, including validation and demo behavior. Object results keep the console's shape in `structuredContent` and JSON text; commands without a result return `{ "ok": true }`. Use `get_office_snapshot` to inspect the current state after a command. Except for the phone's UUID receipts, commands have the same retry semantics as the console: check state after an uncertain response before repeating a mutation. The per-agent `/api/mcp/:token` server is unchanged.

| Tools | Arguments and effect |
| --- | --- |
| `get_office_snapshot` | No arguments. Returns the full console snapshot, including IDs, floor issues/pulls, QA, settings, ideas, publications and Telegram delivery state. |
| `list_boxes` | No arguments. Returns boxes and office machine telemetry/capacity. |
| `add_box` | Required `destination` (SSH destination), optional `name`. Registers and connects a worker box. |
| `remove_box`, `check_box` | Required `boxId`. Remove clears fleet placements while running CLIs finish; check reconnects or refreshes capabilities. Removal does not delete the remote machine. |
| `set_fleet_capacity` | Required `machineId` (box ID, or `""` for the office) and `capacity`: `fixed`, `resizable` or `unknown`. |
| `stop_agent`, `reset_agent`, `dismiss_agent` | Required `agentId`. Stop holds work; reset clears the task/conversation; dismiss stops the session and removes the agent's desk/worktree. |
| `assign_agent`, `message_agent` | Required `agentId` plus `issueNumber` (optional `note`) or `text`, respectively. |
| `update_agent` | Required `agentId` and `patch` for profile, CLI/model or placement. `box: null` restores floor placement. |
| `get_agent_screen`, `prepare_image_prompt` | Required `agentId`; prompt also requires `text`. Screen returns an MCP image plus capture time, or an error if unavailable. |
| `add_floor` | Required `name`. Creates a repository and floor; optional `owner`, `description`, `visibility` (defaults to `private`), `mission`, `autoAssign` (defaults to `false`). |
| `connect_floor`, `connect_folder` | Required `fullName` (`owner/repo`) or local `path` on the office machine. Connect existing GitHub projects; optional `mission` and `autoAssign`. |
| `update_floor` | Required `repoId` and `patch`. Supports automation, profile, preview and box settings; `everyone: true` clears agent placement overrides when moving a floor. |
| `remove_floor` | Required `repoId`. Dismisses its agents and removes preview/QA state. The GitHub repository and project folder remain. |
| `sync_floor`, `sync_floor_folder`, `onboard_floor`, `stop_preview` | Required `repoId`. Refresh GitHub state, sync the local folder, queue onboarding, or remove the preview, respectively. |
| `plan_floor` | Required `repoId`, optional `mission` to replace the brief before queuing CEO planning. |
| `merge_pull`, `close_pull`, `run_qa` | Required `repoId` and positive `number`. Merge changes the default branch and closes resolved issues; optional `method`: `squash` (default), `merge`, `rebase`. Close shuts an unmerged pull; QA dispatches review. Console merge checks still apply. |
| `approve_prototype`, `revise_prototype` | Required `repoId`, `number`, `head` (reviewed SHA). Approval turns the existing prototype issue into an implementation issue using required `title` and `body`; revision requires `feedback`. |
| `close_office`, `reopen_office` | No arguments. Close holds new work across floors and lets running jobs drain before it becomes safe to shut down; reopen resumes held work. |
| `update_office` | Required `action`: `now` or `later`. Requires a launcher capable of updating the office. |
| `update_settings` | Required `patch` with settings to change. Read the snapshot for current values and `tools/list` for supported fields. |
| `retry_telegram`, `skip_telegram` | No arguments. Resolve the first uncertain delivery by retrying (possibly duplicating delivery) or discarding it. |
| `mark_phone_read` | Optional `at` (epoch milliseconds), defaults to now. Updates the shared unread indicator. |
| `send_ceo_message`, `request_ceo_review` | Message is an alias of `send_message`, requiring `text` and UUID `requestId`, with the same MCP origin/receipt. Review takes no arguments and queues a company review. |
| `request_research` | Required `text`, optional `repoId`. Briefs the researcher. |
| `create_idea` | Required `description`; optional `constraints`, `links`, `floorHints` (floor IDs), `linkedFrom` (idea ID). Submits an idea for research. |
| `reply_idea`, `retry_idea` | Required `ideaId`; reply also requires `answer`. Answers clarification or retries research. |
| `reject_request` | Required `requestId`, optional `note`. Rejects a pending staffing request. |
| `retry_publication` | Required `proposalId` (also the publication ID). Retries an already approved issue plan; never implies approval. |

For a message retry, use the same UUID and text. CubeFarm returns the original receipt while the message remains in its 200-message phone history, including after a restart. A changed message needs a new UUID. After that history rolls over, check the outcome before resubmitting: the old key may no longer prevent another submission. Acceptance confirms that the office recorded the instruction; it does not confirm that Joi finished the work or that a later reply belongs to that specific instruction. The phone is one shared conversation.
