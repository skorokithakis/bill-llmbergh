import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	ROOT_CONVERSATION_ID,
	UsageDoc,
	type Conversation,
	type ConversationId,
	type Cursor,
	type Extension,
	type Harness,
	type ModelRef,
	type ToolExecutionApi,
	type ToolRegistration,
	type UsageState,
} from "@earendil-works/pi-durable";
import type { Secrets } from "./config.ts";
import { isStopped, sendToOwner, stopSupervisor } from "./telegram.ts";
import { WorkersDoc } from "./workers.ts";

// The expensive and dangerous tools, each with its guard: the two subscription-backed advisors, the payment
// card, and the daily counters that cap both the advisor calls and the total spend. The counters live in one
// document on the root conversation so a restart reads the same day's spend and call count from the same
// SQLite file that resumes everything else.
export type Counters = {
	/** UTC day, `YYYY-MM-DD`, that `costAtDayStart` and `advisorCalls` are counted for. */
	day: string;
	/** Session cost at the start of `day`; today's spend is the current total minus this. */
	costAtDayStart: number;
	advisorCalls: number;
};

export const CountersDoc = defineDoc<Counters>({
	kind: "app.counters",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	// `day` starts empty so the first read rolls the counters and captures the session total then, rather than
	// treating a document created mid-day as the start of the day (which would credit the whole total to today).
	initial: () => ({ day: "", costAtDayStart: 0, advisorCalls: 0 }),
});

export type AdvisorName = "anthropic" | "openai";

export type MoneyOptions = {
	readonly advisorModels: Record<AdvisorName, ModelRef>;
	readonly advisorCallsPerDay: number;
};

// The advisors are asked once each time, with no history and no tools, so the prompt has to carry everything:
// who it is advising, that the answer is used once, and that brevity is part of the job.
const ADVISOR_SYSTEM_PROMPT = `You are a senior advisor to the founder of a small company. The founder is an AI agent whose single goal is to make the company money ethically: no stealing, cheating, spamming, deception, or impersonation, and it obeys the law and the terms of service of every platform it uses.

You receive one question and answer it once. You have no tools, no memory of earlier advice, and no access to the founder's conversations or data, so work only from what the question tells you. Be strategic and concrete: give a clear recommendation with the reasoning that matters, name the main risks, and leave out filler. Be brief, a few short paragraphs at most.`;

/** The advisor and card tools. Ask_advisor is founder-only; the card extension is separate (see below). */
export function createMoneyTools(options: MoneyOptions): readonly ToolRegistration[] {
	return [createAskAdvisorTool(options)];
}

function createAskAdvisorTool(options: MoneyOptions): ToolRegistration {
	return defineTool({
		name: "ask_advisor",
		description:
			"Ask one of two senior advisors a single question. They are expensive and limited to a few calls a day, and they have no tools, memory, or access to your work, so put every fact the advisor needs into the question. The answer, and the tokens it cost, come back in the result.",
		parameters: Type.Object({
			advisor: Type.Union([Type.Literal("anthropic"), Type.Literal("openai")], {
				description: "Which advisor to ask. Both are senior and expensive; use the one whose strength fits the question.",
			}),
			question: Type.String({
				description: "The full question, including all the context the advisor needs. It cannot ask you for more.",
			}),
		}),
		execute: async (args, api, context) => {
			const allowed = await takeAdvisorCall(api, options.advisorCallsPerDay, context);
			if (!allowed) {
				return errorResult(
					`The daily limit of ${options.advisorCallsPerDay} advisor calls is reached. Continue without an advisor until tomorrow.`,
				);
			}
			const ref = options.advisorModels[args.advisor];
			const model = api.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) {
				return errorResult(`No model ${ref.provider}/${ref.modelId} is configured for the ${args.advisor} advisor.`);
			}
			const answer = await api.models.completeSimple(model, {
				systemPrompt: ADVISOR_SYSTEM_PROMPT,
				messages: [{ role: "user", content: args.question, timestamp: Date.now() }],
			});
			const text = assistantText(answer);
			// The usage rides on the result so it reaches pi.usage and the daily cost cap, exactly as a model
			// call in the conversation would.
			if (answer.stopReason === "error") {
				return {
					output: [{ type: "text", text: `The ${args.advisor} advisor call failed: ${text === "" ? "no answer" : text}` }],
					isError: true,
					usage: answer.usage,
				};
			}
			return { output: [{ type: "text", text: `Advice from the ${args.advisor} advisor:\n\n${text}` }], usage: answer.usage };
		},
	});
}

