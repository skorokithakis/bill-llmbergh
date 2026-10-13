import type { Context } from "@earendil-works/chord";
import { defineDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";

const TELEGRAM_API = "https://api.telegram.org";
// Telegram rejects any message longer than this, so long outputs are split into several messages.
const MAX_MESSAGE_LENGTH = 4096;
// getUpdates holds the connection open for this many seconds when there is nothing to deliver.
const LONG_POLL_SECONDS = 30;
// A transport error must not kill the long-lived poller, so a failed request is retried after this pause.
const RETRY_DELAY_MS = 3000;
// A request gets the long poll's own time plus this, so a stalled connection fails instead of hanging.
const REQUEST_MARGIN_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;

/** A Telegram update, reduced to the one field the supervisor reads. */
export type TelegramUpdate = {
	readonly update_id: number;
	readonly message?: {
		readonly chat: { readonly id: number };
		readonly from?: { readonly id: number };
		readonly text?: string;
	};
};

type TelegramResponse<T> = {
	readonly ok: boolean;
	readonly result?: T;
	readonly description?: string;
};

/** A non-ok Telegram response, carrying the HTTP status so the poll loop can tell transient from fatal. */
class TelegramError extends Error {
	readonly status: number;

	constructor(method: string, status: number, description: string) {
		super(`Telegram ${method} failed: ${description}`);
		this.status = status;
	}
}

type TelegramClient = {
	readonly botToken: string;
	readonly ownerUserId: number;
	readonly fetch: typeof fetch;
};

// The stop switch and the getUpdates offset are supervisor state that has to survive a restart, so they
// live in a Durable document on the root conversation rather than a file. AGENTS.md keeps all our state
// in the one SQLite store, and a document commits atomically with the transcript instead of getting out
// of step with it. The heartbeat reads `stopped` from here, which is why /stop also stops heartbeats.
const ControlDoc = defineDoc<{ stopped: boolean; telegramOffset: number }>({
	kind: "app.control",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ stopped: false, telegramOffset: 0 }),
});

// Configured once by startTelegram and read by sendToOwner from any supervisor tool. That function's
// required one-argument signature is why the bot identity is module state rather than a parameter.
let client: TelegramClient | undefined;

export type TelegramOptions = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly botToken: string;
	readonly ownerUserId: number;
	readonly context: Context;
	/** Overridable so the poll loop can be driven by a stub instead of the real Telegram API. */
	readonly fetch?: typeof fetch;
};

/**
 * Start owner-only long polling. Calls `getMe` first so a bad token fails startup instead of retrying
 * forever, then returns a function that stops the loop and joins the request in flight, so a graceful
 * shutdown does not have to wait for a long poll to time out.
 */
export async function startTelegram(options: TelegramOptions): Promise<() => Promise<void>> {
	const telegram: TelegramClient = {
		botToken: options.botToken,
		ownerUserId: options.ownerUserId,
		fetch: options.fetch ?? fetch,
	};
	client = telegram;
	// No catch: an invalid token must fail the process at startup, not become a retry loop.
	await callTelegram(telegram, "getMe", {}, SEND_TIMEOUT_MS);

	let stopping = false;
	let inFlight: AbortController | undefined;

	const loop = async (): Promise<void> => {
		let offset =
			(await options.harness.snapshot(ControlDoc, options.root.id, options.context))?.telegramOffset ?? 0;

		while (!stopping) {
			inFlight = new AbortController();
			let updates: TelegramUpdate[];
			try {
				updates = await getUpdates(telegram, offset, inFlight.signal);
			} catch (error) {
				// Leaving on stop is the stop function's own abort. Otherwise retry only a rejected fetch (a
				// network or timeout error) or a transient Telegram status; anything else is a real failure.
				if (stopping) return;
				if (!isRetryable(error)) throw error;
				console.error("telegram getUpdates failed:", error);
				await delay(RETRY_DELAY_MS);
				continue;
			} finally {
				inFlight = undefined;
			}
			for (const update of updates) {
				offset = update.update_id + 1;
				await handleUpdate(telegram, options, update);
			}
			// Telegram stops returning an update only once the next offset is acknowledged, and the offset
			// is persisted so a restart does not replay and re-answer messages. The request id protects the
			// window between processing and this commit, where a crash would replay an update.
			if (updates.length > 0) await setOffset(options.root, offset, options.context);
		}
	};

	// The poller keeps running for the life of the process. A rejection here is a fatal failure (a storage
	// or conversation error, not a network one, which is retried), and `harness.closed` reports it too, so
	// it is deliberately not swallowed.
	const loopDone = loop();

	return async () => {
		stopping = true;
		inFlight?.abort();
		// Wait for the iteration in flight, so shutdown does not close the harness underneath a submission.
		await loopDone;
	};
}

/** Send a message to the owner's private chat. Used by /status and by later tickets (the cost cap). */
export async function sendToOwner(text: string): Promise<void> {
	if (client === undefined) throw new Error("sendToOwner was called before startTelegram configured the bot");
	for (const part of splitForTelegram(text)) await sendMessage(client, part);
}

/** Whether /stop has been issued and /resume has not yet cleared it. */
export async function isStopped(harness: Harness, root: Conversation, context: Context): Promise<boolean> {
	return (await harness.snapshot(ControlDoc, root.id, context))?.stopped ?? false;
}

/**
 * The kill switch: set the flag the heartbeat and the poller obey, then abort all live work, including
 * background work, so a running worker stops too.
 */
