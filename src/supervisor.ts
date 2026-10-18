import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import type { FileError } from "@earendil-works/pi-durable/env";
import { createCustomToolManagementTools, customToolsSelector } from "./custom_tools.ts";
import { createMoneyTools, type AdvisorName } from "./money.ts";
import { MAX_CAPTION_LENGTH, MAX_DOCUMENT_BYTES, sendFileToOwner, sendToOwner } from "./telegram.ts";
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

const SendFileTool = defineTool({
	name: "send_file",
	description: `Send one file from the work VM to the owner as a Telegram document, with an optional caption. Telegram accepts documents up to ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB and captions up to ${MAX_CAPTION_LENGTH} characters. Use it for results the owner should have as a file (a report, an archive, an image, a database dump); use message_owner for text.`,
	parameters: Type.Object({
		path: Type.String({ description: "Path of the file on the work VM. A directory or a missing path is an error." }),
		caption: Type.Optional(
			Type.String({ description: `Optional caption shown with the file, at most ${MAX_CAPTION_LENGTH} characters.` }),
		),
	}),
	// Not replay-safe, like message_owner and for the same reason: an interrupted call must not upload twice.
	execute: async (args, api, context) => {
		if (api.env === undefined) return errorResult("No work VM environment is configured, so send_file cannot read files.");
		// Checked here rather than left to Telegram, because a rejected upload is a wasted 50 MB and a vague error.
		if (args.caption !== undefined && args.caption.length > MAX_CAPTION_LENGTH) {
			return errorResult(
				`The caption is ${args.caption.length} characters, but Telegram allows at most ${MAX_CAPTION_LENGTH}. Shorten it and try again.`,
			);
		}

		// fileInfo is a cheap stat, so an oversized or missing file is refused before its bytes cross the SSH link.
		// It does not follow a symbolic link, so the size check is repeated on what was actually read below.
		const info = await api.env.fileInfo(args.path, context);
		if (!info.ok) {
			throwIfAborted(info.error, context);
			return errorResult(fileErrorText(args.path, info.error));
		}
		if (info.value.kind === "directory") return errorResult(directoryText(args.path));
		if (info.value.size > MAX_DOCUMENT_BYTES) return errorResult(tooBigText(args.path, info.value.size));

		const read = await api.env.readBinaryFile(args.path, context);
		if (!read.ok) {
			throwIfAborted(read.error, context);
			return errorResult(fileErrorText(args.path, read.error));
		}
		// A symbolic link or a file that grew after the stat only shows its real size here.
		if (read.value.byteLength > MAX_DOCUMENT_BYTES) return errorResult(tooBigText(args.path, read.value.byteLength));

		const filename = posix.basename(args.path);
		try {
			await sendFileToOwner(
				{
					filename: filename === "" ? "file" : filename,
					bytes: read.value,
					...(args.caption === undefined ? {} : { caption: args.caption }),
				},
				context.abortSignal,
			);
		} catch (error) {
			// /stop, the cost cap, and shutdown abort the upload with the call; let the cancellation propagate.
			if (context.abortSignal?.aborted === true) throw error;
			return errorResult(`The file was not sent: ${error instanceof Error ? error.message : String(error)}`);
		}
		return textResult(`Sent ${filename} (${formatBytes(read.value.byteLength)}) to the owner on Telegram.`);
	},
});

function tooBigText(path: string, bytes: number): string {
	return `${path} is ${formatBytes(bytes)}, over Telegram's ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB limit for bot uploads. Nothing was sent. Compress or split it, or serve it from the VM's web server and send the link with message_owner.`;
}

function directoryText(path: string): string {
	return `${path} is a directory. Archive it first (for example with tar) and send the archive, or send one file from it.`;
}

function fileErrorText(path: string, error: FileError): string {
	switch (error.code) {
		case "not_found":
			return `There is no file at ${path}. Check the path with bash; it may be missing or mistyped.`;
		case "permission_denied":
			return `Permission denied reading ${path}. Fix its permissions with bash and try again.`;
		case "is_directory":
			return directoryText(path);
		case "not_supported":
			return `${path} is not a regular file, so it cannot be sent. Send a regular file instead.`;
		default:
			return `Could not read ${path}: ${error.message}`;
	}
}

// An aborted call is /stop, the cost cap, or shutdown cancelling the tool, not a failure the model should react to.
function throwIfAborted(error: FileError, context: Context): void {
	if (error.code === "aborted" && context.abortSignal?.aborted === true) throw error;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function textResult(text: string): { output: Array<{ type: "text"; text: string }> } {
	return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: Array<{ type: "text"; text: string }>; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}

export function createSupervisorExtension(options: SupervisorOptions): Extension {
	return defineExtension({
		name: "supervisor",
		tasks: [WorkerAnchor, WorkerReporter],
		tools: [
			MessageOwnerTool,
			SendFileTool,
			...createMoneyTools({ advisorModels: options.advisorModels, advisorCallsPerDay: options.advisorCallsPerDay }),
			...createWorkerTools({ ...options, customToolsSelector }),
			...createCustomToolManagementTools({ registry: options.registry }),
			...createWakeupTools(),
		],
	});
}
