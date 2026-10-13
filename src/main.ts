import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { loadConfig, loadSecrets } from "./config.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { FOUNDER_PROMPT } from "./prompt.ts";
import { createCompanyModels } from "./providers.ts";
import { connectToWorkVm } from "./remote.ts";
import { createSupervisorExtension } from "./supervisor.ts";
import { isStopped, startTelegram } from "./telegram.ts";
import { WorkerExtension } from "./workers.ts";

const context = BACKGROUND_CONTEXT;

async function main(): Promise<void> {
	const config = loadConfig();
	// Loaded here to fail fast before anything connects; the Telegram token is used below and the card
	// details are used by a later ticket.
	const secrets = loadSecrets();
	const dataDir = process.env.DATA_DIR ?? "/data";
	mkdirSync(dataDir, { recursive: true });

	const registry = createRegistry();
	registry.install(CodingTools);
	// The worker extension holds the shared worker prompt; the supervisor extension holds the founder's tools and the
	// worker task definitions. Root conversations must not select the worker extension (it is removed below), and
	// worker conversations select exactly CodingTools and the worker extension.
	const supervisor = createSupervisorExtension({
		defaultWorkerModel: config.models.defaultWorker,
		maxParallelWorkers: config.maxParallelWorkers,
	});
	registry.install(WorkerExtension);
	registry.install(supervisor);

	const models = createCompanyModels(config, resolve(dataDir, "auth.json"));

	const workVm = await connectToWorkVm(config, dataDir);
	await workVm.warmUp();

	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(dataDir, "harness.sqlite")),
		{ models, registry, env: () => workVm.environment(), onReport: (error) => console.error("harness report:", error) },
		context,
	);
	harness.closed.then((end) => {
		if (end.reason === "failed") console.error("harness closed after a storage failure:", end.error);
	});

	const root = await harness.root(context);
	// Configured on every start, not just at creation, so a change to the prompt or model takes effect
	// on the existing root conversation. Done before resume() so a run resumed from the previous
	// process never makes a model call with the old prompt or model. The worker extension is removed so the
	// founder never sees the worker rules; every other installed extension still reaches it.
	await root.configure(
		{
			model: config.models.founder,
			instructions: FOUNDER_PROMPT,
			extensions: { remove: [WorkerExtension] },
		},
		context,
	);
	harness.resume();

	// A restart while /stop was in effect must not resume pending work, so abort again here. The heartbeat
	// and the Telegram poller also obey the durable flag.
	if (await isStopped(harness, root, context)) await root.abort(context, { background: true });

	const stopHeartbeat = await startHeartbeat(harness, root, config.heartbeatIntervalMinutes * 60_000, context);
	const stopTelegram = await startTelegram({
		harness,
		root,
		botToken: secrets.telegramBotToken,
		ownerUserId: config.telegram.ownerUserId,
		context,
	});

	const shutdown = async (): Promise<void> => {
		await stopTelegram();
		await stopHeartbeat();
		await harness.close(context);
		await workVm.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());

	console.log(`supervisor started; secrets present: ${Object.keys(secrets).join(", ")}`);

	const debugPrompt = process.env.DEBUG_PROMPT;
	if (debugPrompt !== undefined) {
		const submission = await root.submit({ type: "input", content: debugPrompt, requestId: `debug:${Date.now()}` }, context);
		const settled = await submission.wait(context);
		console.log(`debug prompt settled: ${settled.status}`);
	}
}

await main();
