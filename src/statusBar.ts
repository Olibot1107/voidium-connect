import * as vscode from "vscode"

import {getPanelUrl, getServerId, proxyUrl} from "./config"
import type {createLogger} from "./logger"
import type {RuntimeState} from "./state"

interface StatusBarDependencies {
	state: RuntimeState
	log: ReturnType<typeof createLogger>
}

interface PowerResponse {
	errors: Array<{
		detail: string
	}>
}

interface ResourceStateResponse {
	attributes: {
		current_state: string
	}
}

export class StatusBarController {
	private readonly statusBarItem: vscode.StatusBarItem
	private readonly openButtonItem: vscode.StatusBarItem
	private readonly state: RuntimeState
	private readonly log: ReturnType<typeof createLogger>
	private refreshInFlight = false
	private refreshQueued = false
	private refreshInterval: ReturnType<typeof globalThis.setInterval> | undefined

	public constructor(deps: StatusBarDependencies) {
		this.state = deps.state
		this.log = deps.log
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
		this.openButtonItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
	}

	public initialize(context: vscode.ExtensionContext): void {
		context.subscriptions.push(this.statusBarItem)
		context.subscriptions.push(this.openButtonItem)

		this.requestRefresh()
		this.refreshInterval = globalThis.setInterval(() => {
			this.requestRefresh()
		}, 5000)

		context.subscriptions.push({
			dispose: (): void => {
				if (this.refreshInterval) {
					globalThis.clearInterval(this.refreshInterval)
				}
			}
		})
	}

	public requestRefresh(): void {
		if (this.refreshInFlight) {
			this.refreshQueued = true
			return
		}

		this.refreshInFlight = true
		void this.refresh().finally(() => {
			this.refreshInFlight = false
			if (this.refreshQueued) {
				this.refreshQueued = false
				setTimeout(() => {
					this.requestRefresh()
				}, 250)
			}
		})
	}

	public async sendPowerSignal(signal: string): Promise<void> {
		if (!this.state.serverApiUrl || !this.state.authHeader) {
			void vscode.window.showErrorMessage("No server connected")
			return
		}

		const panelUrl = getPanelUrl()
		const serverId = getServerId()
		if (!panelUrl || !serverId) {
			void vscode.window.showErrorMessage("Server configuration incomplete")
			return
		}

		const powerUrl = `${panelUrl}/api/client/servers/${serverId}/power`

		try {
			const response = await fetch(proxyUrl(powerUrl), {
				method: "POST",
				headers: {
					Authorization: this.state.authHeader,
					"Content-Type": "application/json",
					Accept: "application/vnd.pterodactyl.v1+json"
				},
				body: JSON.stringify({signal})
			})

			if (response.status === 204) {
				void vscode.window.showInformationMessage(`Server ${signal} command sent successfully`)
				setTimeout(() => {
					this.requestRefresh()
				}, 750)
				return
			}

			const error = await response.json() as PowerResponse
			void vscode.window.showErrorMessage(`Failed to ${signal} server: ${error.errors[0]?.detail ?? "Unknown error"}`)
		} catch (error) {
			void vscode.window.showErrorMessage(`Failed to ${signal} server: ${String(error)}`)
		}
	}

	public async showPowerMenu(): Promise<void> {
		const items = [
			{label: "Start Server", description: "Start the server", action: "start"},
			{label: "Stop Server", description: "Stop the server gracefully", action: "stop"},
			{label: "Restart Server", description: "Restart the server", action: "restart"},
			{label: "Kill Server", description: "Force kill the server", action: "kill"}
		]

		const selected = await vscode.window.showQuickPick(items, {placeHolder: "Select a power action"})
		if (selected) {
			await this.sendPowerSignal(selected.action)
		}
	}

	private async refresh(): Promise<void> {
		if (!this.state.serverApiUrl || !this.state.authHeader) {
			this.statusBarItem.text = "No Server"
			this.statusBarItem.tooltip = "No server connected"
			this.statusBarItem.command = "pterodactyl-vsc.init"
			this.statusBarItem.show()
			this.openButtonItem.hide()
			return
		}

		const panelUrl = getPanelUrl()
		const serverId = getServerId()
		if (!panelUrl || !serverId) {
			this.statusBarItem.text = "Config Error"
			this.statusBarItem.tooltip = "Server configuration incomplete"
			this.statusBarItem.command = "pterodactyl-vsc.init"
			this.statusBarItem.show()
			this.openButtonItem.hide()
			return
		}

		this.openButtonItem.text = "Open Server on Panel"
		this.openButtonItem.tooltip = "Open server in panel"
		this.openButtonItem.command = "pterodactyl-vsc.openPanel"
		this.openButtonItem.show()

		const resourcesUrl = `${panelUrl}/api/client/servers/${serverId}/resources`
		try {
			const response = await fetch(proxyUrl(resourcesUrl), {
				headers: {
					Authorization: this.state.authHeader,
					Accept: "application/json"
				}
			})
			if (!response.ok) {
				throw new Error(`Resources request failed with ${response.status}`)
			}

			const data = await response.json() as ResourceStateResponse
			let state = data.attributes.current_state
			if (state === "starting") {
				state = "running"
			}

			const titleState = `${state.charAt(0).toUpperCase()}${state.slice(1)}`
			this.statusBarItem.text = titleState
			this.statusBarItem.tooltip = `Server Status: ${state}\nClick to show power menu`
			this.statusBarItem.command = "pterodactyl-vsc.showPowerMenu"
			this.statusBarItem.show()
		} catch (error) {
			this.log(`Status refresh failed: ${String(error)}`)
			this.statusBarItem.text = "Offline"
			this.statusBarItem.tooltip = "Unable to connect to server"
			this.statusBarItem.command = "pterodactyl-vsc.init"
			this.statusBarItem.show()
		}
	}
}
