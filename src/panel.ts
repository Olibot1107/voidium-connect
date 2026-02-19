import * as vscode from "vscode"

import {buildServerApiUrl, getPanelUrl, proxyUrl, setApiKey, setPanelUrl, setServerId} from "./config"
import type {createLogger} from "./logger"
import {connectRuntimeState, type RuntimeState} from "./state"

interface PanelErrorResponse {
	errors: Array<{
		detail: string
	}>
}

interface PanelServer {
	attributes: {
		name: string
		identifier: string
		description?: string
		uuid?: string
	}
}

interface PanelServersResponse {
	data: PanelServer[]
}

interface ServerOption extends vscode.QuickPickItem {
	server: PanelServer
}

interface PanelServiceDependencies {
	state: RuntimeState
	log: ReturnType<typeof createLogger>
	onConnected: () => void
}

const isValidApiKey = (value: string): boolean => /^[A-Za-z0-9_]{32,128}$/.test(value)

export class PanelService {
	private readonly state: RuntimeState
	private readonly log: ReturnType<typeof createLogger>
	private readonly onConnected: () => void

	public constructor(deps: PanelServiceDependencies) {
		this.state = deps.state
		this.log = deps.log
		this.onConnected = deps.onConnected
	}

	public async addPanel(): Promise<void> {
		try {
			const panelUrl = getPanelUrl()
			await setPanelUrl(panelUrl)

			let apiKey = vscode.workspace.getConfiguration("pterodactyl-vsc").get<string>("apiKey")
			if (!apiKey) {
				apiKey = await vscode.window.showInputBox({
					prompt: "Enter your Pterodactyl API key",
					placeHolder: "Enter your Pterodactyl panel client API key here...",
					validateInput: (value: string): string | undefined => {
						const normalized = value.trim()
						if (!normalized) {
							return "Enter a valid API key"
						}
						if (isValidApiKey(normalized)) {
							return void 0
						}
						return "Invalid API key format"
					},
					password: true
				})

				const normalizedApiKey = apiKey?.trim()
				if (!normalizedApiKey || !isValidApiKey(normalizedApiKey)) {
					void vscode.window.showErrorMessage("Invalid API key format")
					return
				}
				apiKey = normalizedApiKey
			}

			const parsedPanelUrl = vscode.Uri.parse(panelUrl)
			const panelRootUrl = `${parsedPanelUrl.scheme}://${parsedPanelUrl.authority}`
			this.log(`Connecting to ${panelRootUrl}...`)

			let response: Response
			try {
				response = await fetch(proxyUrl(`${panelRootUrl}/api/client/`), {
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${apiKey}`
					}
				})
			} catch (error) {
				this.log(String(error))
				void vscode.window.showErrorMessage(`Failed to connect to the provided address: ${String(error)}`)
				return
			}

			this.log(`Connection response: ${response.status} ${response.statusText}`)
			if (!response.ok) {
				const text = await response.text()
				try {
					const json = JSON.parse(text) as PanelErrorResponse
					this.log(JSON.stringify(json, null, "\t"))
					void vscode.window.showErrorMessage(`Failed to connect to the Pterodactyl panel (${response.status}): ${json.errors[0]?.detail ?? "Unknown error"}`)
					return
				} catch {
					this.log(text)
					const shortText = text.substring(0, 50)
					void vscode.window.showErrorMessage(`Failed to connect to the Pterodactyl panel (${response.status}): ${shortText}${text.length > 50 ? "..." : ""}`)
					return
				}
			}

			const json = await response.json() as PanelServersResponse
			await setApiKey(apiKey)
			this.log(`Connected successfully, ${json.data.length} servers found`)

			const selectedServer = await vscode.window.showQuickPick(
				json.data.map(server => ({
					label: server.attributes.name,
					description: server.attributes.identifier,
					detail: server.attributes.description,
					server
				} as ServerOption)),
				{placeHolder: "Select a server to load into VS Code..."}
			)

			if (!selectedServer) {
				this.log("User cancelled server selection")
				return
			}

			const server = selectedServer.server
			connectRuntimeState(this.state, panelRootUrl, server.attributes.identifier, apiKey)
			this.log(`Using server identifier: ${server.attributes.identifier}`)
			this.log(`Setting server api URL to ${buildServerApiUrl(panelRootUrl, server.attributes.identifier)}`)

			await Promise.all([
				setPanelUrl(panelRootUrl),
				setServerId(server.attributes.identifier)
			])

			const workspaceName = `Pterodactyl - ${server.attributes.name}`
			this.log(`Setting workspace name to: ${workspaceName}`)
			vscode.workspace.updateWorkspaceFolders(0, 0, {
				uri: vscode.Uri.parse("pterodactyl:/"),
				name: workspaceName
			})

			await vscode.commands.executeCommand("setContext", "pterodactyl-connected", true)
			this.onConnected()
		} catch (error) {
			this.log(`Unexpected addPanel error: ${String(error)}`)
			void vscode.window.showErrorMessage(`Unexpected error while connecting: ${String(error)}`)
		}
	}
}
