import OpenAI from "openai";
import * as vscode from "vscode";
import { OpenRouterAdapter } from "./adapter.js";
import { MODEL_ID_PREFIX, REPOSITORY } from "./const.js";

// Same API shape as Copilot Chat's OpenRouter BYOK provider (openRouterProvider.ts)
function getModelsBaseUrl(): string {
	return "https://openrouter.ai/api/v1";
}

function getModelsDiscoveryUrl(modelsBaseUrl: string): string {
	return `${modelsBaseUrl}/models`;
}

/** OpenRouter /models response item (see https://openrouter.ai/docs/api-reference/models) */
interface OpenRouterModelData {
	id: string;
	name: string;
	context_length?: number;
	supported_parameters?: string[];
	architecture?: { input_modalities?: string[] };
	top_provider?: { context_length?: number; max_completion_tokens?: number };
	pricing?: Record<string, unknown>;
}

interface ModelCapabilities {
	name: string;
	toolCalling: boolean;
	vision: boolean;
	maxInputTokens: number;
	maxOutputTokens: number;
}

function resolveModelCapabilities(modelData: unknown): ModelCapabilities | undefined {
	const m = modelData as OpenRouterModelData;
	if (!m?.id) return undefined;
	const contextLength = m.top_provider?.context_length ?? m.context_length ?? 0;
	const maxOut = m.top_provider?.max_completion_tokens ?? 16000;
	return {
		name: m.name ?? m.id,
		toolCalling: m.supported_parameters?.includes("tools") ?? false,
		vision: m.architecture?.input_modalities?.includes("image") ?? false,
		maxInputTokens: Math.max(0, contextLength - 16000),
		maxOutputTokens: maxOut,
	};
}

/** OpenRouter adds reasoning to delta; SDK types don't include it */
type DeltaWithReasoning = { reasoning?: string };

export type LanguageModelResponsePart2 =
	| vscode.LanguageModelResponsePart
	| vscode.LanguageModelDataPart
	| vscode.LanguageModelThinkingPart;

export class OpenRouterProvider implements vscode.LanguageModelChatProvider {
	private _cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private readonly adapter = new OpenRouterAdapter();

	constructor(private readonly secrets: vscode.SecretStorage) {}

	private async getApiKey(silent?: boolean): Promise<string | undefined> {
		let key = await this.secrets.get("openrouter.apiKey");
		if (!key && !silent) {
			key = await vscode.window.showInputBox({
				prompt: "Enter OpenRouter API key",
				password: true,
				ignoreFocusOut: true,
			});
			if (key) await this.secrets.store("openrouter.apiKey", key);
		}
		return key ?? undefined;
	}

	// LanguageModelChatProvider: same as Copilot BYOK OpenRouter
	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const silent = "silent" in options && options.silent === true;
		const apiKey = await this.getApiKey(silent);
		if (!apiKey && silent) return [];

		if (this._cachedModels) return this._cachedModels;

