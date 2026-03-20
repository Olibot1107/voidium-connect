import * as vscode from "vscode"

import {getApiKey, getPanelUrl, getServerId, setApiKey, setServerId} from "./config"
import type {createLogger} from "./logger"
import {clearRuntimeState, type RuntimeState} from "./state"

const ONBOARDING_SHOWN_KEY = "pterodactyl-vsc.onboardingShown"

const makeOnboardingMessage = (needsApiKey: boolean, needsServer: boolean): string => {
	if (needsApiKey && needsServer) {
		return "You're almost ready to browse your Voidium Hosting files. Connect to your server by providing an API key and selecting a server."
	}
	if (needsApiKey) {
		return "Voidium needs your API key to connect. Provide it through the onboarding flow to unlock your remote files."
	}
	if (needsServer) {
		return "Select a server so the extension can show your remote files."
	}
	return "Open Voidium Hosting when you're ready to connect."
}

export const showOnboardingGuidance = async (
	context: vscode.ExtensionContext,
	options?: {force?: boolean}
): Promise<void> => {
	const force = options?.force ?? false
	const alreadyShown = context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY)
	if (!force && alreadyShown) {
		return
	}

	const apiKey = getApiKey()
	const serverId = getServerId()
	const needsApiKey = !apiKey
	const needsServer = Boolean(apiKey) && !serverId

	if (!needsApiKey && !needsServer && !force) {
		await context.globalState.update(ONBOARDING_SHOWN_KEY, true)
		return
	}

	const message = makeOnboardingMessage(needsApiKey, needsServer)
	const connectAction = "Connect now"
	const copyAction = "Copy panel URL"
	const items = [connectAction, copyAction]
	const selection = await vscode.window.showInformationMessage(message, {modal: false}, ...items)

	if (selection === connectAction) {
		void vscode.commands.executeCommand("pterodactyl-vsc.init")
	} else if (selection === copyAction) {
		await vscode.env.clipboard.writeText(getPanelUrl())
		void vscode.window.showInformationMessage("Panel URL copied to clipboard")
	}

	await context.globalState.update(ONBOARDING_SHOWN_KEY, true)
}

export const logoutOfVoidium = async (
	state: RuntimeState,
	log: ReturnType<typeof createLogger>
): Promise<void> => {
	const hasCredentials = Boolean(getApiKey() || getServerId())
	if (!hasCredentials) {
		void vscode.window.showInformationMessage("You're not signed in to Voidium Hosting.")
		return
	}

	const confirmation = await vscode.window.showWarningMessage(
		"Sign out of Voidium Hosting and remove the saved credentials?",
		{modal: true},
		"Sign out",
		"Cancel"
	)
	if (confirmation !== "Sign out") {
		return
	}

	await Promise.all([setApiKey(void 0), setServerId(void 0)])
	clearRuntimeState(state)
	if (vscode.workspace.workspaceFolders?.length) {
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders.length)
	}
	await vscode.commands.executeCommand("setContext", "pterodactyl-connected", false)
	log("Signed out of Voidium Hosting")
	void vscode.window.showInformationMessage("Signed out of Voidium Hosting. Use Open Voidium Server to reconnect.")
}
