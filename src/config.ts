import * as vscode from "vscode"

const CONFIG_SECTION = "pterodactyl-vsc"
const PANEL_URL_KEY = "panelUrl"
const DEFAULT_PANEL_URL = "https://voidium.uk"

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

export const normalizePanelUrl = (value: string | undefined): string | undefined => {
	const normalized = value?.trim()
	if (!normalized) {
		return void 0
	}
	return normalized.replace(/\/+$/, "")
}

export const getPanelUrl = (): string => {
	return normalizePanelUrl(getConfig().get<string>(PANEL_URL_KEY)) ?? DEFAULT_PANEL_URL
}

export const getServerId = (): string | undefined => {
	const serverId = getConfig().get<string>("serverId")
	return serverId && serverId.trim() ? serverId : void 0
}

export const getApiKey = (): string | undefined => {
	const apiKey = getConfig().get<string>("apiKey")
	return apiKey && apiKey.trim() ? apiKey : void 0
}

export const getProxyBase = (): string => getConfig().get<string>("proxyUrl") ?? ""

export const setPanelUrl = async (panelUrl: string | undefined): Promise<void> => {
	await updateConfig(PANEL_URL_KEY, normalizePanelUrl(panelUrl))
}

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

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

export const buildServerApiUrl = (panelUrl: string, serverId: string): string => {
	const baseUrl = trimTrailingSlash(panelUrl)
	return `${baseUrl}/api/client/servers/${serverId}/files`
}

export const removeStartSlash = (path: string): string => path.replace(/^\//, "")
