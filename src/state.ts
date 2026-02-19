import {buildServerApiUrl, getApiKey, getPanelUrl, getServerId} from "./config"

export interface RuntimeState {
	serverApiUrl: string
	authHeader: string
}

export const createRuntimeState = (): RuntimeState => ({
	serverApiUrl: "",
	authHeader: ""
})

export const hydrateRuntimeState = (state: RuntimeState): void => {
	const panelUrl = getPanelUrl()
	const serverId = getServerId()
	const apiKey = getApiKey()

	if (panelUrl && serverId) {
		state.serverApiUrl = buildServerApiUrl(panelUrl, serverId)
	}

	if (apiKey) {
		state.authHeader = `Bearer ${apiKey}`
	}
}

export const connectRuntimeState = (state: RuntimeState, panelUrl: string, serverId: string, apiKey: string): void => {
	state.serverApiUrl = buildServerApiUrl(panelUrl, serverId)
	state.authHeader = `Bearer ${apiKey}`
}

export const clearRuntimeState = (state: RuntimeState): void => {
	state.serverApiUrl = ""
	state.authHeader = ""
}
