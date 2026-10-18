import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

// Web search and page fetch through Ollama's web API, for the founder and every worker. They run in the container
// because they need the owner's OLLAMA_API_KEY, which must never reach the VM or a tool result. Both are read-only,
// so they carry no notice, no counter, and no per-role switch: any agent may look something up.
const SEARCH_URL = "https://ollama.com/api/web_search";
const FETCH_URL = "https://ollama.com/api/web_fetch";

// One page of results or one page's text is far more than a useful tool result; the cap keeps a search from filling
// the model's context. The output says so when it was cut, so the agent knows the result ends there.
const MAX_OUTPUT_CHARS = 20_000;
// The error body is shown as an excerpt: enough to name the problem, not enough to flood the result.
const MAX_ERROR_EXCERPT_CHARS = 500;
// A hung request would block the tool (and its worker) indefinitely, so every call is bounded.
const REQUEST_TIMEOUT_MS = 60_000;

export function createWebExtension(apiKey: string): Extension {
	return defineExtension({
		name: "web",
		tools: [
			defineTool({
				name: "web_search",
				description:
					"Search the web with Ollama's web search API. Returns up to max_results pages with a title, URL, and content snippet each, as text.",
				parameters: Type.Object({
					query: Type.String({ description: "The search query." }),
					max_results: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: 10,
							description: "How many results to return, from 1 to 10. Default 5.",
						}),
					),
				}),
				execute: async (args, _api, context) => {
					const response = await postJson(SEARCH_URL, apiKey, { query: args.query, max_results: args.max_results }, context);
					if (!response.ok) return errorResult(response.error);
					const results = parseSearchResults(response.value);
					if (results === undefined) return errorResult("Ollama returned an unexpected web_search response.");
					if (results.length === 0) return textResult("No results.");
					const text = results
						.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.content}`)
						.join("\n\n");
					return textResult(clipped(text));
				},
			}),
			defineTool({
				name: "web_fetch",
				description:
					"Fetch one web page through Ollama's web fetch API. Returns the page's title, its main content as markdown, and the links found on it, as text.",
				parameters: Type.Object({
					url: Type.String({ description: "The URL of the page to fetch." }),
				}),
				execute: async (args, _api, context) => {
					const response = await postJson(FETCH_URL, apiKey, { url: args.url }, context);
					if (!response.ok) return errorResult(response.error);
					const page = parsePage(response.value);
					if (page === undefined) return errorResult("Ollama returned an unexpected web_fetch response.");
					const parts: string[] = [];
					if (page.title !== "") parts.push(`Title: ${page.title}`);
					parts.push(`Content:\n${page.content}`);
					if (page.links.length > 0) parts.push(`Links:\n${page.links.map((link) => `- ${link}`).join("\n")}`);
					return textResult(clipped(parts.join("\n\n")));
				},
			}),
		],
	});
}

type ApiResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

// Non-2xx responses and network failures become error results rather than exceptions, so the model sees what went
// wrong and can try something else. The API key is only ever sent in the header, never repeated in the result.
async function postJson(url: string, apiKey: string, body: object, context: Context): Promise<ApiResult> {
	// /stop, the cost cap, and shutdown abort the tool call, which aborts the request with it.
	const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
	if (context.abortSignal !== undefined) signals.push(context.abortSignal);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any(signals),
		});
		const text = await response.text();
		if (!response.ok) {
			const excerpt = oneLine(text).slice(0, MAX_ERROR_EXCERPT_CHARS);
			const status = response.statusText === "" ? `${response.status}` : `${response.status} ${response.statusText}`;
			return { ok: false, error: `Ollama returned ${status}${excerpt === "" ? "." : `: ${excerpt}`}` };
		}
		try {
			return { ok: true, value: JSON.parse(text) as unknown };
		} catch {
			return { ok: false, error: "Ollama returned a response that was not JSON." };
		}
	} catch (error) {
		// /stop, the cost cap, and shutdown cancel the call itself; let the cancellation propagate instead of
		// reporting a failure the model should react to.
		if (context.abortSignal?.aborted === true) throw error;
		if (error instanceof Error && error.name === "TimeoutError") {
			return { ok: false, error: `The request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.` };
		}
		return { ok: false, error: `The request to Ollama failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

type SearchResult = { readonly title: string; readonly url: string; readonly content: string };

function parseSearchResults(value: unknown): readonly SearchResult[] | undefined {
	if (!isRecord(value) || !Array.isArray(value.results)) return undefined;
	return value.results.filter(isRecord).map((result) => ({
		title: textField(result.title),
		url: textField(result.url),
		content: textField(result.content),
	}));
}

type Page = { readonly title: string; readonly content: string; readonly links: readonly string[] };

function parsePage(value: unknown): Page | undefined {
	if (!isRecord(value)) return undefined;
	if (!("content" in value) && !("title" in value) && !("links" in value)) return undefined;
	const links = Array.isArray(value.links) ? value.links.filter((link): link is string => typeof link === "string") : [];
	return { title: textField(value.title), content: textField(value.content), links };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function clipped(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[cut: the result is longer than ${MAX_OUTPUT_CHARS} characters; only the first ${MAX_OUTPUT_CHARS} are shown]`;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function textResult(text: string): { output: Array<{ type: "text"; text: string }> } {
	return { output: [{ type: "text", text }] };
}

function errorResult(text: string): { output: Array<{ type: "text"; text: string }>; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
