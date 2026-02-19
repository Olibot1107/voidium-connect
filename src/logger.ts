import * as vscode from "vscode"

export const createLogger = (context: vscode.ExtensionContext) => {
	const outputChannel = vscode.window.createOutputChannel("Pterodactyl file system")
	context.subscriptions.push(outputChannel)

	return (message: string): void => {
		outputChannel.appendLine(message)
	}
}
