import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import { createCustomToolManagementTools, customToolsSelector } from "./custom_tools.ts";
import { createMoneyTools, type AdvisorName } from "./money.ts";
import { sendToOwner } from "./telegram.ts";
import { createWakeupTools } from "./wakeups.ts";
import { createWorkerTools, WorkerAnchor, WorkerReporter } from "./workers.ts";

// The founder's supervisor tools. It is assembled here so main.ts installs one object, and the worker task
// definitions ride along: they are resolved by name from the registry, whichever conversations select the
// extension. The advisors and the daily caps live in money.ts; the payment card is its own extension because
// worker conversations select it per role.
export type SupervisorOptions = {
	readonly defaultWorkerModel: ModelRef;
	readonly maxParallelWorkers: number;
	readonly advisorModels: Record<AdvisorName, ModelRef>;
	readonly advisorCallsPerDay: number;
	readonly paymentCardExtension: Extension;
	// Installed once and selected for the founder here; spawn_worker adds it to every worker's extensions.
	readonly webExtension: Extension;
	// The tools that define custom tools reinstall the custom-tools extensions after every change.
	readonly registry: Registry;
};

const MessageOwnerTool = defineTool({
	name: "message_owner",
	description:
		"Send a Telegram message to the owner. Use it to report progress, answer the owner, or ask for something you cannot do yourself. Long messages are split into several Telegram messages.",
	parameters: Type.Object({
		text: Type.String({ description: "The message to send to the owner." }),
	}),
	// Deliberately not replay-safe: sending a message is an external effect, so an interrupted call
	// must come back to the model as interrupted instead of being sent again on restart.
	execute: async (args) => {
		await sendToOwner(args.text);
		return { output: [{ type: "text", text: "Message delivered to the owner." }] };
	},
});

export function createSupervisorExtension(options: SupervisorOptions): Extension {
	return defineExtension({
		name: "supervisor",
		tasks: [WorkerAnchor, WorkerReporter],
		tools: [
			MessageOwnerTool,
			...createMoneyTools({ advisorModels: options.advisorModels, advisorCallsPerDay: options.advisorCallsPerDay }),
			...createWorkerTools({ ...options, customToolsSelector }),
			...createCustomToolManagementTools({ registry: options.registry }),
			...createWakeupTools(),
		],
	});
}
