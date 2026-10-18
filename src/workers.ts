import { type Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	ROOT_CONVERSATION_ID,
	section,
	type ConversationId,
	type EntryId,
	type Extension,
	type Harness,
	type ModelRef,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { WORKER_PROMPT } from "./prompt.ts";

// A role is what the founder hires: the instructions a worker runs with and the model it uses. `tools.payment_card`
// is carried from the start so the card ticket only has to turn it on, not migrate the document.
export type Role = {
	instructions: string;
	model: string;
	tools: { payment_card: boolean };
};

export type WorkerStatus = "running" | "done" | "failed" | "stopped";

export type WorkerRecord = {
	role: string;
	task: string;
	conversationId: ConversationId;
	status: WorkerStatus;
	result?: string;
	startedAt: number;
	endedAt?: number;
};

// Both documents live on the root conversation, next to the founder's transcript, so a restart reads them from the
// same SQLite file that resumes the workers. `history: "latest"` matches the control document: only the current
// registry matters, and a fork of the root starts empty.
export const RolesDoc = defineDoc<{ roles: Record<string, Role> }>({
	kind: "app.roles",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ roles: {} }),
});

export const WorkersDoc = defineDoc<{ workers: Record<string, WorkerRecord> }>({
	kind: "app.workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workers: {} }),
});

// The root is the only founder conversation, and the worker documents belong to it, so the tools and /status address
// it directly instead of trusting the calling conversation to be the root.
const ROOT = ROOT_CONVERSATION_ID;

// A worker conversation must outlive the founder's turns, and an abort of the root must not reach it, so it is owned
// by a background anchor task that finishes at once, exactly as Durable's 23-subagent-background.ts does.
export const WorkerAnchor = defineTask<null, { phase: "done" }, null>({
	name: "app.worker-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

type ReporterInput = { workerId: string; role: string; conversationId: ConversationId; task: string };

// `answer` is the worker's final assistant entry, which names the report submission; a worker that never answered has
// none, so the reporter's own durable task id names it instead. Either way the request id is stable across restarts.
type ReporterState =
	| { phase: "deliver" }
	| { phase: "report"; status: WorkerStatus; result: string; answer?: EntryId };

// Delivers the task to the worker, waits for its answer, and reports it to the founder. It is a background task, so
// the founder's turns and idle waits never reach it, and its phases are durable, so a restart mid-worker resumes it.
// Request ids on both submissions make a rerun after a crash deliver the task and the report exactly once.
export const WorkerReporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.worker-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, taskContext) => {
			const { conversationId, task } = reporter.input;
			const worker = (await runtime.conversation(conversationId, taskContext))!;
			const settled = await (
				await worker.submit({ type: "input", content: task, requestId: `worker-task:${reporter.id}` }, taskContext)
			).wait(taskContext);
			await runtime.commit(async (tx) => {
				const report = (status: WorkerStatus, result: string, answer?: EntryId) =>
					({ status: "running", checkpoint: { phase: "report", status, result, answer } }) as const;
				if (settled.status === "unanswered") {
					// An aborted submission is a stopped worker: stop_worker aborts the worker conversation, while any
					// other reason (a model error) is a failure.
					const status: WorkerStatus = settled.reason === "aborted" ? "stopped" : "failed";
					return report(status, `The worker's run ended without an answer: ${settled.reason}.`);
				}
				if (settled.type !== "input") return report("failed", "The worker returned no answer entry.");
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return report("done", messageText(answer), settled.answer);
			}, taskContext);
		},
		report: async (reporter, runtime, taskContext) => {
			const { workerId, role, task } = reporter.input;
			const { status, result, answer } = reporter.state.checkpoint;
			const root = (await runtime.conversation(runtime.conversationId, taskContext))!;
			// A follow-up, so the report starts the founder's next turn rather than interrupting the current one.
			await root.submit(
				{
					type: "input",
					content: workerFinishedContent(workerId, role, task, status, result),
					whenBusy: "followUp",
					requestId: `worker:${workerId}:${answer ?? reporter.id}`,
				},
				taskContext,
			);
			await runtime.commit(async (tx) => {
				const workers = await tx.doc(WorkersDoc, ROOT);
				const record = workers.workers[workerId];
				if (record !== undefined) {
					record.status = status;
					record.result = result;
					record.endedAt = Date.now();
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, taskContext);
		},
	},
	// Aborting the reporter aborts the whole worker, so the registry is updated too; otherwise /status would keep
	// listing a worker that /stop has already killed.
	abort: (reporter, runtime, taskContext) =>
		runtime.commit(async (tx) => {
			const workers = await tx.doc(WorkersDoc, ROOT);
			const record = workers.workers[reporter.input.workerId];
			if (record !== undefined) {
				record.status = "stopped";
				record.endedAt = Date.now();
			}
			return { status: "terminal", outcome: { status: "aborted" } };
		}, taskContext),
});