/**
 * Reserve one advisor call, rolling the counters onto today first. A call is counted before the model is
 * asked, so a failed call still uses its slot and two callers cannot both take the last one.
 */
async function takeAdvisorCall(api: ToolExecutionApi, maxPerDay: number, context: Context): Promise<boolean> {
	const today = utcDay(Date.now());
	// Only a rollover needs the session total, and a tool cannot reach the Harness, so the total is recomputed
	// from the same documents harness.usage() sums. On the common path the day already matches and it is skipped.
	const current = await api.snapshot(CountersDoc, ROOT_CONVERSATION_ID, context);
	const rolloverCost = current?.day === today ? 0 : await sessionCostFromTool(api, context);
	return await api.commit(async (tx) => {
		const counters = await tx.doc(CountersDoc, ROOT_CONVERSATION_ID);
		rollToToday(counters, today, rolloverCost);
		if (counters.advisorCalls >= maxPerDay) return false;
		counters.advisorCalls += 1;
		return true;
	}, context);
}

// The card extension is installed for everyone (so the founder gets it) but is added to a worker's extensions
// only when its role sets tools.payment_card, so the tool is not offered to a worker that may not use it.
export function createPaymentCardExtension(card: Secrets["card"]): Extension {
	return defineExtension({
		name: "payment-card",
		tools: [
			defineTool({
				name: "get_payment_card",
				description:
					"Return the company payment card's number, expiry, CVC, and name. Every read is reported to the owner, so use it only when a real payment is being made.",
				parameters: Type.Object({}),
				// Reading the card is an external effect (the owner is notified), so an interrupted call must not
				// silently rerun and read it twice.
				execute: async (_args, api, context) => {
					await sendToOwner(`Card details were read by ${await callerLabel(api, context)}.`);
					return { output: [{ type: "text", text: cardText(card) }] };
				},
			}),
		],
	});
}

// Worker conversations do not select the supervisor extension, so the caller is identified from the
// conversation: the root is the founder, anything with a worker record is that worker.
async function callerLabel(api: ToolExecutionApi, context: Context): Promise<string> {
	if (api.conversationId === ROOT_CONVERSATION_ID) return "the founder";
	const state = await api.snapshot(WorkersDoc, ROOT_CONVERSATION_ID, context);
	for (const [id, worker] of Object.entries(state?.workers ?? {})) {
		if (worker.conversationId === api.conversationId) return `worker ${id} (role ${worker.role})`;
	}
	return `an unidentified conversation (${api.conversationId})`;
}

function cardText(card: Secrets["card"]): string {
	return `Card details:\n- number: ${card.number}\n- expiry: ${card.expiry}\n- cvc: ${card.cvc}\n- name: ${card.name}`;
}

/** Roll the counters onto today if they are still on an earlier day, capturing the session cost so far. */
function rollToToday(counters: Counters, today: string, totalCost: number): void {
	if (counters.day === today) return;
	counters.day = today;
	counters.costAtDayStart = totalCost;
	counters.advisorCalls = 0;
}

/**
 * Today's counters, rolled onto the current UTC day first. Called by the cost cap and by /status, both of
 * which can read harness.usage() directly.
 */