		const baseUrl = getModelsBaseUrl();
		const url = getModelsDiscoveryUrl(baseUrl);
		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const resp = await fetch(url, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"HTTP-Referer": REPOSITORY,
				"X-Title": "VS Code OpenRouter",
			},
			signal: controller.signal,
		});
		if (!resp.ok) throw new Error(`OpenRouter models ${resp.status}: ${await resp.text()}`);

		const data = (await resp.json()) as { data?: OpenRouterModelData[]; models?: OpenRouterModelData[] };
		const models = data.data ?? data.models ?? [];
		if (!Array.isArray(models)) throw new Error("Invalid OpenRouter models response");

		const list: vscode.LanguageModelChatInformation[] = [];
		for (const model of models) {
			const cap = resolveModelCapabilities(model);
			if (!cap) continue;
			list.push({
				id: MODEL_ID_PREFIX + model.id,
				name: cap.name,
				family: model.id.split("/")[0] ?? "unknown",
				version: "latest",
				maxInputTokens: cap.maxInputTokens,
				maxOutputTokens: cap.maxOutputTokens,
				capabilities: {
					imageInput: cap.vision,
					toolCalling: cap.toolCalling,
				},
			});
		}
		this._cachedModels = list;
		return this._cachedModels;
	}

	// LanguageModelChatProvider: stream chat completions (OpenAI-compatible endpoint)
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const apiKey = await this.getApiKey(false);
		if (!apiKey) throw new Error("API key required");

		const modelId = this.adapter.getOpenRouterModelId(model.id);
		let orMessages = this.adapter.vscodeMessagesToOpenRouter(messages);
		if (orMessages.length === 0) throw new Error("No messages to send.");

		const systemPromptOverride = vscode.workspace
			.getConfiguration("openrouter")
			.get<string>("systemPrompt")
			?.trim();
		if (systemPromptOverride) {
			orMessages = orMessages.filter((msg) => msg.role !== "system");
			orMessages.unshift({ role: "system", content: systemPromptOverride });
		}

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const openai = new OpenAI({
			apiKey,
			baseURL: getModelsBaseUrl(),
			defaultHeaders: { "HTTP-Referer": REPOSITORY, "X-Title": "VS Code OpenRouter" },
		});

		const tools = this.adapter.convertTools(options.tools ?? []);
		const stream = await openai.chat.completions.create(
			{
				model: modelId,
				messages: orMessages,
				stream: true,
				tool_choice: "auto",
				tools: tools.length > 0 ? tools : undefined,
				reasoning: { summary: "detailed" },
			} as Parameters<OpenAI["chat"]["completions"]["create"]>[0],
			{ signal: controller.signal },
		);

		let thinkingActive = false;
		let reportedText = false;
		let reportedToolCall = false;
		const toolCallAccum = new Map<number, { id: string; name: string; argsStr: string }>();

		const iterable = stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
		for await (const chunk of iterable) {
			for (const choice of chunk.choices ?? []) {
				const delta = choice.delta as typeof choice.delta & DeltaWithReasoning;
				if (!delta) continue;

				const reasoning = delta.reasoning;
				if (reasoning) {
					progress.report(new vscode.LanguageModelThinkingPart(reasoning, "", {}));
					thinkingActive = true;
				} else if (thinkingActive) {
					progress.report(new vscode.LanguageModelThinkingPart("", "", { vscode_reasoning_done: true }));
					thinkingActive = false;
				}

				if (delta.content?.trim()) {
					progress.report(new vscode.LanguageModelTextPart(delta.content));
					reportedText = true;
				}

				const toolCalls = delta.tool_calls;
				if (toolCalls?.length) {
					for (const toolCall of toolCalls) {
						const index = toolCall.index ?? 0;
						let acc = toolCallAccum.get(index);
						if (!acc) {
							acc = { id: "", name: "", argsStr: "" };
							toolCallAccum.set(index, acc);
						}
						if (toolCall.id != null && toolCall.id !== "") acc.id = toolCall.id;
						if (toolCall.function?.name != null && toolCall.function.name !== "") acc.name = toolCall.function.name;
						const argStr = toolCall.function?.arguments;
						if (argStr != null) acc.argsStr += argStr;

						let args: object;
						try {
							args = acc.argsStr.length > 0 ? (JSON.parse(acc.argsStr) as object) : {};
						} catch {
							continue;
						}
						progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, args));
						reportedToolCall = true;
					}
				}
			}
		}

		for (const acc of toolCallAccum.values()) {
			if (acc.argsStr.length === 0) continue;
			try {
				JSON.parse(acc.argsStr);
			} catch {
				progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, {}));
				reportedToolCall = true;
			}
		}

		if (thinkingActive) {
			progress.report(new vscode.LanguageModelThinkingPart("", "", { vscode_reasoning_done: true }));
		}

		if (!reportedText && !reportedToolCall) {
			progress.report(new vscode.LanguageModelTextPart(" "));
		}
	}

	// LanguageModelChatProvider
	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const content = typeof text === "string" ? text : JSON.stringify(text);
		return Math.ceil(content.length / 3);
	}
}
