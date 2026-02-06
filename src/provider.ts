import { OpenRouter } from "@openrouter/sdk";
import { EventStream } from "@openrouter/sdk/lib/event-streams.js";
import type { ChatGenerationParams } from "@openrouter/sdk/models";
import { ChatError } from "@openrouter/sdk/models/errors";
import * as vscode from "vscode";
import { OpenRouterAdapter } from "./adapter.js";
import { REPOSITORY } from "./const.js";

export class OpenRouterProvider implements vscode.LanguageModelChatProvider {
	private _cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private readonly adapter = new OpenRouterAdapter();

	constructor(private readonly secrets: vscode.SecretStorage) {}

	private async getApiKey(): Promise<string> {
		let key = await this.secrets.get("openrouter.apiKey");
		if (!key) {
			key = await vscode.window.showInputBox({
				prompt: "Enter OpenRouter API key",
				password: true,
				ignoreFocusOut: true,
			});
			if (!key) throw new Error("API key required");
			await this.secrets.store("openrouter.apiKey", key);
		}
		return key;
	}

	// @inheritdoc
	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (this._cachedModels) return this._cachedModels;
		const apiKey = await this.getApiKey();
		const openRouter = new OpenRouter({ apiKey });
		const { data } = await openRouter.models.list({
			httpReferer: REPOSITORY,
			xTitle: "VS Code OpenRouter",
		});
		this._cachedModels = data.map((m) =>
			this.adapter.convertModelInformation(m),
		);
		return this._cachedModels;
	}

	// @inheritdoc
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		try {
			const apiKey = await this.getApiKey();
			const openRouter = new OpenRouter({ apiKey });
			const modelId = this.adapter.getOpenRouterModelId(model.id);

			let orMessages = this.adapter.vscodeMessagesToOpenRouter(messages);
			if (orMessages.length === 0) {
				throw new Error("No messages to send.");
			}

			const systemPromptOverride = vscode.workspace
				.getConfiguration("openrouter")
				.get<string>("systemPrompt")
				?.trim();

			if (systemPromptOverride) {
				orMessages = orMessages.filter((msg) => msg.role !== "system");
				orMessages.unshift({ role: "system", content: systemPromptOverride });
			}

			const chatGenerationParams: ChatGenerationParams = {
				model: modelId,
				messages: orMessages,
				stream: true,
				toolChoice: "auto",
				tools: this.adapter.convertTools(options.tools ?? []),
				reasoning: {
					summary: "detailed",
				},
			};

			const controller = new AbortController();
			token.onCancellationRequested(() => {
				controller.abort();
			});

			const resp = await openRouter.chat.send(
				{
					xTitle: "VS Code OpenRouter",
					httpReferer: REPOSITORY,
					chatGenerationParams,
				},
				{
					signal: controller.signal,
				},
			);

			if (resp instanceof EventStream) {
				for await (const chunk of resp) {
					if (chunk.error) {
						throw new Error(chunk.error.message);
					}

					for (const element of chunk.choices) {
						if (element.delta?.content) {
							const part = new vscode.LanguageModelTextPart(
								element.delta.content,
							);
							progress.report(part);
						}
						if (element.delta.toolCalls) {
							for (const toolCall of element.delta.toolCalls) {
								const part = new vscode.LanguageModelToolCallPart(
									toolCall.id ?? "",
									toolCall.function?.name ?? "",
									JSON.parse(toolCall.function?.arguments ?? "{}"),
								);
								progress.report(part);
							}
						}
						if (element.delta.reasoning) {
							// TODO: correctly handle reasoning
							const part = new vscode.LanguageModelTextPart(
								`reasoning: ${element.delta.reasoning}`,
							);
							progress.report(part);
						}
					}

					// Final chunk includes usage stats
					if (chunk.usage) {
						console.log("Usage:", chunk.usage);
					}
				}
			} else {
				// TODO: Handle non-streaming response if needed
			}
		} catch (err) {
			if (err instanceof ChatError) {
				throw new Error(`OpenRouter API Error:\n${err.body}`);
			}
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(msg);
		}
	}

	// @inheritdoc
	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
	): Promise<number> {
		const content = typeof text === "string" ? text : JSON.stringify(text);
		return Math.ceil(content.length / 3);
	}
}
