import * as vscode from "vscode";
import { OpenRouter } from "@openrouter/sdk";
import { PublicPricing } from "@openrouter/sdk/models";

const MODEL_ID_PREFIX = "vscode-openrouter/";

export class OpenRouterProvider implements vscode.LanguageModelChatProvider {
  private _cachedModels: vscode.LanguageModelChatInformation[] | undefined;

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

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (this._cachedModels) return this.filterModels(this._cachedModels);

    const apiKey = await this.getApiKey();
    const openRouter = new OpenRouter({ apiKey });
    const { data } = await openRouter.models.list({
      httpReferer: "https://github.com/openrouter-vscode",
      xTitle: "VS Code OpenRouter",
    });

    this._cachedModels = data.map((m) => ({
      id: MODEL_ID_PREFIX + m.id,
      name: m.name || m.id,
      family: m.id.split("/")[0] ?? "unknown",
      version: "latest",
      maxInputTokens: m.contextLength ?? 4096,
      maxOutputTokens: m.topProvider?.maxCompletionTokens ?? 4096,
      capabilities: {
        imageInput: m.architecture?.inputModalities?.includes("image") ?? false,
        toolCalling: m.supportedParameters?.includes("tools") ?? false,
      },
      tooltip: m.pricing ? this.formatPricing(m.pricing) : undefined,
    }));

    return this.filterModels(this._cachedModels);
  }

  private formatPricing(pricing: PublicPricing): string {
    let pricingDetails = [];
    for (const [key, value] of Object.entries(pricing)) {
      let formattedValue: string;
      if (typeof value === "number") {
        formattedValue = value.toFixed(4);
      } else {
        formattedValue = value ?? "N/A";
      }
      pricingDetails.push(`${key}: ${formattedValue}`);
    }
    return pricingDetails.join(", ");
  }

  private filterModels(
    models: vscode.LanguageModelChatInformation[],
  ): vscode.LanguageModelChatInformation[] {
    const filter =
      vscode.workspace
        .getConfiguration("openrouter")
        .get<string[]>("modelFilter") || [];
    return filter.length > 0
      ? models.filter((m) =>
          filter.some((f) => m.id === f || m.id === MODEL_ID_PREFIX + f),
        )
      : models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      const apiKey = await this.getApiKey();
      const openRouter = new OpenRouter({ apiKey });
      const cleanModelId = model.id.startsWith(MODEL_ID_PREFIX)
        ? model.id.slice(MODEL_ID_PREFIX.length)
        : model.id;

      let orMessages = messages
        .map((m) => {
          const role =
            m.role === vscode.LanguageModelChatMessageRole.Assistant
              ? "assistant"
              : m.role === vscode.LanguageModelChatMessageRole.User
                ? "user"
                : "system";
          const content = m.content
            .map((p: unknown) =>
              p && typeof p === "object" && "value" in p
                ? String((p as { value: string }).value ?? "")
                : "",
            )
            .join("");
          return { role, content } as {
            role: "user" | "assistant" | "system";
            content: string;
          };
        })
        .filter((m) => m.content.length > 0);

      const systemPromptOverride = vscode.workspace
        .getConfiguration("openrouter")
        .get<string>("systemPrompt")
        ?.trim();
      if (systemPromptOverride) {
        const firstSystemIdx = orMessages.findIndex((m) => m.role === "system");
        if (firstSystemIdx >= 0) {
          orMessages = orMessages.map((m, i) =>
            i === firstSystemIdx ? { ...m, content: systemPromptOverride } : m,
          );
        } else {
          orMessages = [
            { role: "system" as const, content: systemPromptOverride },
            ...orMessages,
          ];
        }
      }

      if (orMessages.length === 0) {
        throw new Error("No messages to send.");
      }

      const result = await openRouter.chat.send({
        xTitle: "VS Code OpenRouter",
        httpReferer: "https://github.com/openrouter-vscode",
        chatGenerationParams: {
          model: cleanModelId,
          stream: true,
          messages: orMessages,
          provider: { sort: "price" },
        },
      });

      for await (const chunk of result) {
        if (token.isCancellationRequested) break;
        const err = (chunk as { error?: { message?: string } }).error;
        if (err) {
          throw new Error(err.message ?? "OpenRouter stream error");
        }
        const delta = (
          chunk as { choices?: Array<{ delta?: { content?: string } }> }
        ).choices?.[0]?.delta?.content;
        if (delta) {
          progress.report(new vscode.LanguageModelTextPart(delta));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isParseError =
        msg.includes("transform") ||
        msg.includes("parse") ||
        msg.includes("ZodError") ||
        msg.includes("validation");
      throw new Error(
        isParseError
          ? "OpenRouter returned an unexpected response. Check your API key, model, and try again."
          : msg,
      );
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const content = typeof text === "string" ? text : JSON.stringify(text);
    return Math.ceil(content.length / 3);
  }
}