export async function stopSupervisor(root: Conversation, context: Context): Promise<void> {
	await setStopped(root, true, context);
	await root.abort(context, { background: true });
}

export async function resumeSupervisor(root: Conversation, context: Context): Promise<void> {
	await setStopped(root, false, context);
}

async function setStopped(root: Conversation, stopped: boolean, context: Context): Promise<void> {
	await root.commit(async (tx) => {
		(await tx.doc(ControlDoc, root.id)).stopped = stopped;
	}, context);
}

async function setOffset(root: Conversation, offset: number, context: Context): Promise<void> {
	await root.commit(async (tx) => {
		(await tx.doc(ControlDoc, root.id)).telegramOffset = offset;
	}, context);
}

/**
 * The owner's message text from one update, or undefined for every other update. A message is accepted
 * only when it is the owner talking to the bot in their private chat: both the sender id and the chat id
 * must equal the configured owner. A group, another user, an edit, or a channel post is dropped silently.
 */
export function parseOwnerUpdate(update: TelegramUpdate, ownerUserId: number): string | undefined {
	const message = update.message;
	if (message === undefined) return undefined;
	if (message.from?.id !== ownerUserId) return undefined;
	if (message.chat.id !== ownerUserId) return undefined;
	if (message.text === undefined) return undefined;
	return message.text;
}

/**
 * The command name of a command message, lowercased, or undefined for plain text. Handles the
 * `/name@botusername` form Telegram sends in groups; the owner's private chat never needs it.
 */
export function commandOf(text: string): string | undefined {
	const match = /^\/([a-z][a-z0-9_]*)(?:@\w+)?(?:\s|$)/i.exec(text.trim());
	return match === null ? undefined : `/${match[1].toLowerCase()}`;
}

/**
 * Split a message into parts Telegram accepts. It never cuts a surrogate pair in half, because Telegram
 * rejects invalid UTF-16 and an emoji straddling the boundary would otherwise truncate the message.
 */
export function splitForTelegram(text: string, limit: number = MAX_MESSAGE_LENGTH): string[] {
	const parts: string[] = [];
	for (let start = 0; start < text.length; ) {
		let end = Math.min(start + limit, text.length);
		if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
		parts.push(text.slice(start, end));
		start = end;
	}
	return parts;
}

async function handleUpdate(
	telegram: TelegramClient,
	options: TelegramOptions,
	update: TelegramUpdate,
): Promise<void> {
	const text = parseOwnerUpdate(update, telegram.ownerUserId);
	if (text === undefined) return;

	const command = commandOf(text);
	if (command === "/stop") {
		await stopSupervisor(options.root, options.context);
		await sendToOwner("Stopped. Send /resume to start again.");
		return;
	}
	if (command === "/resume") {
		await resumeSupervisor(options.root, options.context);
		await sendToOwner("Resumed.");
		return;
	}
	if (command === "/status") {
		await sendToOwner(await statusText(options.harness, options.context));
		return;
	}
	// The commands still work while stopped; a plain message does not, so that /stop really means stop.
	if (await isStopped(options.harness, options.root, options.context)) {
		await sendToOwner("Stopped; send /resume to start again.");
		return;
	}
	await options.root.submit(
		{
			type: "input",
			content: `Message from the owner via Telegram:\n\n${text}`,
			requestId: `tg:${update.update_id}`,
		},
		options.context,
	);
}

async function statusText(harness: Harness, context: Context): Promise<string> {
	// A worker is a conversation owned by a task, so counting owned conversations counts the workers. The
	// workers ticket replaces this with the worker registry and its ids and roles.
	const graph = await harness.taskGraph(context);
	let workers = 0;
	for (const node of Object.values(graph.value.tasks)) workers += node.conversations.length;
	graph.dispose();

	const usage = await harness.usage(context);
	let cost = 0;
	for (const bucket of Object.values(usage.models)) cost += bucket.cost.total;
	for (const bucket of Object.values(usage.tools)) cost += bucket.cost.total;

	// Advisor calls are counted by the caps ticket, which owns the counters document; until then it is 0.
	return `Workers running: ${workers}\nCost so far: $${cost.toFixed(4)}\nAdvisor calls today: 0`;
}

async function getUpdates(
	telegram: TelegramClient,
	offset: number,
	signal: AbortSignal,
): Promise<TelegramUpdate[]> {
	return await callTelegram<TelegramUpdate[]>(
		telegram,
		"getUpdates",
		{ offset, timeout: LONG_POLL_SECONDS, allowed_updates: ["message"] },
		LONG_POLL_SECONDS * 1000 + REQUEST_MARGIN_MS,
		signal,
	);
}

async function sendMessage(telegram: TelegramClient, text: string): Promise<void> {
	await callTelegram(telegram, "sendMessage", { chat_id: telegram.ownerUserId, text }, SEND_TIMEOUT_MS);
}

async function callTelegram<T>(
	telegram: TelegramClient,
	method: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const response = await telegram.fetch(`${TELEGRAM_API}/bot${telegram.botToken}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
	});
	const payload = (await response.json()) as TelegramResponse<T>;
	if (!payload.ok) {
		throw new TelegramError(method, response.status, payload.description ?? String(response.status));
	}
	return payload.result as T;
}

// A rejected fetch (a network error or the request timeout) is retryable; so are Telegram's own 429 and
// 5xx statuses. Every other non-ok response, such as 401 for a bad token, is fatal.
function isRetryable(error: unknown): boolean {
	if (!(error instanceof TelegramError)) return true;
	return error.status === 429 || error.status >= 500;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
