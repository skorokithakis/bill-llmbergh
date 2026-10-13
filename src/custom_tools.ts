import { type Context } from "@earendil-works/chord";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	ROOT_CONVERSATION_ID,
	type Extension,
	type JsonObject,
	type Registry,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { RolesDoc } from "./workers.ts";

// A custom tool is a shell command the founder defines. It runs on the work VM, so a custom tool can only do what bash
// there can already do, and it is stored in the harness SQLite file so a restart brings it back.
export type CustomTool = {
	description: string;
	/** A JSON schema object, passed to Durable as it is so Durable validates the arguments before the command runs. */
	parameters: JsonObject;
	command: string;
	/** Roles whose workers get the tool. The founder always has every custom tool. */
	roles: string[];
};

export const CustomToolsDoc = defineDoc<{ tools: Record<string, CustomTool> }>({
	kind: "app.custom_tools",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ tools: {} }),
});

const ROOT = ROOT_CONVERSATION_ID;

// The founder's extension holds every custom tool. Each role also has its own extension holding only that role's tools,
// and a worker selects its role's extension when it is spawned. A conversation sees exactly the tools of the extensions
// it selects, so a worker of another role never has the tool in its tool list at all, which a refusal inside `execute`
// could not achieve. The root selects extensions explicitly (see main.ts), so it never sees the same tool twice.
const EXTENSION_PREFIX = "custom-tools";

function extensionName(role: string | undefined): string {
	return role === undefined ? EXTENSION_PREFIX : `${EXTENSION_PREFIX}:${role}`;
}

/**
 * An empty extension carrying only the name, for a conversation to select. Selections are stored by name and resolved
 * against the registry at each use, so a worker can select its role's extension before any tool for that role exists
 * and picks the tools up the moment they are installed.
 */
export function customToolsSelector(role?: string): Extension {
	return defineExtension({ name: extensionName(role) });
}

/** The extension for the founder (no role) or for one role, built from the stored definitions. */
export function buildCustomToolsExtension(state: { tools: Record<string, CustomTool> }, role?: string): Extension {
	const tools = Object.entries(state.tools)
		.filter(([, tool]) => role === undefined || tool.roles.includes(role))
		.map(([name, tool]) => createCustomTool(name, tool));
	return defineExtension({ name: extensionName(role), tools });
}

/**
 * Publish the stored definitions: the founder's extension, one extension per role that has a tool, and the removal of
 * the extension of a role that no longer has any. Called at startup and after every change, so the next request sees it.
 */
export function installCustomTools(registry: Registry, state: { tools: Record<string, CustomTool> }): void {
	const roles = new Set(Object.values(state.tools).flatMap((tool) => tool.roles));
	registry.install(buildCustomToolsExtension(state));
	for (const role of roles) registry.install(buildCustomToolsExtension(state, role));
	for (const extension of registry.snapshot().installed()) {
		if (!extension.name.startsWith(`${EXTENSION_PREFIX}:`)) continue;
		if (!roles.has(extension.name.slice(EXTENSION_PREFIX.length + 1))) registry.uninstall(extension);
	}
}

