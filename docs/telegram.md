# Joi on Telegram

Telegram presents the same manager–Joi phone conversation as the WebUI. There is one CEO and one queue, with the same tools, resumable session context, office closure rules and proposal commands. The server must remain running; the browser may be closed. Telegram does not mark WebUI messages read or extend Joi's model memory.

## Local setup

1. In Telegram, open the official [BotFather](https://t.me/BotFather), use `/newbot`, and follow its instructions. Use a dedicated bot for this office. Do not paste the token into the WebUI, a phone message, an issue or an agent session.
2. Set `CUBEFARM_TELEGRAM_TOKEN` in the environment of the CubeFarm server using your local service/terminal's secret configuration, then restart CubeFarm normally. Keep any local secret file private and outside version control. CubeFarm stores only a fingerprint, never the token, in its state. Agent/preview environments exclude this variable.
3. Open Phone → Chat → Telegram, choose **Create pairing code**, and send the displayed `/start CODE` to your bot in a **private** chat within five minutes.
4. Compare the numeric user and chat identity in the WebUI with the account you intended to authorize, then choose **Confirm pairing** locally. A code alone never grants office access. If the candidate is wrong, generate a fresh code. Codes expire and do not survive a server restart.

Only that user in that private chat can submit text or use proposal buttons. Groups, other users, usernames, forwarded callbacks and unknown cards do not grant access. The WebUI retains its existing local-manager access model: protect access to the office itself.

No public URL or webhook is required. The server uses [Bot API long polling](https://core.telegram.org/bots/api#getupdates). An existing webhook or another polling consumer produces a visible conflict; CubeFarm never removes webhooks automatically. Resolve the conflicting configuration yourself and restart. Do not share a bot between offices.

## Conversation and decisions

New WebUI manager messages appear with **Manager (WebUI)** attribution. Telegram manager messages become canonical manager messages in the phone, without being echoed back to Telegram. Joi replies and office notices mirror in order. Input is text only, 1–4000 UTF-16 code units, consistently validated in both interfaces; attachments and voice notes receive an explanation and never trigger CEO work. Long outbound replies use ordered plain-text parts under Telegram's [message size limit](https://core.telegram.org/bots/api#sendmessage), preserving Unicode surrogate pairs. Phone retention remains 200 messages (100 in reconnect snapshots); reply text is no longer truncated at 6000 characters before mirroring.

Hiring and dismissal proposals have default Approve and Reject buttons, invoking the same synchronous, pending-status-guarded commands as the WebUI. Decisions update the original Telegram card and create the usual shared office notice. Repeated or stale actions cannot hire/fire twice; proposal field edits and custom rejection notes remain in the WebUI.

First pairing starts at new activity and sends no history. Reconnecting the same bot/pairing resumes pending work. **Revoke pairing** immediately removes authorization and clears its pending mirror content; pair again to replace the recipient. Changing the bot token also resets authorization/backlog. A send already in flight when revoked may still arrive at the previous recipient; its result cannot affect the new pairing.

## Delivery, capacity and recovery

Connection health and pending count arrive through the ordinary snapshot/events. WebUI messaging remains available during Telegram outages. Known failed sends retry in conversation order with backoff/rate-limit delays. The outbox stores complete text independently of retained phone history and records confirmed part progress in the office state.

A timeout after Telegram accepts a send is ambiguous. An in-flight delivery found after restart is also ambiguous. CubeFarm pauses the ordered outbox: review Telegram, then **Retry (may duplicate)** or **Skip uncertain delivery** in the WebUI. Skipping is an explicit choice to abandon that part. Neither action resubmits any work to Joi. Exactly-once Telegram delivery is not promised.

Transport bookkeeping is bounded: 1000 pending parts (at most 4000 UTF-16 units each), 200 proposal card IDs, one persisted inbound offset and one pairing. At capacity, the pending prefix is retained; a visible storage-filled error stops mirroring new activity. Telegram input is refused before CEO acceptance near that limit. Further office activity remains in the WebUI and may not be mirrored; this is a visible gap requiring revocation/re-pairing to resume from new activity. Drain/review existing pending parts before doing so. WebUI messaging is never blocked by transport capacity.

Manager acceptance atomically persists the canonical message, its origin/Telegram update identity, inbound offset, pending CEO work and any outbound mirror in the same temp-file/rename state transition before acknowledging the command. Pending input survives restart and joins the existing CEO queue. A busy CEO receives input in its existing session. The CLI has no transactional acknowledgment: a crash during injection leaves an uncertain submission, recorded as a shared office notice on restart with the text to review before manually resending. It is never silently treated as completed or automatically injected twice. Ordinary active CEO job recovery keeps its existing semantics.

## Demo and verification

Demo mode always uses a fake Telegram transport, ignoring ambient bot credentials. In Phone → Chat → Telegram, pair with `/start CODE` in the demo input (identity 12345), then confirm locally. The simulator supports ordinary manager text, `/reply TEXT`, `/notice TEXT`, `/proposal`, `approve:REQUEST_ID`, `reject:REQUEST_ID`, `/offline`, `/online`, and `/uncertain`. The last fake sent messages and proposal callbacks appear in the panel. No Telegram, GitHub or paid session is used.

The automated boundary is the office orchestrator with fake transport and fake sessions, plus demo browser checks. A real bot/account smoke check is separate acceptance, to be performed only if explicitly requested and configured by the manager.
