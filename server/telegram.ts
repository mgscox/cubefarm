// Telegram mirrors the phone: one authorized private chat, a durable ordered outbox, no assistant of its own.
import crypto from 'node:crypto';
import type { HireRequestView, PhoneMessage, TelegramView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat: { id: number; type: string }; text?: string };
  callback_query?: { id: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type: string } }; data?: string };
}
export interface TelegramTransport {
  /** A non-secret bot identity fingerprint; changing bots revokes the old recipient and backlog. */
  identity: string;
  call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  preview?(): NonNullable<TelegramView['demo']>;
}
interface Delivery {
  text: string;
  phoneId?: number;
  part?: number;
  requestId?: string;
  messageId?: number; // edit a proposal already sent
  status: 'pending' | 'sending' | 'uncertain';
}
export interface TelegramState {
  bot: string;
  offset: number;
  paired: { userId: number; chatId: number } | null;
  outbox: Delivery[];
  proposals: Record<string, number>;
  gap: boolean;
}
export const emptyTelegram = (): TelegramState => ({ bot: '', offset: 0, paired: null, outbox: [], proposals: {}, gap: false });
export const TELEGRAM_PENDING_LIMIT = 1000;

/** Conservative UTF-16 limit, never splitting a surrogate pair. Telegram accepts 4096 characters. */
export function telegramParts(text: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const ch of text) {
    if (part.length + ch.length > 4000) { parts.push(part); part = ''; }
    part += ch;
  }
  if (part) parts.push(part);
  return parts;
}

export class TelegramFailure extends Error {
  constructor(public kind: 'retry' | 'uncertain' | 'fatal', message: string, public retryAfter = 2) { super(message); }
}

/** The bot token: the server's environment wins over the manager's config file. */
export function telegramToken(env: NodeJS.ProcessEnv, config: NodeJS.Dict<string>): string | null {
  return env.CUBEFARM_TELEGRAM_TOKEN || config.CUBEFARM_TELEGRAM_TOKEN || null;
}

/** Only fixed errors escape this seam: fetch errors and Bot API descriptions can contain credentials. */
export function telegramTransport(token: string): TelegramTransport {
  return {
    identity: crypto.createHash('sha256').update(token).digest('hex'),
    async call(method, body, signal) {
      let response: Response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 20_000)]),
        });
      } catch {
        throw new TelegramFailure(method === 'sendMessage' ? 'uncertain' : 'retry', 'Telegram request interrupted. Check connectivity.');
      }
      let data: { ok?: boolean; result?: unknown; error_code?: number; parameters?: { retry_after?: number } };
      try { data = await response.json() as typeof data; }
      catch { throw new TelegramFailure(method === 'sendMessage' ? 'uncertain' : 'retry', 'Telegram returned an unreadable response.'); }
      if (data.ok) return data.result;
      const code = data.error_code ?? response.status;
      if (code === 429) throw new TelegramFailure('retry', 'Telegram rate limit; waiting before retry.', Math.min(300, Math.max(1, data.parameters?.retry_after ?? 5)));
      if (code === 409) throw new TelegramFailure('fatal', 'Telegram polling conflict: remove the webhook or stop the other bot consumer, then restart CubeFarm.');
      if (code >= 500) throw new TelegramFailure(method === 'sendMessage' ? 'uncertain' : 'retry', 'Telegram service unavailable.');
      throw new TelegramFailure('fatal', 'Telegram rejected the request. Check the local bot token and private chat access, then restart.');
    },
  };
}

interface Commands {
  state(): TelegramState;
  commit(): Promise<void>;
  emit(view: TelegramView): void;
  recover(): Promise<void>;
  /** The callback advances the update offset in the same persisted transition as the message and CEO work. */
  manager(text: string, source: NonNullable<PhoneMessage['telegram']>, accepted: () => void): Promise<void>;
  decide(id: string, approve: boolean): void;
  request(id: string): HireRequestView | undefined;
  ceoName(): string;
}

