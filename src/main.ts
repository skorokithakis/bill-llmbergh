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
import { SupervisorExtension } from "./supervisor.ts";

const context = BACKGROUND_CONTEXT;

async function main(): Promise<void> {
	const config = loadConfig();
	// Loaded here only to fail fast; the card and Telegram secrets are used by later tickets.
	const secrets = loadSecrets();
	const dataDir = process.env.DATA_DIR ?? "/data";
	mkdirSync(dataDir, { recursive: true });

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(SupervisorExtension);

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
	// process never makes a model call with the old prompt or model.
	await root.configure({ model: config.models.founder, instructions: FOUNDER_PROMPT }, context);
	harness.resume();

	const stopHeartbeat = await startHeartbeat(harness, root, config.heartbeatIntervalMinutes * 60_000, context);

	const shutdown = async (): Promise<void> => {
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
