// Throwaway spike: Pi Durable + pi-env + a DeepSeek model, proving the four checks in ticket bl-fjczd.
// Not production code. Run from the repo root, with .secrets/vm.env sourced and DEEPSEEK_API_KEY set:
//   node --experimental-strip-types spike/spike.ts check1 spike/session-check1.sqlite
//   node --experimental-strip-types spike/spike.ts check2a spike/session-check2.sqlite
//   node --experimental-strip-types spike/spike.ts check2b spike/session-check2.sqlite
//   node --experimental-strip-types spike/spike.ts check4 spike/session-check2.sqlite
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	LiveDoc,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { acceptHostKey, RemoteExecutionEnv, scanHostKey, sshConnection, type Connection } from "@earendil-works/pi-env";

const context = BACKGROUND_CONTEXT;

// ─── Model: DeepSeek served by Ollama Cloud ─────────────────────────────────
// The DEEPSEEK_API_KEY in the environment is an Ollama Cloud key (api.deepseek.com rejects it). AGENTS.md
// documents Ollama Cloud as an OpenAI-compatible provider; use pi-ai's deepseek catalog model, repointed.
const OLLAMA_MODEL_ID = "deepseek-v4.1-flash";
const REGISTRY_MODEL = { provider: "deepseek", modelId: OLLAMA_MODEL_ID } as const;

function createDeepseekModels() {
	const builtin = deepseekProvider();
	const flash = builtin.getModels().find((model) => model.id === "deepseek-flash")!;
	const provider = createProvider({
		id: "deepseek",
		name: "DeepSeek via Ollama Cloud",
		baseUrl: "https://ollama.com/v1",
		auth: builtin.auth,
		models: [{ ...flash, id: OLLAMA_MODEL_ID, baseUrl: "https://ollama.com/v1", compat: { ...flash.compat, supportsDeveloperRole: false } }],
		api: openAICompletionsApi(),
	});
	const models = createModels();
	models.setProvider(provider);
	return models;
}

// ─── Remote environment on the work VM ──────────────────────────────────────
const repoRoot = process.cwd();
const sshTarget = {
	host: process.env.VM_HOST!,
	user: process.env.VM_USER,
	identityFile: resolve(repoRoot, process.env.SSH_KEY ?? ".secrets/ssh/id_ed25519"),
	knownHostsFile: resolve(repoRoot, process.env.SSH_KNOWN_HOSTS ?? ".secrets/ssh/known_hosts"),
	hostKeyAlias: "pi-env-bill-spike",
};

// Trust the host key once: only scan when the alias is not already in our known-hosts file.
{
	const known = existsSync(sshTarget.knownHostsFile) ? readFileSync(sshTarget.knownHostsFile, "utf8") : "";
	const trusted = known.split("\n").some((line) => line.startsWith(`${sshTarget.hostKeyAlias} `));
	if (!trusted) {
		const { lines, fingerprints } = await scanHostKey(sshTarget);
		console.log("host key fingerprints:", fingerprints);
		await acceptHostKey(sshTarget, lines);
	}
}
const { connection } = sshConnection(sshTarget);
const remoteEnv = () => new RemoteExecutionEnv({ connection, id: "pi-env:bill-spike", cwd: "/root" });

// The first VM operation pays for platform detection and daemon deployment (seconds). Warm up so the
// interrupted-call test lands inside the command, not inside the deploy.
async function warmUp(): Promise<void> {
	let output = "";
	const result = await remoteEnv().exec("echo warm; uname -m", { onOutput: (text) => { output += text; } }, context);
	if (!result.ok) throw new Error(`VM warm-up failed: ${JSON.stringify(result.error)}`);
	console.log("VM warm-up:", output.trim());
}

// ─── Product code: one subagent tool, trimmed to spawn + report back ────────
type WorkerState = { phase: "deliver" } | { phase: "report"; report?: string };
type WorkerInput = { name: string; conversationId: ConversationId; task: string };

