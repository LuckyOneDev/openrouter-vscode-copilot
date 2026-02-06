import type {
	ChatStreamingResponseChunkData,
	Message,
	Model,
	PublicPricing,
	ToolDefinitionJson,
} from "@openrouter/sdk/models";
import * as vscode from "vscode";
import { MODEL_ID_PREFIX } from "./const";

export class OpenRouterAdapter {
	static readonly modelIdPrefix = MODEL_ID_PREFIX;

	/** OpenRouter Model → VSCode LanguageModelChatInformation */
	convertModelInformation(model: Model): vscode.LanguageModelChatInformation {
		return {
			id: MODEL_ID_PREFIX + model.id,
			name: model.name || model.id,
			family: model.id.split("/")[0] ?? "unknown",
			version: "latest",
			maxInputTokens: model.contextLength ?? 4096,
			maxOutputTokens: model.topProvider?.maxCompletionTokens ?? 4096,
			capabilities: {
				imageInput:
					model.architecture?.inputModalities?.includes("image") ?? false,
				toolCalling: model.supportedParameters?.includes("tools") ?? false,
			},
			tooltip: model.pricing ? this.formatPricing(model.pricing) : undefined,
		};
	}

	formatPricing(pricing: PublicPricing): string {
		const pricingDetails = [];
		for (const [key, value] of Object.entries(pricing)) {
			const formattedValue =
				typeof value === "number" ? value.toFixed(4) : (value ?? "N/A");
			pricingDetails.push(`${key}: ${formattedValue}`);
		}
		return pricingDetails.join(", ");
	}

	/** VSCode role → OpenRouter Message role */
	convertRole(role: vscode.LanguageModelChatMessageRole): Message["role"] {
		switch (role) {
			case vscode.LanguageModelChatMessageRole.User:
				return "user";
			case vscode.LanguageModelChatMessageRole.Assistant:
				return "assistant";
			default:
				return "system";
		}
	}

	/** VSCode messages → OpenRouter Message[] */
	vscodeMessagesToOpenRouter(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
	): Message[] {
		const out: Message[] = [];
		for (const msg of messages) {
			for (const element of msg.content) {
				if (element instanceof vscode.LanguageModelTextPart) {
					const role = this.convertRole(msg.role);
					if (role !== "tool") {
						out.push({ role, content: element.value } as Message);
					}
					continue;
				}
				if (element instanceof vscode.LanguageModelToolResultPart) {
					out.push({
						role: "tool",
						toolCallId: element.callId,
						content: JSON.stringify(element.content),
					});
					continue;
				}
				if (element instanceof vscode.LanguageModelToolCallPart) {
					out.push({
						role: "assistant",
						content: null,
						toolCalls: [
							{
								id: element.callId,
								type: "function",
								function: {
									name: element.name,
									arguments: JSON.stringify(element.input),
								},
							},
						],
					});
				}

				if (element instanceof vscode.LanguageModelDataPart) {
					let binaryString = "";
					element.data.forEach((byte) => {
						binaryString += String.fromCharCode(byte);
					});
					if (element.mimeType.startsWith("image/")) {
						out.push({
							role: this.convertRole(msg.role) as "user" | "assistant",
							content: [
								{
									type: "image_url",
									imageUrl: {
										url: `data:${element.mimeType};base64,${btoa(binaryString)}`,
										detail: "auto",
									},
								},
							],
						});
					}
				}
			}
		}
		return out;
	}

	/** VSCode tools → OpenRouter tools array */
	convertTools(
		tools: readonly vscode.LanguageModelChatTool[],
	): ToolDefinitionJson[] {
		return tools.map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description ?? "",
				parameters: t.inputSchema ?? {},
			},
		}));
	}

	/** Strip provider prefix from VSCode model id to get OpenRouter model id */
	getOpenRouterModelId(vscodeModelId: string): string {
		return vscodeModelId.startsWith(MODEL_ID_PREFIX)
			? vscodeModelId.slice(MODEL_ID_PREFIX.length)
			: vscodeModelId;
	}

	/** Process one stream chunk: report content/tool calls to progress, accumulate tool calls in map. Returns error message if chunk has error. */
	processStreamChunk(
		chunk: ChatStreamingResponseChunkData,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		toolCallsByIndex: Map<number, { id?: string; name?: string; args: string }>,
	): string | undefined {
		const err = chunk.error;
		if (err) return err.message ?? "OpenRouter stream error";
		const delta = chunk.choices?.[0]?.delta;
		if (!delta) return undefined;
		if (delta.content) {
			progress.report(new vscode.LanguageModelTextPart(delta.content));
		}
		const streamToolCalls = delta.toolCalls;
		if (streamToolCalls?.length) {
			for (const tc of streamToolCalls) {
				const idx = tc.index;
				const cur = toolCallsByIndex.get(idx) ?? { args: "" };
				if (tc.id != null) cur.id = tc.id;
				if (tc.function?.name != null) cur.name = tc.function.name;
				if (tc.function?.arguments != null) cur.args += tc.function.arguments;
				toolCallsByIndex.set(idx, cur);
			}
		}
		return undefined;
	}

	/** Report accumulated tool calls as VSCode parts to progress */
	reportToolCalls(
		toolCallsByIndex: Map<number, { id?: string; name?: string; args: string }>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): void {
		const sortedIndices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
		for (const idx of sortedIndices) {
			const cur = toolCallsByIndex.get(idx);
			if (cur?.id != null && cur?.name != null) {
				let input: object;
				try {
					input = JSON.parse(cur.args || "{}");
				} catch {
					input = { raw: cur.args };
				}
				progress.report(
					new vscode.LanguageModelToolCallPart(cur.id, cur.name, input),
				);
			}
		}
	}
}