// The worker extension is what a worker conversation selects instead of the supervisor extension: shared rules and the
// tone, but no tools. The role's instructions are the conversation's `instructions`, rendered after this section.
export const WorkerExtension = defineExtension({
	name: "worker",
	sections: [section("worker", () => WORKER_PROMPT)],
});

export type WorkerToolOptions = {
	readonly defaultWorkerModel: ModelRef;
	readonly maxParallelWorkers: number;
	// Passed in rather than imported so this module does not have to depend on the money module: spawn_worker
	// adds it to a worker's extensions only when the role allows the card.
	readonly paymentCardExtension: Extension;
	// Used by every worker, so it is added to both extension lists in spawn_worker rather than gated by the role.
	readonly webExtension: Extension;
	// The name-only selector of the extension that holds the custom tools for one role (see custom_tools.ts). It is
	// selected for every worker, even before any tool lists the role, so a tool defined later reaches running workers.
	readonly customToolsSelector: (role: string) => Extension;
};

/** The founder-only role and worker tools; the supervisor extension owns them. */
export function createWorkerTools(options: WorkerToolOptions): readonly ToolRegistration[] {
	return [
		defineTool({
			name: "hire_role",
			description:
				"Hire a role: a named set of instructions and a model. Workers are spawned from a role with spawn_worker. The only model value today is \"default\". A role with payment_card true lets its workers read the company payment card.",
			parameters: Type.Object({
				name: Type.String({ description: "A short name for the role, such as developer or marketer." }),
				instructions: Type.String({ description: "What a worker of this role is and how it should work." }),
				model: Type.Optional(
					Type.String({ description: 'The model workers of this role run on. The only value today is "default".' }),
				),
				payment_card: Type.Optional(
					Type.Boolean({ description: "Whether workers of this role may call get_payment_card. Default false." }),
				),
			}),
			execute: async (args, api, context) => {
				const model = args.model ?? "default";
				if (model !== "default") return errorResult(`Unknown model "${model}"; the only value today is "default".`);
				const created = await api.commit(async (tx) => {
					const roles = await tx.doc(RolesDoc, ROOT);
					if (Object.hasOwn(roles.roles, args.name)) return false;
					roles.roles[args.name] = {
						instructions: args.instructions,
						model,
						tools: { payment_card: args.payment_card ?? false },
					};
					return true;
				}, context);
				if (!created) return errorResult(`A role named "${args.name}" already exists; use update_role.`);
				return textResult(`Hired role "${args.name}".`);
			},
		}),
		defineTool({
			name: "update_role",
			description: "Change a role's instructions, model, or card access. Fields you leave out stay as they are.",
			parameters: Type.Object({
				name: Type.String({ description: "The role to change." }),
				instructions: Type.Optional(Type.String({ description: "The new instructions." })),
				model: Type.Optional(Type.String({ description: 'The new model. The only value today is "default".' })),
				payment_card: Type.Optional(
					Type.Boolean({ description: "Whether workers of this role may call get_payment_card." }),
				),
			}),
			execute: async (args, api, context) => {
				if (args.instructions === undefined && args.model === undefined && args.payment_card === undefined) {
					return errorResult("Give at least one of instructions, model, or payment_card to update.");
				}
				if (args.model !== undefined && args.model !== "default") {
					return errorResult(`Unknown model "${args.model}"; the only value today is "default".`);
				}
				const updated = await api.commit(async (tx) => {
					const roles = await tx.doc(RolesDoc, ROOT);
					const role = Object.hasOwn(roles.roles, args.name) ? roles.roles[args.name] : undefined;
					if (role === undefined) return false;
					if (args.instructions !== undefined) role.instructions = args.instructions;
					if (args.model !== undefined) role.model = args.model;
					if (args.payment_card !== undefined) role.tools.payment_card = args.payment_card;
					return true;
				}, context);
				if (!updated) return errorResult(`No role named "${args.name}".`);
				return textResult(`Updated role "${args.name}".`);
			},
		}),
		defineTool({
			name: "fire_role",
			description:
				"Remove a role. Workers already spawned from it keep running; only future spawn_worker calls cannot use it.",
			parameters: Type.Object({
				name: Type.String({ description: "The role to remove." }),
			}),
			execute: async (args, api, context) => {
				const removed = await api.commit(async (tx) => {
					const roles = await tx.doc(RolesDoc, ROOT);
					if (!Object.hasOwn(roles.roles, args.name)) return false;
					delete roles.roles[args.name];
					return true;
				}, context);
				if (!removed) return errorResult(`No role named "${args.name}".`);
				return textResult(`Removed role "${args.name}".`);
			},
		}),
		defineTool({
			name: "spawn_worker",
			description:
				"Start a worker from a role, in the background, and return its worker id at once. The worker's final answer arrives later as a user message starting \"[worker <id> (<role>) finished:\". Give the task all the context the worker needs; it cannot see this conversation.",
			parameters: Type.Object({
				role: Type.String({ description: "The name of a role hired with hire_role." }),
				task: Type.String({
					description: "The self-contained task for the worker: context, exact commands, and what to report.",
				}),
			}),
			execute: async (args, api, context) => {
				const spawned = await api.commit(async (tx): Promise<{ workerId: string } | { error: string }> => {
					const roles = await tx.doc(RolesDoc, ROOT);
					const role = Object.hasOwn(roles.roles, args.role) ? roles.roles[args.role] : undefined;
					if (role === undefined) return { error: `No role named "${args.role}"; hire it with hire_role first.` };
					const workers = await tx.doc(WorkersDoc, ROOT);
					const running = Object.values(workers.workers).filter((worker) => worker.status === "running").length;
					if (running >= options.maxParallelWorkers) {
						return {
							error: `Cannot spawn: ${running} of ${options.maxParallelWorkers} workers are already running. Wait for one to finish or stop one with stop_worker.`,
						};
					}
					const workerId = nextWorkerId(workers.workers);
					// Background belongs to the anchor and the reporter: the founder's Esc and idle waits leave them alone.
					const background = {
						ownership: { kind: "conversation" as const },
						background: true,
						conversationId: ROOT,
					};
					const anchor = await tx.createTask(WorkerAnchor, null, background);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					await configure(tx, child.id, {
						model: options.defaultWorkerModel,
						// Exactly the coding tools and the worker rules; never the supervisor extension. The card tool
						// is offered only to a role that may use it. Custom tools are offered only if they list this role.
						// Web search and fetch are read-only and offered to every worker.
						extensions: role.tools.payment_card
							? [
								CodingTools,
								WorkerExtension,
								options.customToolsSelector(args.role),
								options.webExtension,
								options.paymentCardExtension,
							]
							: [CodingTools, WorkerExtension, options.customToolsSelector(args.role), options.webExtension],
						instructions: role.instructions,
					});
					workers.workers[workerId] = {
						role: args.role,
						task: args.task,
						conversationId: child.id,
						status: "running",
						startedAt: Date.now(),
					};
					await tx.createTask(
						WorkerReporter,
						{ workerId, role: args.role, conversationId: child.id, task: args.task },
						background,
					);
					return { workerId };
				}, context);
				if ("error" in spawned) return errorResult(spawned.error);
				return textResult(
					`Started worker ${spawned.workerId} with role "${args.role}". Its answer will arrive as a worker_finished message.`,
				);
			},
		}),
		defineTool({
			name: "list_workers",
			description: "List every worker with its id, role, status, and task.",
			parameters: Type.Object({}),
			execute: async (_args, api, context) => {
				const workers = await api.snapshot(WorkersDoc, ROOT, context);
				const lines = Object.entries(workers?.workers ?? {}).map(
					([id, worker]) =>
						`${id} ${worker.role} ${worker.status} (started ${new Date(worker.startedAt).toISOString()})${
							worker.endedAt === undefined ? "" : ` (ended ${new Date(worker.endedAt).toISOString()})`
						}\n  task: ${clip(worker.task.replace(/\s+/g, " "), 200)}`,
				);
				return textResult(lines.length === 0 ? "No workers have been spawned." : lines.join("\n"));
			},
		}),
		defineTool({
			name: "message_worker",
			description:
				"Send a running worker more instructions. A steer reaches the worker after its current tool round, so it joins the work in progress rather than starting a new task.",
			parameters: Type.Object({
				worker_id: Type.String({ description: "The worker id from spawn_worker or list_workers." }),
				text: Type.String({ description: "What to tell the worker." }),
			}),
			execute: async (args, api, context) => {
				const worker = await findWorker(api, args.worker_id, context);
				if (typeof worker === "string") return errorResult(worker);
				if (worker.status !== "running") return errorResult(`Worker ${args.worker_id} is not running.`);
				const handle = await api.conversation(worker.conversationId, context);
				if (handle === undefined) return errorResult(`Worker ${args.worker_id} has no conversation.`);
				await handle.submit({ type: "input", content: args.text, whenBusy: "steer" }, context);
				return textResult(`Sent to worker ${args.worker_id}.`);
			},
		}),
		defineTool({
			name: "stop_worker",
			description: "Stop a running worker: it abandons its current work and reports as stopped.",
			parameters: Type.Object({
				worker_id: Type.String({ description: "The worker id from spawn_worker or list_workers." }),
			}),
			execute: async (args, api, context) => {
				const worker = await findWorker(api, args.worker_id, context);
				if (typeof worker === "string") return errorResult(worker);
				if (worker.status !== "running") return errorResult(`Worker ${args.worker_id} is not running.`);
				const handle = await api.conversation(worker.conversationId, context);
				if (handle === undefined) return errorResult(`Worker ${args.worker_id} has no conversation.`);
				await handle.abort(context);
				return textResult(`Stopped worker ${args.worker_id}. It will report as stopped.`);
			},
		}),
		defineTool({
			name: "read_worker_transcript",
			description:
				"Show the most recent part of a worker's conversation as lines of role: text, oldest first within that part. Earlier history is cut off, so a long worker's start is not shown. Use it to see what a worker actually did and how it ended.",
			parameters: Type.Object({
				worker_id: Type.String({ description: "The worker id from spawn_worker or list_workers." }),
			}),
			execute: async (args, api, context) => {
				const worker = await findWorker(api, args.worker_id, context);
				if (typeof worker === "string") return errorResult(worker);
				// A tool has no read-only handle for another conversation's entries: only a transaction can scan them,
				// so the transcript is read inside a commit.
				const page = await api.commit(
					(tx) =>
						tx.scanEntries(
							{ conversationId: worker.conversationId, order: "descending" },
							MAX_TRANSCRIPT_ENTRIES,
							undefined,
						),
					context,
				);
				// The newest entries come first from the scan, and the worker's final answer is the thing the founder
				// most needs, which the oldest entries of a long worker would push out of reach. They are put back
				// in chronological order for reading.
				const lines: string[] = [];
				for (const entry of [...page.items].reverse()) {
					for (const message of entry.model ?? []) lines.push(`${message.role}: ${contentToText(message.content)}`);
				}
				if (lines.length === 0) return textResult(`Worker ${args.worker_id} has no transcript yet.`);
				const prefix = page.next === undefined ? "" : `[only the last ${MAX_TRANSCRIPT_ENTRIES} entries are shown]\n...\n`;
				return textResult(`${prefix}${clipStart(lines.join("\n"), MAX_TRANSCRIPT_CHARS)}`);
			},
		}),
	];
}