// A background anchor owns the worker conversation so the root's turns (and Esc) never reach it.
const WorkerAnchor = defineTask<null, { phase: "done" }, null>({
	name: "app.spike-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

// Delivers one task to the worker and reports the worker's final answer back to the root as a follow-up.
// Request ids make a rerun after a crash deliver and report exactly once.
const WorkerReporter = defineTask<WorkerInput, WorkerState, null>({
	name: "app.spike-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, taskContext) => {
			const { name, conversationId, task } = reporter.input;
			const worker = (await runtime.conversation(conversationId, taskContext))!;
			const settled = await (
				await worker.submit({ type: "input", content: task, requestId: `spike:${reporter.id}` }, taskContext)
			).wait(taskContext);
			// Read the worker's answer entry by its global id inside the commit; the task's own conversation cannot see it.
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered") return next(`[worker ${name} failed: ${settled.reason}]`);
				if (settled.type !== "input") return next();
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return next(`[worker ${name} answered] ${messageText(answer)}`);
			}, taskContext);
		},
		report: async (reporter, runtime, taskContext) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const root = (await runtime.conversation(runtime.conversationId, taskContext))!;
				await root.submit(
					{ type: "input", content: report, whenBusy: "followUp", requestId: `spike-report:${reporter.id}` },
					taskContext,
				);
			}
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			);
		},
	},
	abort: (_reporter, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

const Workers = defineDoc<{ workers: Record<string, { conversationId: ConversationId }>; reporters: Record<string, TaskId> }>({
	kind: "app.spike-workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workers: {}, reporters: {} }),
});

const subagentTool = defineTool({
	name: "subagent",
	description: "Spawn a worker with a task. It runs in the background; its final answer is reported back to you.",
	parameters: Type.Object({ name: Type.String(), task: Type.String() }),
	execute: async (args, api, callContext) => {
		const { name, task } = args;
		const result = await api.commit(async (tx) => {
			const state = await tx.doc(Workers, api.conversationId);
			if (Object.hasOwn(state.workers, name)) return `${name} already exists.`;
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			const anchor = await tx.createTask(WorkerAnchor, null, background);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				extensions: { remove: [SpikeTools] },
				model: REGISTRY_MODEL,
				instructions: `You are the worker "${name}". Use the bash tool to do exactly what is asked, then give a short final answer with the output. You cannot spawn workers. If a command is interrupted or fails, do not retry it; report what happened.`,
			});
			state.workers[name] = { conversationId: child.id };
			state.reporters[api.taskId] = await tx.createTask(WorkerReporter, { name, conversationId: child.id, task }, background);
			return `Spawned ${name}.`;
		}, callContext);
		return { output: [{ type: "text" as const, text: result }], details: { name } };
	},
});

const SpikeTools = defineExtension({ name: "spike-tools", tasks: [WorkerAnchor, WorkerReporter], tools: [subagentTool] });

const ROOT_INSTRUCTIONS = [
	"You are Bill, the founder of a company. You never do the work yourself.",
	"To carry out any task, spawn a worker with the subagent tool and give it precise instructions.",
	`Worker answers arrive to you as messages starting with "[worker NAME answered]"; reply with a one-line acknowledgement.`,
	"Never run shell commands or edit files yourself.",
].join(" ");

// ─── Host setup ─────────────────────────────────────────────────────────────
const registry = createRegistry();
registry.install(CodingTools);
registry.install(SpikeTools);
const models = createDeepseekModels();

async function openHarness(dbPath: string) {
	return Harness.open(
		await openNodeSqliteStorage(dbPath),
		{ models, registry, env: remoteEnv, onReport: (error) => console.error("onReport:", error) },
		context,
	);
}

// ─── Reading the SQLite file directly (check 4) ─────────────────────────────
type MessageLike = { role?: string; content?: unknown };
function messageText(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const p = part as { type?: string; text?: string; name?: string; arguments?: unknown };
			if (p.type === "text") return [p.text ?? ""];
			if (p.type === "toolCall") return [`<toolCall ${p.name} ${JSON.stringify(p.arguments)}>`];
			if (p.type === "toolResult") return [`<toolResult ${contentText(p.content)}>`];
			return [`<${p.type}>`];
		})
		.join("\n");
}

function listConversations(dbPath: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const conversations = db.prepare("SELECT id, owner_conversation_id, owner_task_id FROM conversations ORDER BY id").all();
	const entries = db.prepare("SELECT id, conversation_id, record FROM entries ORDER BY conversation_id, id").all();
	db.close();
	const byConversation = new Map<number, Array<{ id: number; kind: string; model: MessageLike[] }>>();
	for (const row of entries as Array<{ id: number; conversation_id: number; record: string }>) {
		const record = JSON.parse(row.record) as { kind: string; model?: MessageLike[] };
		const list = byConversation.get(row.conversation_id) ?? [];
		list.push({ id: row.id, kind: record.kind, model: record.model ?? [] });
		byConversation.set(row.conversation_id, list);
	}
	return { conversations, byConversation };
}

