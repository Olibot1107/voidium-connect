import * as vscode from "vscode"

const CONFIG_SECTION = "pterodactyl-vsc"
const HARD_CODED_PANEL_URL = "https://voidium.uk"

const getConfig = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CONFIG_SECTION)
const hasWorkspace = (): boolean => Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length)
const getUpdateTarget = (): vscode.ConfigurationTarget => hasWorkspace() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
const updateConfig = async (key: string, value: string | undefined): Promise<void> => {
	try {
		await getConfig().update(key, value, getUpdateTarget())
	} catch (error) {
		if (hasWorkspace()) {
			await getConfig().update(key, value, vscode.ConfigurationTarget.Global)
			return
		}
		throw error
	}
}

export const getPanelUrl = (): string => HARD_CODED_PANEL_URL

export const getServerId = (): string | undefined => {
	const serverId = getConfig().get<string>("serverId")
	return serverId && serverId.trim() ? serverId : void 0
}

export const getApiKey = (): string | undefined => {
	const apiKey = getConfig().get<string>("apiKey")
	return apiKey && apiKey.trim() ? apiKey : void 0
}

export const getProxyBase = (): string => getConfig().get<string>("proxyUrl") ?? ""

export const setPanelUrl = async (_panelUrl: string | undefined): Promise<void> => Promise.resolve()

export const setServerId = async (serverId: string | undefined): Promise<void> => {
	await updateConfig("serverId", serverId)
}

export const setApiKey = async (apiKey: string | undefined): Promise<void> => {
	await updateConfig("apiKey", apiKey)
}

export const proxyUrl = (url: string): string => {
	const proxyBase = getProxyBase().trim()
	return proxyBase ? proxyBase + encodeURIComponent(url) : url
}

export const buildServerApiUrl = (panelUrl: string, serverId: string): string => `${panelUrl}/api/client/servers/${serverId}/files`

export const removeStartSlash = (path: string): string => path.replace(/^\//, "")