export class TelegramMirror {
  private pairing: TelegramView['pairing'] = null;
  private health: TelegramView['state'] = 'unpaired';
  private detail = '';
  private abort = new AbortController();
  private polling: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private updates: Promise<void> = Promise.resolve();
  private retryAt = 0;
  private failures = 0;
  private deliveryFailures = 0;
  private pollFatal = '';
  private capacityNoticeAt = 0;
  private deliveryError: { state: 'reconnecting' | 'error'; detail: string } | null = null;
  private deliveryUnrecorded = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private transport: TelegramTransport | null, private commands: Commands) {}
  view(): TelegramView {
    const s = this.commands.state();
    const uncertain = s.outbox.some((d) => d.status === 'uncertain');
    return {
      configured: !!this.transport, state: !this.transport ? 'unconfigured' : s.gap || uncertain || this.pollFatal ? 'error' : this.deliveryError?.state ?? this.health,
      detail: this.pollFatal || (s.gap ? 'Mirror storage filled. New activity is available in the WebUI. Revoke and pair again to resume from now.'
        : uncertain ? 'Delivery uncertain. Review Telegram, then retry (may duplicate) or skip the first pending part.' : this.deliveryError?.detail ?? this.detail),
      paired: s.paired ? { ...s.paired } : null,
      pairing: this.pairing && this.pairing.expiresAt > Date.now() ? structuredClone(this.pairing) : null,
      pending: s.outbox.length, uncertain,
      ...(this.transport?.preview ? { demo: this.transport.preview() } : {}),
    };
  }
  private emit() { this.commands.emit(this.view()); }
  async start() {
    const s = this.commands.state();
    if (!this.transport) { this.emit(); return; }
    if (s.bot !== this.transport.identity) Object.assign(s, emptyTelegram(), { bot: this.transport.identity });
    for (const d of s.outbox) if (d.status === 'sending') d.status = 'uncertain';
    await this.commands.commit();
    this.health = s.paired ? 'connected' : 'unpaired';
    this.emit();
    this.timer = setInterval(() => { void this.flush(); this.emit(); }, 2000);
    // The demo is driven explicitly; it never polls a real service, regardless of ambient credentials.
    if (!this.transport.preview) this.polling = this.poll();
    void this.flush();
  }
  async stop() {
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.polling, this.flushing, this.updates]);
  }
  private authorize(userId?: number, chat?: { id: number; type: string }) {
    const p = this.commands.state().paired;
    return !!p && chat?.type === 'private' && p.userId === userId && p.chatId === chat.id;
  }
  async command(action: string, body: Record<string, unknown> = {}) {
    const s = this.commands.state();
    if (!this.transport) throw new HttpError(409, 'Put CUBEFARM_TELEGRAM_TOKEN in ~/.config/cubefarm/.env (or the server environment) and restart the server.');
    if (action === 'pair') {
      this.pairing = { code: crypto.randomBytes(8).toString('hex'), expiresAt: Date.now() + 5 * 60_000, candidate: null };
    } else if (action === 'confirm') {
      const p = this.pairing;
      if (!p || p.expiresAt <= Date.now() || !p.candidate || p.candidate.userId !== body.userId || p.candidate.chatId !== body.chatId) throw new HttpError(409, 'Pairing expired or the requesting identity changed. Generate a new code.');
      // A new authorization always starts at new activity; never inherit another recipient's deliveries.
      s.paired = p.candidate;
      s.outbox = [];
      s.proposals = {};
      s.gap = false;
      this.pairing = null;
      this.health = 'connected';
      this.detail = '';
      this.retryAt = 0; this.deliveryFailures = 0; this.deliveryError = null;
    } else if (action === 'revoke') {
      s.paired = null; s.outbox = []; s.proposals = {}; s.gap = false;
      this.pairing = null; this.health = 'unpaired'; this.detail = '';
      this.retryAt = 0; this.deliveryFailures = 0; this.deliveryError = null;
    } else if (action === 'retry' || action === 'skip') {
      if (s.outbox[0]?.status !== 'uncertain') throw new HttpError(409, 'There is no uncertain delivery to resolve.');
      if (action === 'skip') s.outbox.shift();
      else s.outbox[0].status = 'pending';
      this.retryAt = 0; this.deliveryError = null;
    } else throw new HttpError(400, 'Unknown Telegram command');
    await this.commands.commit();
    this.emit();
    void this.flush();
    return this.view();
  }
  /** Called synchronously alongside canonical phone mutation, before that state is committed. */
  message(message: PhoneMessage) {
    if (!this.commands.state().paired || message.origin === 'telegram') return;
    const req = message.from === 'ceo' && message.requestId ? this.commands.request(message.requestId) : undefined;
    const text = `${message.from === 'manager' ? 'Manager (WebUI)' : message.from === 'ceo' ? this.commands.ceoName() : 'Office'}: ${message.text}${req ? `\nProposal: ${req.kind} · ${req.name} · ${req.title}\n${req.status}` : ''}`;
    const parts = telegramParts(text);
    if (this.commands.state().outbox.length + parts.length > TELEGRAM_PENDING_LIMIT) { this.commands.state().gap = true; this.emit(); return; }
    for (const [i, part] of parts.entries()) this.enqueue({ text: part, phoneId: message.id, part: i, ...(i === 0 && req ? { requestId: req.id } : {}), status: 'pending' });
    this.emit();
  }
  proposal(req: HireRequestView) {
    const s = this.commands.state();
    if (!s.paired) return;
    // Edit the original card (or the queued card will render the current status when it is sent).
    const messageId = s.proposals[req.id];
    if (messageId) this.enqueue({ text: `Proposal: ${req.kind} · ${req.name} · ${req.title}\n${req.reason}\n${req.status}`, requestId: req.id, messageId, status: 'pending' });
  }
  private enqueue(delivery: Delivery) {
    const s = this.commands.state();
    if (s.gap) return;
    if (s.outbox.length >= TELEGRAM_PENDING_LIMIT) { s.gap = true; this.emit(); return; }
    s.outbox.push(delivery);
  }
  receive(update: TelegramUpdate): Promise<void> {
    const run = this.updates.then(() => this.handle(update));
    this.updates = run.catch(() => undefined);
    return run;
  }
  private async handle(update: TelegramUpdate) {
    const s = this.commands.state();
    if (!Number.isSafeInteger(update.update_id)) return;
    if (update.update_id < s.offset) { await this.commands.recover(); return; }
    const advance = () => { s.offset = update.update_id + 1; };
    const m = update.message;
    const cb = update.callback_query;
    if (m?.chat.type === 'private' && m.from && this.pairing && this.pairing.expiresAt > Date.now() && m.text === `/start ${this.pairing.code}`) {
      // First request holds the candidate until local confirmation or a fresh code.
      this.pairing.candidate ??= { userId: m.from.id, chatId: m.chat.id };
    } else if (m && this.authorize(m.from?.id, m.chat)) {
      let error = '';
      if (!m.text) error = 'Only text messages are supported. Attachments and voice notes do not reach Joi.';
      else if (!m.text.trim() || m.text.trim().length > 4000) error = 'Send between 1 and 4000 characters. Nothing was submitted.';
      else if (s.gap || s.outbox.length >= TELEGRAM_PENDING_LIMIT - 1) error = 'Telegram delivery storage is full. Use the WebUI; nothing was submitted.';
      else {
        try {
          const pairing = s.paired;
          await this.commands.manager(m.text, { updateId: update.update_id, chatId: m.chat.id, messageId: m.message_id }, () => {
            if (s.paired !== pairing) throw new HttpError(403, 'Pairing changed before this request was accepted. Nothing was submitted.');
            advance();
          });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          error = err.message;
        }
      }
      if (error) {
        if (s.gap || s.outbox.length >= TELEGRAM_PENDING_LIMIT) {
          // Control notices need no CEO acceptance/outbox slot. Throttle them; never retry them blindly.
          if (s.paired && Date.now() >= this.capacityNoticeAt) {
            this.capacityNoticeAt = Date.now() + 30_000;
            void this.transport?.call('sendMessage', { chat_id: s.paired.chatId, text: 'Office: Telegram mirror storage is full. Nothing was submitted. Review pending deliveries in the WebUI, then re-pair to resume.' }, this.abort.signal).catch(() => undefined);
          }
        } else this.enqueue({ text: `Office: ${error}`, status: 'pending' });
      }
    } else if (cb && this.authorize(cb.from.id, cb.message?.chat)) {
      const match = /^(approve|reject):([\w-]{1,48})$/.exec(cb.data ?? '');
      // Only cards sent to this pairing may invoke the canonical proposal commands.
      if (match && s.proposals[match[2]] === cb.message?.message_id) {
        try { this.commands.decide(match[2], match[1] === 'approve'); }
        catch (err) {
          if (!(err instanceof HttpError)) throw err;
          this.enqueue({ text: `Office: ${err.message}`, status: 'pending' });
        }
      }
      // Authorization applies to callback answers too. No office information goes to unknown users.
      void this.transport?.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'See the proposal status in this conversation.' }, this.abort.signal).catch(() => undefined);
    }
    advance();
    await this.commands.commit();
    this.emit();
    void this.flush();
  }
  private async poll() {
    while (!this.abort.signal.aborted) {
      try {
        // Never acknowledge an in-memory offset that a failed disk write has not made durable.
        await this.commands.recover();
        const updates = await this.transport!.call('getUpdates', { offset: this.commands.state().offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, this.abort.signal) as TelegramUpdate[];
        for (const update of updates) {
          if (this.abort.signal.aborted) break;
          await this.receive(update);
        }
        this.failures = 0;
        this.health = this.commands.state().paired ? 'connected' : 'unpaired'; this.detail = ''; this.emit();
      } catch (err) {
        if (this.abort.signal.aborted) break;
        const e = err instanceof TelegramFailure ? err : new TelegramFailure('retry', 'Could not persist Telegram progress. Check local storage.');
        this.health = e.kind === 'fatal' ? 'error' : 'reconnecting'; this.detail = e.message; this.emit();
        if (e.kind === 'fatal') { this.pollFatal = e.message; this.emit(); return; }
        await this.delay(Math.max(e.retryAfter, Math.min(60, 2 ** Math.min(++this.failures, 6))) * 1000);
      }
    }
  }
  private delay(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done, { once: true });
      if (this.abort.signal.aborted) done();
    });
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().catch(() => {
      this.deliveryUnrecorded = true;
      this.deliveryError = { state: 'error', detail: 'Could not persist Telegram delivery progress. Check local storage.' }; this.emit();
    }).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async deliver() {
    if (this.deliveryUnrecorded) {
      await this.commands.commit();
      this.deliveryUnrecorded = false; this.deliveryError = null; this.emit();
    }
    const s = this.commands.state();
    while (this.transport && s.paired && !this.pollFatal && !this.abort.signal.aborted && Date.now() >= this.retryAt) {
      const d = s.outbox[0];
      if (!d || d.status !== 'pending') return;
      const recipient = s.paired;
      d.status = 'sending';
      // Write-ahead: a crash in flight becomes uncertain, never a blind resend.
      try { await this.commands.commit(); }
      catch (err) { d.status = 'pending'; throw err; }
      if (s.paired !== recipient || s.outbox[0] !== d) return;
      const req = d.requestId ? this.commands.request(d.requestId) : undefined;
      const keyboard = req?.status === 'pending' ? [[{ text: 'Approve', callback_data: `approve:${req.id}` }, { text: 'Reject', callback_data: `reject:${req.id}` }]] : [];
      try {
        const result = await this.transport.call(d.messageId ? 'editMessageText' : 'sendMessage', {
          chat_id: recipient.chatId, text: req ? d.text.replace(/\n(pending|approved|rejected)$/, `\n${req.status}`) : d.text, ...(d.messageId ? { message_id: d.messageId } : {}),
          reply_markup: { inline_keyboard: keyboard },
        }, this.abort.signal) as { message_id?: number };
        // Revocation/replacement can race an in-flight send; never let it modify the new pairing's queue.
        if (s.paired !== recipient || s.outbox[0] !== d) return;
        if (d.requestId && result.message_id) {
          s.proposals[d.requestId] = result.message_id;
          const ids = Object.keys(s.proposals);
          for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete s.proposals[id];
          // A WebUI decision may have raced this send; refresh the card's buttons/status.
          if (!d.messageId && req && req.status !== 'pending') this.proposal(req);
        }
        s.outbox.shift();
        await this.commands.commit();
        this.deliveryFailures = 0;
        this.deliveryError = null; this.emit();
      } catch (err) {
        if (s.paired !== recipient) return;
        if (s.outbox[0] !== d) throw err;
        const e = err instanceof TelegramFailure ? err : new TelegramFailure('uncertain', 'Telegram delivery result is unknown.');
        d.status = e.kind === 'uncertain' ? 'uncertain' : 'pending';
        this.retryAt = e.kind === 'fatal' ? Infinity : Date.now() + Math.max(e.retryAfter, Math.min(60, 2 ** Math.min(++this.deliveryFailures, 6))) * 1000;
        this.deliveryError = { state: e.kind === 'retry' ? 'reconnecting' : 'error', detail: e.message };
        await this.commands.commit(); this.emit(); return;
      }
    }
  }
}
