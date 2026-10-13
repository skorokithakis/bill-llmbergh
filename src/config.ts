import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

export type Config = {
	readonly models: {
		readonly founder: ModelRef;
		readonly defaultWorker: ModelRef;
		readonly advisorAnthropic: ModelRef;
		readonly advisorOpenAI: ModelRef;
	};
	/** The one provider that is not a pi-ai built-in: DeepSeek served by Ollama Cloud. */
	readonly ollamaCloudBaseUrl: string;
	readonly heartbeatIntervalMinutes: number;
	readonly maxParallelWorkers: number;
	readonly advisorCallsPerDay: number;
	readonly dailyCostCapUsd: number;
	readonly vm: { readonly host: string; readonly user: string };
	readonly telegram: { readonly ownerUserId: number };
};

export type Secrets = {
	readonly ollamaApiKey: string;
	readonly telegramBotToken: string;
	readonly card: {
		readonly number: string;
		readonly expiry: string;
		readonly cvc: string;
		readonly name: string;
	};
};

const REQUIRED_KEYS = [
	"models",
	"ollamaCloudBaseUrl",
	"heartbeatIntervalMinutes",
	"maxParallelWorkers",
	"advisorCallsPerDay",
	"dailyCostCapUsd",
	"vm",
	"telegram",
] as const;

export function loadConfig(path: string = resolve(process.env.DATA_DIR ?? "/data", "config.json")): Config {
	if (!existsSync(path)) {
		throw new Error(`config file ${path} is missing; copy config.example.json there and fill it in`);
	}
	const config = JSON.parse(readFileSync(path, "utf8")) as Config;
	for (const key of REQUIRED_KEYS) {
		if ((config as Record<string, unknown>)[key] === undefined) throw new Error(`config.json is missing "${key}"`);
	}
	requireModel("models.founder", config.models.founder);
	requireModel("models.defaultWorker", config.models.defaultWorker);
	requireModel("models.advisorAnthropic", config.models.advisorAnthropic);
	requireModel("models.advisorOpenAI", config.models.advisorOpenAI);
	requirePositiveNumber("heartbeatIntervalMinutes", config.heartbeatIntervalMinutes);
	requirePositiveNumber("maxParallelWorkers", config.maxParallelWorkers);
	requirePositiveNumber("advisorCallsPerDay", config.advisorCallsPerDay);
	requirePositiveNumber("dailyCostCapUsd", config.dailyCostCapUsd);
	if (!Number.isInteger(config.telegram.ownerUserId)) {
		throw new Error("config.json: telegram.ownerUserId must be an integer");
	}
	return config;
}

function requireModel(field: string, model: unknown): void {
	const ref = model as { provider?: unknown; modelId?: unknown } | undefined;
	const filled = (value: unknown): boolean => typeof value === "string" && value !== "";
	if (ref === undefined || !filled(ref.provider) || !filled(ref.modelId)) {
		throw new Error(`config.json: ${field} needs a non-empty provider and modelId`);
	}
}

function requirePositiveNumber(field: string, value: unknown): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`config.json: ${field} must be a number greater than zero`);
	}
}

// Read at startup so a missing secret fails the process before it connects to anything, rather than
// surfacing as a confusing provider error on the first model call.
export function loadSecrets(): Secrets {
	return {
		ollamaApiKey: requireEnv("OLLAMA_API_KEY"),
		telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
		card: {
			number: requireEnv("CARD_NUMBER"),
			expiry: requireEnv("CARD_EXPIRY"),
			cvc: requireEnv("CARD_CVC"),
			name: requireEnv("CARD_NAME"),
		},
	};
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`environment variable ${name} is required`);
	return value;
}
