import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { sendToOwner } from "./telegram.ts";

// The founder's supervisor tools. Later tickets add the roles, workers, advisors, and custom tools here.
// The extension is installed from the start so those tickets only add entries.
export const SupervisorExtension = defineExtension({
	name: "supervisor",
	tools: [
		defineTool({
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
		}),
	],
});
