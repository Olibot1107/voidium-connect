"use stricts"

import * as vscode from "vscode"

import {buildServerApiUrl, getPanelUrl, getServerId, setApiKey} from "./config"
import {PterodactylFileSystemProvider} from "./fsProvider"
import {createLogger} from "./logger"
import {PanelService} from "./panel"
import {createRuntimeState, clearRuntimeState, hydrateRuntimeState} from "./state"
import {StatusBarController} from "./statusBar"
import {PterodactylTreeDataProvider, PterodactylTreeDragAndDropController} from "./treeView"

const noop = (): void => {}

export const activate = (context: vscode.ExtensionContext): void => {
	const log = createLogger(context)
	log("Loading extension...")

	const state = createRuntimeState()
	hydrateRuntimeState(state)

	const statusBarController = new StatusBarController({state, log})
	let refreshTree = noop
	const panelService = new PanelService({
		state,
		log,
		onConnected: () => {
			refreshTree()
			statusBarController.requestRefresh()
		}
	})

	const fsProvider = new PterodactylFileSystemProvider({
		state,
		log,
		onAuthenticationFailed: () => {
			void setApiKey(void 0)
			state.authHeader = ""
			void panelService.addPanel().then(() => {
				statusBarController.requestRefresh()
			})
		}
	})
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider("pterodactyl", fsProvider, {isCaseSensitive: true}))

	const treeDataProvider = new PterodactylTreeDataProvider(fsProvider)
	refreshTree = (): void => {
		treeDataProvider.refresh()
	}

	const treeDragAndDropController = new PterodactylTreeDragAndDropController(fsProvider, treeDataProvider)
	const treeView = vscode.window.createTreeView("pterodactyl-explorer", {
		treeDataProvider,
		dragAndDropController: treeDragAndDropController,
		canSelectMany: true
	})
	context.subscriptions.push(treeView)

	if (state.serverApiUrl) {
		void vscode.commands.executeCommand("setContext", "pterodactyl-connected", true)
	}

	statusBarController.initialize(context)

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		log("Detected configuration change")
		if (event.affectsConfiguration("pterodactyl-vsc.panelUrl") || event.affectsConfiguration("pterodactyl-vsc.serverId")) {
			const panelUrl = getPanelUrl()
			const serverId = getServerId()
			if (!panelUrl || !serverId) {
				state.serverApiUrl = ""
				log("-> Missing panel URL or server ID, cleared server API URL")
			} else {
				state.serverApiUrl = buildServerApiUrl(panelUrl, serverId)
				log(`Setting server api URL to ${state.serverApiUrl}`)
			}
		}

		if (event.affectsConfiguration("pterodactyl-vsc.apiKey")) {
			const apiKey = vscode.workspace.getConfiguration("pterodactyl-vsc").get<string>("apiKey")
			state.authHeader = apiKey ? `Bearer ${apiKey}` : ""
		}

		statusBarController.requestRefresh()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.init", () => {
		void panelService.addPanel()
			.then(() => {
				statusBarController.requestRefresh()
			})
			.catch(error => {
				log(`Init command failed: ${String(error)}`)
				void vscode.window.showErrorMessage(`Failed to open server panel: ${String(error)}`)
			})
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.reset", () => {
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length || 0)
		clearRuntimeState(state)
		void vscode.commands.executeCommand("setContext", "pterodactyl-connected", false)

		log("Reset workspace")
		statusBarController.requestRefresh()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.refresh", () => {
		log("Refreshing workspace server files...")
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length || 0, {
			uri: vscode.Uri.parse("pterodactyl:/"),
			name: "Pterodactyl"
		})

		treeDataProvider.refresh()
		statusBarController.requestRefresh()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.startServer", () => {
		void statusBarController.sendPowerSignal("start")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.stopServer", () => {
		void statusBarController.sendPowerSignal("stop")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.restartServer", () => {
		void statusBarController.sendPowerSignal("restart")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.killServer", () => {
		void statusBarController.sendPowerSignal("kill")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.showPowerMenu", () => {
		void statusBarController.showPowerMenu()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.clearApiKey", () => {
		void setApiKey(void 0)
		state.authHeader = ""
		log("API key cleared")
		void vscode.window.showInformationMessage("API key has been cleared")
		statusBarController.requestRefresh()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.openPanel", () => {
		const panelUrl = getPanelUrl()
		const serverId = getServerId()
		if (!panelUrl || !serverId) {
			void vscode.window.showErrorMessage("Panel URL or server ID not configured")
			return
		}

		const serverUrl = `${panelUrl}/server/${serverId}`
		void vscode.env.openExternal(vscode.Uri.parse(serverUrl))
	}))
}
