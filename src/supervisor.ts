import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { sendToOwner } from "./telegram.ts";
import { createWorkerTools, WorkerAnchor, WorkerReporter } from "./workers.ts";

// The founder's supervisor tools. Later tickets add the advisors, the caps, and the custom tools here. The extension
// is assembled here so main.ts installs one object, and the worker task definitions ride along: they are resolved by
// name from the registry, whichever conversations select the extension.
export type SupervisorOptions = {
	readonly defaultWorkerModel: ModelRef;
	readonly maxParallelWorkers: number;
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
		tools: [MessageOwnerTool, ...createWorkerTools(options)],
	});
}