export async function rollCounters(harness: Harness, root: Conversation, context: Context): Promise<Counters> {
	const today = utcDay(Date.now());
	const current = await harness.snapshot(CountersDoc, ROOT_CONVERSATION_ID, context);
	if (current !== undefined && current.day === today) return current;
	const total = await sessionCost(harness, context);
	return await root.commit(async (tx) => {
		const counters = await tx.doc(CountersDoc, ROOT_CONVERSATION_ID);
		rollToToday(counters, today, total);
		return { day: counters.day, costAtDayStart: counters.costAtDayStart, advisorCalls: counters.advisorCalls };
	}, context);
}

export async function advisorCallsToday(harness: Harness, root: Conversation, context: Context): Promise<number> {
	return (await rollCounters(harness, root, context)).advisorCalls;
}

export async function costToday(harness: Harness, root: Conversation, context: Context): Promise<number> {
	const counters = await rollCounters(harness, root, context);
	return (await sessionCost(harness, context)) - counters.costAtDayStart;
}

/** The session total every conversation has spent, which is what `harness.usage()` sums. */
export async function sessionCost(harness: Harness, context: Context): Promise<number> {
	return usageCost(await harness.usage(context));
}

export type CostCapOptions = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly capUsd: number;
	readonly context: Context;
	/** Overridable so the check can be driven quickly in a test; production uses one minute. */
	readonly intervalMs?: number;
};

/**
 * Stop all work and tell the owner once today's spend passes the cap. `/resume` clears the stop flag, and if
 * the spend is still over the cap the next check stops it again, which is the intended behaviour.
 */
export async function startCostCap(options: CostCapOptions): Promise<() => Promise<void>> {
	let inFlight: Promise<void> | undefined;
	const check = async (): Promise<void> => {
		if (await isStopped(options.harness, options.root, options.context)) return;
		const counters = await rollCounters(options.harness, options.root, options.context);
		const spent = (await sessionCost(options.harness, options.context)) - counters.costAtDayStart;
		if (spent <= options.capUsd) return;
		await stopSupervisor(options.root, options.context);
		await sendToOwner(
			`Daily cost cap reached: the company has spent $${spent.toFixed(2)} today, over the $${options.capUsd.toFixed(2)} cap. All work is stopped. Send /resume to continue, or raise the cap in config.json.`,
		);
	};
	const timer = setInterval(() => {
		inFlight = check();
	}, options.intervalMs ?? 60_000);
	return async () => {
		clearInterval(timer);
		// Let a check that fired just before the stop finish before the harness closes underneath it.
		await inFlight;
	};
}

// A tool has no Harness handle, so it recomputes the session total from the same per-conversation pi.usage
// documents. The scan lists the conversations; the snapshots read them without creating empty documents.
async function sessionCostFromTool(api: ToolExecutionApi, context: Context): Promise<number> {
	const ids = await api.commit(async (tx) => {
		const found: ConversationId[] = [];
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await tx.scanConversations({}, SCAN_PAGE_SIZE, cursor);
			for (const record of page.items) found.push(record.id);
			if (page.next === undefined) return found;
			cursor = page.next;
		}
	}, context);
	let total = 0;
	for (const id of ids) {
		const usage = await api.snapshot(UsageDoc, id, context);
		if (usage !== undefined) total += usageCost(usage);
	}
	return total;
}

function usageCost(state: Readonly<UsageState>): number {
	let total = 0;
	for (const bucket of Object.values(state.models)) total += bucket.cost.total;
	for (const bucket of Object.values(state.tools)) total += bucket.cost.total;
	return total;
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function utcDay(milliseconds: number): string {
	return new Date(milliseconds).toISOString().slice(0, 10);
}

// One extra page beyond a realistic number of conversations is enough; a deployment has one per worker.
const SCAN_PAGE_SIZE = 256;

function errorResult(text: string): { output: Array<{ type: "text"; text: string }>; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
