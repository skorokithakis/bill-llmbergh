import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	createModels,
	createProvider,
	envApiKeyAuth,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Config } from "./config.ts";

/**
 * pi-ai's default credential store is in-memory. The owner logs in to the advisor subscriptions once,
 * on their own machine, and copies the resulting `auth.json` to the data directory; this store reads
 * and rewrites that file so the OAuth refresh `Models` performs under the store lock survives restarts.
 */
export class FileCredentialStore implements CredentialStore {
	#queue: Promise<unknown> = Promise.resolve();
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await this.#load())[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.#load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#serialized(async () => {
			const credentials = await this.#load();
			const current = credentials[providerId];
			const next = await fn(current);
			if (next === undefined) return current;
			credentials[providerId] = next;
			await this.#save(credentials);
			return next;
		});
	}

	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		await this.#serialized(async () => {
			const credentials = await this.#load();
			delete credentials[providerId];
			await this.#save(credentials);
		});
	}

	// `modify` must be a serialized read-modify-write, and a failed write must not poison later ones.
	#serialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(operation, operation);
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async #load(): Promise<Record<string, Credential>> {
		try {
			return JSON.parse(await readFile(this.#path, "utf8")) as Record<string, Credential>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	async #save(credentials: Record<string, Credential>): Promise<void> {
		const directory = dirname(this.#path);
		await mkdir(directory, { recursive: true });
		// A crash between write and rename must not leave a truncated file that loses both advisors'
		// credentials, so write a sibling temporary file and rename it into place. Mode 0o600 keeps the
		// refresh tokens private.
		const temporary = `${this.#path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(credentials, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, this.#path);
	}
}

export function createCompanyModels(config: Config, authFilePath: string): MutableModels {
	const models = createModels({ credentials: new FileCredentialStore(authFilePath) });
	models.setProvider(ollamaCloudProvider(config));
	models.setProvider(anthropicProvider());
	models.setProvider(openaiProvider());
	return models;
}

// The owner's key is an Ollama Cloud key, not a DeepSeek one, so this replaces pi-ai's built-in
// `deepseek` provider. The provider id stays `deepseek` because that is what the config's model
// references and the stored agent documents use. The catalog model carries its own `baseUrl`
// (api.deepseek.com) that overrides the provider's, so it is set on the model object too.
function ollamaCloudProvider(config: Config): Provider {
	const builtin = deepseekProvider();
	const pricing = builtin.getModels().find((model) => model.id === "deepseek-flash");
	if (pricing === undefined) {
		throw new Error("pi-ai's DeepSeek catalog no longer lists deepseek-flash, so its pricing cannot be copied");
	}
	return createProvider({
		id: "deepseek",
		name: "DeepSeek via Ollama Cloud",
		baseUrl: config.ollamaCloudBaseUrl,
		auth: { apiKey: envApiKeyAuth("Ollama Cloud API key", ["OLLAMA_API_KEY"]) },
		models: [
			{
				...pricing,
				id: config.models.founder.modelId,
				baseUrl: config.ollamaCloudBaseUrl,
				compat: { ...pricing.compat, supportsDeveloperRole: false },
			},
		],
		api: openAICompletionsApi(),
	});
}