/** Running workers as `<id> <role>` pairs, which /status prints. Small on purpose: the Telegram code stays thin. */
export async function runningWorkers(harness: Harness, context: Context): Promise<Array<{ id: string; role: string }>> {
	const state = await harness.snapshot(WorkersDoc, ROOT, context);
	return Object.entries(state?.workers ?? {})
		.filter(([, worker]) => worker.status === "running")
		.map(([id, worker]) => ({ id, role: worker.role }));
}

// Reads one worker out of the registry, or returns the message to show. Every worker tool needs the same lookup and
// the same "no such worker" answer, so it lives in one place.
async function findWorker(api: ToolExecutionApi, workerId: string, context: Context): Promise<WorkerRecord | string> {
	const state = await api.snapshot(WorkersDoc, ROOT, context);
	const worker = state?.workers[workerId];
	return worker === undefined ? `No worker with id "${workerId}".` : worker;
}

function nextWorkerId(workers: Record<string, WorkerRecord>): string {
	let highest = 0;
	for (const key of Object.keys(workers)) {
		const match = /^w(\d+)$/.exec(key);
		if (match !== null) highest = Math.max(highest, Number(match[1]));
	}
	return `w${highest + 1}`;
}

function messageText(message: AssistantMessage | undefined): string {
	const text = (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
	return text.trim() === "" ? "(the worker gave no text answer)" : text;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content as unknown[]) {
		if (typeof part !== "object" || part === null) continue;
		const fields = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
		if (fields.type === "text" && typeof fields.text === "string") parts.push(fields.text);
		else if (fields.type === "toolCall") parts.push(`[called ${String(fields.name)} ${JSON.stringify(fields.arguments)}]`);
		else if (fields.type === "image") parts.push("[image]");
	}
	return parts.join(" ");
}

function workerFinishedContent(
	workerId: string,
	role: string,
	task: string,
	status: WorkerStatus,
	result: string,
): string {
	return `[worker ${workerId} (${role}) finished: ${status}]\nTask: ${task}\nResult:\n${clip(result, MAX_RESULT_CHARS)}`;
}

// Where a worker's answer is longer than this, the founder reads the rest with read_worker_transcript.
const MAX_RESULT_CHARS = 4000;
// One transcript call is one storage read; the cap keeps a long-running worker from flooding the founder's context.
const MAX_TRANSCRIPT_ENTRIES = 200;
const MAX_TRANSCRIPT_CHARS = 8000;

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n... [truncated]`;
}

// Keeps the end of the text, for the transcript, where the newest lines matter most.
function clipStart(text: string, limit: number): string {
	return text.length <= limit ? text : `[truncated] ...\n${text.slice(text.length - limit)}`;
}

function textResult(text: string): { output: Array<{ type: "text"; text: string }> } {
	return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: Array<{ type: "text"; text: string }>; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