function printEntries(dbPath: string): void {
	const { conversations, byConversation } = listConversations(dbPath);
	console.log("\n===== SQLite entries =====");
	for (const conversation of conversations as Array<{ id: number; owner_conversation_id: number | null; owner_task_id: number | null }>) {
		const owner = conversation.owner_task_id !== null
			? `owned by task ${conversation.owner_task_id}`
			: conversation.owner_conversation_id !== null
				? `owned by conversation ${conversation.owner_conversation_id}`
				: "root";
		console.log(`\n--- conversation ${conversation.id} (${owner}) ---`);
		for (const entry of byConversation.get(conversation.id) ?? []) {
			console.log(`  entry ${entry.id} [${entry.kind}]`);
			if (entry.model.length === 0) console.log("    <no model messages>");
			else for (const message of entry.model) console.log(`    ${message.role}: ${contentText(message.content)}`);
		}
	}
}

async function printUsage(harness: Harness): Promise<void> {
	const usage = await harness.usage(context);
	console.log("\n===== harness.usage() =====");
	console.log(JSON.stringify(usage, null, 2));
}

async function settleWorkers(harness: Harness, rootConversationId: ConversationId): Promise<void> {
	const doc = await harness.snapshot(Workers, rootConversationId, context);
	for (const id of Object.values(doc?.reporters ?? {})) await harness.waitForTask(id, context);
	const root = (await harness.conversation(rootConversationId, context))!;
	await root.waitForIdle(context);
}

// ─── Modes ──────────────────────────────────────────────────────────────────
const mode = process.argv[2];
const dbPath = resolve(repoRoot, process.argv[3] ?? "spike/session.sqlite");
const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function check1(): Promise<void> {
	await warmUp();
	const harness = await openHarness(dbPath);
	const root = await harness.root(context, { agent: { model: REGISTRY_MODEL, instructions: ROOT_INSTRUCTIONS } });
	const prompt =
		"Spawn a worker named alice. Tell it to run this exact command on the VM with bash: " +
		"`uname -a; touch /tmp/spike`. It must report the exact command output.";
	console.log("root prompt:", prompt);
	await (await root.submit({ type: "input", content: prompt, requestId: "check1" }, context)).wait(context);
	await settleWorkers(harness, root.id);
	await sleep(200);
	printEntries(dbPath);
	await printUsage(harness);
	await harness.close(context);
}

async function check2a(): Promise<void> {
	await warmUp();
	const harness = await openHarness(dbPath);
	const root = await harness.root(context, { agent: { model: REGISTRY_MODEL, instructions: ROOT_INSTRUCTIONS } });
	const prompt =
		"Spawn a worker named bob. Tell it to run this exact bash command on the VM exactly once: " +
		"`echo start > /tmp/spike2; sleep 40; echo done >> /tmp/spike2`. " +
		"It must report the command output. It must not retry if the command is interrupted.";
	console.log("root prompt:", prompt);
	await (await root.submit({ type: "input", content: prompt, requestId: "check2" }, context)).wait(context);
	const doc = await harness.snapshot(Workers, root.id, context);
	const workerId = doc?.workers["bob"]?.conversationId;
	if (workerId === undefined) throw new Error("bob was not spawned");
	// Wait until the worker is actually inside its bash call, then signal the driver to SIGKILL us.
	for (let tries = 0; tries < 240; tries++) {
		const live = await harness.snapshot(LiveDoc, workerId, context);
		if (live?.tools?.some((tool) => tool.name === "bash" && tool.status === "running")) break;
		await sleep(500);
	}
	console.log(`worker conversation ${workerId}; bash is running`);
	console.log("READY_TO_KILL");
	// Idle forever; the driver kills this process group.
	await new Promise(() => {});
}

async function check2b(): Promise<void> {
	const harness = await openHarness(dbPath);
	harness.resume();
	const root = await harness.root(context);
	await settleWorkers(harness, root.id);
	await sleep(200);
	printEntries(dbPath);
	await printUsage(harness);
	await harness.close(context);
}

async function check4(): Promise<void> {
	const harness = await openHarness(dbPath);
	printEntries(dbPath);
	await printUsage(harness);
	await harness.close(context);
}

