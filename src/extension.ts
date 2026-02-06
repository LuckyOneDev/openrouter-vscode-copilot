import * as vscode from "vscode";
import { OpenRouterProvider } from "./provider";

export function activate(ctx: vscode.ExtensionContext) {
	const provider = new OpenRouterProvider(ctx.secrets);

	ctx.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(
			"luckyone.openrouter",
			provider,
		),
		vscode.commands.registerCommand("openrouter.manage", async () => {
			await ctx.secrets.delete("openrouter.apiKey");
			vscode.window.showInformationMessage("OpenRouter API key cleared.");
		}),
	);
}

export function deactivate() {}