function createCustomTool(name: string, tool: CustomTool): ToolRegistration {
	return defineTool({
		name,
		description: tool.description,
		// TypeBox schemas are plain JSON schema objects, so a stored schema is one as far as Durable is concerned.
		parameters: tool.parameters as TSchema,
		// Not replay-safe, the default: a command that was interrupted may have had an effect, so it must come back to the
		// model as interrupted instead of being run again.
		execute: async (args, api, context) => {
			if (api.env === undefined) throw new Error("No execution environment is configured for custom tools.");
			const json = JSON.stringify(args);
			let stdout = "";
			let stderr = "";
			// pi-env's exec has no stdin, so the arguments travel in TOOL_ARGS and the shell pipes them into the command.
			// The command sees them on stdin, as AGENTS.md promises, and TOOL_ARGS stays available as a fallback. The
			// newline before the closing brace keeps a trailing comment in the command from swallowing it.
			const result = await api.env.exec(
				`printf '%s' "$TOOL_ARGS" | {\n${tool.command}\n}`,
				{
					env: { TOOL_ARGS: json },
					onOutput: (text, _context, info) => {
						if (info.stream === "stdout") stdout += text;
						else stderr += text;
					},
				},
				context,
			);
			if (!result.ok) return errorResult(`The command could not run: ${result.error.message}`);
			if (result.value.exitCode === 0) return textResult(stdout === "" ? "(no output)" : stdout);
			return errorResult(`The command exited with code ${result.value.exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		},
	});
}

export type CustomToolManagementOptions = {
	readonly registry: Registry;
};

// Model APIs restrict tool names to this shape, and an invalid name would make every request that offers the tool fail.
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const ParametersSchema = Type.Record(Type.String(), Type.Unknown(), {
	description:
		'A JSON schema object describing the arguments, for example {"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}. The type must be "object".',
});

/** The founder-only tools that define, change, and delete custom tools. */
export function createCustomToolManagementTools(options: CustomToolManagementOptions): readonly ToolRegistration[] {
	// Anything installed outside the custom tools owns its name: the coding tools, the supervisor tools (which include
	// these three), and the card tool. The custom extensions are skipped so a tool can be updated under its own name.
	const reservedName = (name: string): boolean =>
		options.registry
			.snapshot()
			.tools()
			.some(({ extension, tool }) => tool.name === name && !extension.name.startsWith(EXTENSION_PREFIX));

	// Every change ends in the same publication, so it lives here once: read the committed state back and install it.
	const publish = async (api: ToolExecutionApi, context: Context): Promise<void> => {
		const state = await api.snapshot(CustomToolsDoc, ROOT, context);
		installCustomTools(options.registry, state ?? { tools: {} });
	};

	return [
		defineTool({
			name: "define_tool",
			description:
				"Define a custom tool: a shell command that runs on the work VM. It receives the call's arguments as JSON on stdin (also in the TOOL_ARGS environment variable); its stdout is the result, and a non-zero exit code is an error. It can only do what bash on the VM can already do. The tool is available from your next request. roles lists the roles whose workers also get it.",
			parameters: Type.Object({
				name: Type.String({ description: "Lowercase letters, digits, and underscores, starting with a letter. Must not match an existing tool." }),
				description: Type.String({ description: "What the tool does and when to use it; this is what the model reads." }),
				parameters: ParametersSchema,
				command: Type.String({ description: "The shell command to run on the VM. Read the JSON arguments from stdin, for example with jq." }),
				roles: Type.Optional(Type.Array(Type.String(), { description: "Roles whose workers get the tool. Default none: founder only." })),
			}),
			execute: async (args, api, context) => {
				if (!NAME_PATTERN.test(args.name)) return errorResult(`Invalid name "${args.name}": use lowercase letters, digits, and underscores, starting with a letter.`);
				if (reservedName(args.name)) return errorResult(`"${args.name}" is the name of a built-in tool; choose another name.`);
				if (args.parameters.type !== "object") return errorResult('parameters must be a JSON schema with "type": "object".');
				const problem = await api.commit(async (tx): Promise<string | undefined> => {
					const tools = await tx.doc(CustomToolsDoc, ROOT);
					if (Object.hasOwn(tools.tools, args.name)) return `A tool named "${args.name}" already exists; use update_tool.`;
					const unknownRole = await findUnknownRole(tx, args.roles ?? []);
					if (unknownRole !== undefined) return unknownRole;
					tools.tools[args.name] = {
						description: args.description,
						parameters: args.parameters as JsonObject,
						command: args.command,
						roles: args.roles ?? [],
					};
					return undefined;
				}, context);
				if (problem !== undefined) return errorResult(problem);
				await publish(api, context);
				return textResult(`Defined tool "${args.name}". It is available from your next request.`);
			},
		}),
		defineTool({
			name: "update_tool",
			description: "Change a custom tool. Fields you leave out stay as they are. The change is available from your next request.",
			parameters: Type.Object({
				name: Type.String({ description: "The custom tool to change." }),
				description: Type.Optional(Type.String({ description: "The new description." })),
				parameters: Type.Optional(ParametersSchema),
				command: Type.Optional(Type.String({ description: "The new shell command." })),
				roles: Type.Optional(Type.Array(Type.String(), { description: "The new list of roles; it replaces the old one." })),
			}),
			execute: async (args, api, context) => {
				if (
					args.description === undefined &&
					args.parameters === undefined &&
					args.command === undefined &&
					args.roles === undefined
				) {
					return errorResult("Give at least one of description, parameters, command, or roles to update.");
				}
				if (args.parameters !== undefined && args.parameters.type !== "object") {
					return errorResult('parameters must be a JSON schema with "type": "object".');
				}
				const problem = await api.commit(async (tx): Promise<string | undefined> => {
					const tools = await tx.doc(CustomToolsDoc, ROOT);
					const tool = Object.hasOwn(tools.tools, args.name) ? tools.tools[args.name] : undefined;
					if (tool === undefined) return `No custom tool named "${args.name}".`;
					const unknownRole = await findUnknownRole(tx, args.roles ?? []);
					if (unknownRole !== undefined) return unknownRole;
					if (args.description !== undefined) tool.description = args.description;
					if (args.parameters !== undefined) tool.parameters = args.parameters as JsonObject;
					if (args.command !== undefined) tool.command = args.command;
					if (args.roles !== undefined) tool.roles = args.roles;
					return undefined;
				}, context);
				if (problem !== undefined) return errorResult(problem);
				await publish(api, context);
				return textResult(`Updated tool "${args.name}". It is available from your next request.`);
			},
		}),
		defineTool({
			name: "delete_tool",
			description: "Delete a custom tool. It is gone from your next request.",
			parameters: Type.Object({
				name: Type.String({ description: "The custom tool to delete." }),
			}),
			execute: async (args, api, context) => {
				const deleted = await api.commit(async (tx) => {
					const tools = await tx.doc(CustomToolsDoc, ROOT);
					if (!Object.hasOwn(tools.tools, args.name)) return false;
					delete tools.tools[args.name];
					return true;
				}, context);
				if (!deleted) return errorResult(`No custom tool named "${args.name}".`);
				await publish(api, context);
				return textResult(`Deleted tool "${args.name}".`);
			},
		}),
	];
}

// A role that does not exist would give a tool that no worker ever receives, with no sign why, so it is refused.
async function findUnknownRole(tx: Tx, roles: string[]): Promise<string | undefined> {
	const hired = await tx.doc(RolesDoc, ROOT);
	const unknown = roles.find((role) => !Object.hasOwn(hired.roles, role));
	return unknown === undefined ? undefined : `No role named "${unknown}"; hire it with hire_role first.`;
}

function textResult(text: string): { output: Array<{ type: "text"; text: string }> } {
	return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: Array<{ type: "text"; text: string }>; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