// ─── Check 3: what survives an SSH drop ─────────────────────────────────────
function makeExec(targetConnection: Connection, id: string) {
	const environment = new RemoteExecutionEnv({ connection: targetConnection, id, cwd: "/root" });
	return async (command: string): Promise<string> => {
		let output = "";
		const result = await environment.exec(command, { onOutput: (text) => { output += text; } }, context);
		if (!result.ok) throw new Error(`exec failed: ${result.error.message ?? JSON.stringify(result.error)}`);
		return output.trim() || `(exit ${result.value.exitCode})`;
	};
}

// Kill the local `ssh` processes for this host, which is what a dropped connection or a supervisor
// restart looks like to the remote pi-env daemon.
function killSshTransport(): void {
	const processes = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
	for (const line of processes.split("\n").filter((l) => l.includes("ssh") && l.includes(sshTarget.host) && !l.includes("grep"))) {
		try { process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL"); } catch {}
	}
}

async function dropThenCheck(label: string, checkCommand: string): Promise<string> {
	killSshTransport();
	await sleep(2500);
	const next = sshConnection(sshTarget);
	const exec = makeExec(next.connection, `pi-env:spike-${label}`);
	const observed = await exec(checkCommand);
	next.connection.close();
	return observed;
}

async function check3(): Promise<void> {
	console.log("cleanup first:", await makeExec(sshConnection(sshTarget).connection, "pi-env:c3-clean")(
		"systemctl stop spike-sleep 2>&1; pkill -f '[s]leep 65' 2>&1; echo done",
	));

	// 3a. A foreground command still in flight when the transport drops. The daemon kills its process group.
	{
		const connectionA = sshConnection(sshTarget).connection;
		const execA = makeExec(connectionA, "pi-env:c3-a");
		await execA("echo warm"); // pay platform detection + daemon deploy here
		console.log("\n3a. starting `sleep 653` and dropping the transport mid-command");
		const inFlight = execA("sleep 653; echo finished").then(() => "resolved", (error: Error) => `rejected: ${error.message}`);
		await sleep(1200);
		killSshTransport();
		await sleep(2500);
		console.log("  in-flight exec settled as:", await Promise.race([inFlight, sleep(5000).then(() => "still pending")]));
		const checker = sshConnection(sshTarget);
		console.log("  after drop:", await makeExec(checker.connection, "pi-env:c3-a-check")("ps -eo pid,args | grep '[s]leep 653' || echo none"));
		checker.connection.close();
		connectionA.close();
	}

	// 3b. `nohup sleep &` where the spawning exec returns at once. The process is orphaned; nothing is left to kill.
	{
		const connectionB = sshConnection(sshTarget).connection;
		const execB = makeExec(connectionB, "pi-env:c3-b");
		console.log("\n3b. `nohup sleep 654 &` (exec returns), then drop");
		console.log("  launched as:", await execB("nohup sleep 654 >/dev/null 2>&1 & echo pid $!"));
		console.log("  after drop:", await dropThenCheck("c3-b-check", "ps -eo pid,args | grep '[s]leep 654' || echo none"));
		connectionB.close();
	}

	// 3c. A systemd transient unit.
	{
		const connectionC = sshConnection(sshTarget).connection;
		const execC = makeExec(connectionC, "pi-env:c3-c");
		console.log("\n3c. `systemd-run --unit=spike-sleep sleep 655`, then drop");
		console.log("  started as:", await execC("systemd-run --unit=spike-sleep sleep 655 2>&1 | tail -1; systemctl is-active spike-sleep"));
		console.log("  after drop:", await dropThenCheck("c3-c-check", "systemctl is-active spike-sleep; ps -eo pid,args | grep '[s]leep 655' || echo none"));
		connectionC.close();
	}

	console.log("\ncleanup:", await dropThenCheck("c3-final", "systemctl stop spike-sleep 2>&1; pkill -f '[s]leep 65' 2>&1; echo done; systemctl is-active spike-sleep 2>&1; ps -eo pid,args | grep '[s]leep 65' || echo none"));
}

if (mode === "check1") await check1();
else if (mode === "check2a") await check2a();
else if (mode === "check2b") await check2b();
else if (mode === "check3") await check3();
else if (mode === "check4") await check4();
else throw new Error(`unknown mode: ${mode}`);

await connection.close();
