import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineTool,
	ROOT_CONVERSATION_ID,
	type Conversation,
	type Harness,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

// The founder's one-shot wake-ups: runs the harness starts on its own at a time the founder chose. They live in a
// document on the root conversation, so the schedule survives a restart in the same SQLite file that resumes
// everything else, and the tick in heartbeat.ts fires them. The founder schedules one when the next useful thing
// cannot happen yet, which keeps it from burning paid runs on polling.
export type Wakeup = {
	/** When the wake-up is due, as an ISO 8601 string. */
	dueAt: string;
	/** What the founder wants to do when it runs; it is delivered back verbatim. */
	note: string;
	createdAt: string;
};

export const WakeupsDoc = defineDoc<{ wakeups: Record<string, Wakeup> }>({
	kind: "app.wakeups",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ wakeups: {} }),
});

// The documents belong to the root conversation, and the tools and the tick must address it directly rather than
// trust the calling conversation to be the root.
const ROOT = ROOT_CONVERSATION_ID;

/** The founder-only tools that schedule, list, and cancel one-shot wake-ups. */
export function createWakeupTools(): readonly ToolRegistration[] {
	return [
		defineTool({
			name: "schedule_wakeup",
			description:
				"Schedule a one-shot wake-up: after delay_minutes the harness starts a run of yours with your note as the instruction. Use it when the next useful thing cannot happen until a known later time (a deploy to check, a reply to wait for, metrics to read tomorrow), give the note everything you will need then, and end the turn instead of waiting. Do not use it to poll or busy-wait; check once at the time it matters.",
			parameters: Type.Object({
				delay_minutes: Type.Number({
					description: "How many minutes from now the wake-up is due. Must be positive; there is no upper limit.",
				}),
				note: Type.String({
					description: "What to do when the wake-up fires. It is delivered back to you as the start of the run.",
				}),
			}),
			execute: async (args, api, context) => {
				const delayMs = args.delay_minutes * 60_000;
				if (!(args.delay_minutes > 0) || !Number.isFinite(delayMs)) {
					return errorResult("delay_minutes must be a positive, finite number of minutes.");
				}
				// The id is unique for the life of the conversation: the wake-up's requestId is derived from it, and
				// Durable treats a requestId it has seen before as the same submission rather than a new one.
				const id = randomUUID();
				const now = Date.now();
				const dueAt = new Date(now + delayMs).toISOString();
				await api.commit(async (tx) => {
					const state = await tx.doc(WakeupsDoc, ROOT);
					state.wakeups[id] = { dueAt, note: args.note, createdAt: new Date(now).toISOString() };
				}, context);
				return textResult(`Scheduled wake-up ${id} for ${dueAt}.`);
			},
		}),
		defineTool({
			name: "list_wakeups",
			description: "List the pending wake-ups with their id, due time, and note.",
			parameters: Type.Object({}),
			execute: async (_args, api, context) => {
				const state = await api.snapshot(WakeupsDoc, ROOT, context);
				const entries = Object.entries(state?.wakeups ?? {}).sort(([, a], [, b]) => a.dueAt.localeCompare(b.dueAt));
				if (entries.length === 0) return textResult("No wake-ups are scheduled.");
				return textResult(entries.map(([id, wakeup]) => `${id} due ${wakeup.dueAt}: ${wakeup.note}`).join("\n"));
			},
		}),
		defineTool({
			name: "cancel_wakeup",
			description: "Cancel a scheduled wake-up so it no longer runs.",
			parameters: Type.Object({
				id: Type.String({ description: "The wake-up id from schedule_wakeup or list_wakeups." }),
			}),
			execute: async (args, api, context) => {
				const cancelled = await api.commit(async (tx) => {
					const state = await tx.doc(WakeupsDoc, ROOT);
					if (!Object.hasOwn(state.wakeups, args.id)) return false;
					delete state.wakeups[args.id];
					return true;
				}, context);
				if (!cancelled) return errorResult(`No wake-up with id "${args.id}".`);
				return textResult(`Cancelled wake-up ${args.id}.`);
			},
		}),
	];
}

/**
 * Deliver every wake-up that is due, then drop it from the document. Called by the heartbeat tick after the
 * `/stop` check, so wake-ups do not fire while stopped and fire once after `/resume`.
 *
 * The input is submitted before the entry is removed: the requestId `wakeup:<id>` is idempotent, so a crash between
 * the two steps delivers the wake-up once and the next tick removes it.
 */
export async function fireDueWakeups(harness: Harness, root: Conversation, context: Context): Promise<void> {
	const now = Date.now();
	const state = await harness.snapshot(WakeupsDoc, ROOT, context);
	const due = Object.entries(state?.wakeups ?? {}).filter(([, wakeup]) => Date.parse(wakeup.dueAt) <= now);
	if (due.length === 0) return;
	for (const [id, wakeup] of due) {
		await root.submit(
			{ type: "input", content: `Scheduled wake-up (set by you): ${wakeup.note}`, requestId: `wakeup:${id}` },
			context,
		);
	}
	await root.commit(async (tx) => {
		const wakeups = await tx.doc(WakeupsDoc, ROOT);
		for (const [id] of due) delete wakeups.wakeups[id];
	}, context);
}

function textResult(text: string): { output: Array<{ type: "text"; text: string }> } {
	return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: Array<{ type: "text"; text: string }>; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
