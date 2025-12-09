"use strict"

import * as vscode from "vscode"

let serverApiUrl = ""
let authHeader = ""
let serverPowerUrl = ""

let outputChannel: vscode.OutputChannel
let statusBarItem: vscode.StatusBarItem
let openButtonItem: vscode.StatusBarItem
let statusBarRefreshInterval: NodeJS.Timeout | undefined
let treeDataProvider: PterodactylTreeDataProvider | undefined
const log = (message: string): void => outputChannel.appendLine(message)
const proxyUrl = (url: string): string => vscode.workspace.getConfiguration("pterodactyl-vsc").get("proxyUrl") + encodeURIComponent(url)
const removeStartSlash = (path: string): string => path.replace(/^\//, "")

interface ServerOption extends vscode.QuickPickItem {
	server: any
}

class PterodactylTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly uri: vscode.Uri,
		public readonly isFile: boolean
	) {
		super(label, collapsibleState)
		this.resourceUri = uri
		this.contextValue = isFile ? 'file' : 'folder'
	}
}

class PterodactylTreeDataProvider implements vscode.TreeDataProvider<PterodactylTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<PterodactylTreeItem | undefined | null | void> = new vscode.EventEmitter<PterodactylTreeItem | undefined | null | void>()
	readonly onDidChangeTreeData: vscode.Event<PterodactylTreeItem | undefined | null | void> = this._onDidChangeTreeData.event

	constructor(private fsProvider: PterodactylFileSystemProvider) {}

	getTreeItem(element: PterodactylTreeItem): vscode.TreeItem {
		return element
	}

	async getChildren(element?: PterodactylTreeItem): Promise<PterodactylTreeItem[]> {
		const dirUri = element ? element.uri : vscode.Uri.parse('pterodactyl:/')
		try {
			const items = await this.fsProvider.readDirectory(dirUri)
			return items.map(([name, type]) => {
				const uri = vscode.Uri.joinPath(dirUri, name)
				const isFile = (type & vscode.FileType.File) !== 0
				const collapsibleState = isFile ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
				return new PterodactylTreeItem(name, collapsibleState, uri, isFile)
			})
		} catch {
			return []
		}
	}

	refresh(): void {
		this._onDidChangeTreeData.fire()
	}
}

class PterodactylTreeDragAndDropController implements vscode.TreeDragAndDropController<PterodactylTreeItem> {
	readonly dropMimeTypes = ['application/vnd.code.tree.pterodactyl-explorer']
	readonly dragMimeTypes = ['application/vnd.code.tree.pterodactyl-explorer']

	constructor(private fsProvider: PterodactylFileSystemProvider, private treeDataProvider: PterodactylTreeDataProvider) {}

	handleDrag(source: readonly PterodactylTreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void {
		dataTransfer.set('application/vnd.code.tree.pterodactyl-explorer', new vscode.DataTransferItem(source))
	}

	async handleDrop(target: PterodactylTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
		const draggedItems = dataTransfer.get('application/vnd.code.tree.pterodactyl-explorer')?.value as readonly PterodactylTreeItem[]
		if (!draggedItems) return

		const targetUri = target && !target.isFile ? target.uri : vscode.Uri.parse('pterodactyl:/')

		for (const item of draggedItems) {
			if (item.isFile) {
				try {
					// Move file: read content, delete old, write to new
					const content = await this.fsProvider.readFile(item.uri)
					const newUri = vscode.Uri.joinPath(targetUri, item.label)
					await this.fsProvider.writeFile(newUri, content, { create: true, overwrite: true })
					await this.fsProvider.delete(item.uri)
				} catch (error) {
					vscode.window.showErrorMessage(`Failed to move ${item.label}: ${String(error)}`)
				}
			}
		}
		this.treeDataProvider.refresh()
	}
}

// Modified from https://github.com/kowd/vscode-webdav/blob/12a5f44d60ccf81430d70f3e50b04259524a403f/src/extension.ts#L147
const validatePanelURL = (value: string): string | undefined => {
	if (value) {
		try {
			const uri = vscode.Uri.parse(value.trim())
			if (uri.scheme != "http" && uri.scheme != "https") return "Unsupported protocol: " + uri.scheme
		} catch {
			return "Enter a valid URL"
		}
	} else return "Enter a valid URL"
}

const addPanel = async () => {
	const configuredUrl = vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl")
	const url = configuredUrl && typeof configuredUrl === "string" && configuredUrl.trim() ? configuredUrl : "https://hosting.voidium.uk"
	const panelUrl = vscode.Uri.parse(url)

	let apiKey: string | undefined = vscode.workspace.getConfiguration("pterodactyl-vsc").get("apiKey")
	if (!apiKey) {
		apiKey = await vscode.window.showInputBox({
			prompt: "Enter your Pterodactyl API key",
			placeHolder: "Enter your Pterodactyl panel client API key here...",
			validateInput: (value: string) => value ? (value.length == 48 ? undefined : "API keys are 48 characters long") : "Enter a valid API key",
			password: true
		})
		if (!apiKey || apiKey.length != 48) return vscode.window.showErrorMessage("Invalid API key, must be 48 characters long")
	}

	log("Connecting to " + panelUrl.scheme + "://" + panelUrl.authority + "...")
	const req = await fetch(proxyUrl(panelUrl.scheme + "://" + panelUrl.authority + "/api/client/"), {
		headers: {
			Accept: "application/json",
			Authorization: "Bearer " + apiKey
		}
	}).catch(e => {
		log(e)
		vscode.window.showErrorMessage("Failed to connect to the provided address: " + e.message)
	})
	if (!req) return

	log("Connection response: " + req.status + " " + req.statusText)
	if (!req.ok) {
		const text: string = await req.text()
		try {
			const jsonParsed: any = JSON.parse(text)
			log(JSON.stringify(jsonParsed, null, "\t"))
			return vscode.window.showErrorMessage("Failed to connect to the Pterodactyl panel (" + req.status + "): " + jsonParsed.errors[0].detail)
		} catch {
			log(text)
			return vscode.window.showErrorMessage("Failed to connect to the Pterodactyl panel (" + req.status + "): " + text.substring(0, 50) + (text.length > 50 ? "..." : ""))
		}
	}

	const json: any = await req.json()
	vscode.workspace.getConfiguration("pterodactyl-vsc").update("apiKey", apiKey)

	log("Connected successfully, " + json.data.length + " servers found")
	const selectedServer = await vscode.window.showQuickPick(json.data.map((server: any) => ({
		label: server.attributes.name,
		description: server.attributes.identifier,
		detail: server.attributes.description,
		server: server
	} as ServerOption)), {
		placeHolder: "Select a server to load into VS Code..."
	})
	if (!selectedServer) return

	const server = (selectedServer as unknown as ServerOption).server
	serverApiUrl = panelUrl.scheme + "://" + panelUrl.authority + "/api/client/servers/" + server.attributes.identifier + "/files"
	authHeader = "Bearer " + apiKey
	log("Setting server api URL & auth header to " + serverApiUrl)

	vscode.workspace.getConfiguration("pterodactyl-vsc").update("panelUrl", panelUrl.scheme + "://" + panelUrl.authority)
	vscode.workspace.getConfiguration("pterodactyl-vsc").update("serverId", server.attributes.identifier)

	vscode.workspace.updateWorkspaceFolders(0, 0, {
		uri: vscode.Uri.parse("pterodactyl:/"),
		name: "Pterodactyl - " + server.attributes.name
	})

	vscode.commands.executeCommand('setContext', 'pterodactyl-connected', true)
	treeDataProvider?.refresh()
}

const responseCache = new Map()
const responseCacheHits = new Map()

export class PterodactylFileSystemProvider implements vscode.FileSystemProvider {
	private readonly _eventEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]>

	public constructor() {
		this._eventEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
		this.onDidChangeFile = this._eventEmitter.event
	}

	public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>

	private async forConnection(operation: string, res: Response): Promise<void> {
		log(operation + ": " + res.status + " " + res.statusText)
		switch (res.status) {
			case 401:
				const message = await vscode.window.showWarningMessage("Authentication failed for " + vscode.Uri.parse(serverApiUrl).authority + ".", "Authenticate")
				if (message == "Authenticate") {
					vscode.workspace.getConfiguration("pterodactyl-vsc").update("apiKey", undefined)
					addPanel()
				}
				throw vscode.FileSystemError.NoPermissions(res.url)
			case 403:
				throw vscode.FileSystemError.NoPermissions(res.url)
			case 404:
				throw vscode.FileSystemError.FileNotFound(res.url)
			case 422:
				const json: any = await res.json()
				throw vscode.FileSystemError.Unavailable(json.errors[0].detail)
			case 429:
				throw vscode.FileSystemError.Unavailable("You have been ratelimited by the Pterodactyl panel.")
			case 500:
				const text: string = await res.text()
				log("-> Response: " + text)
				throw vscode.FileSystemError.Unavailable("The server (or a proxy) was unable to handle the request. Check Output -> Pterodactyl for more information.")
			default:
				if (!res.ok) throw vscode.FileSystemError.Unavailable("Unknown error: " + res.status + " " + res.statusText)
		}
	}

	public async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean } = { overwrite: false }): Promise<void> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		if (options.overwrite) {
			try {
				await this.delete(destination)
			} catch {}
		}

		const copyRes = await fetch(proxyUrl(serverApiUrl + "/copy"), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: authHeader
			},
			body: JSON.stringify({
				location: source.path
			})
		})
		await this.forConnection("copy: " + source.path + " -> " + destination.path, copyRes)

		const oldPath = source.path.split("/").slice(0, -1).join("/") || "/"
		const oldName = source.path.split("/").pop()
		const copiedLoc = oldName?.split(".").slice(0, -1).join(".") + " copy." + oldName?.split(".").pop()
		const newPath = destination.path.split("/").slice(0, -1).join("/") || "/"
		if (oldPath == newPath) return log("copy: Not renaming file " + newPath + "/" + copiedLoc + " due to same directory")
		log("copy: " + oldPath + "/" + copiedLoc + " -> " + newPath + "/" + destination.path.split("/").pop())

		const renameRes = await fetch(proxyUrl(serverApiUrl + "/rename"), {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: authHeader
			},
			body: JSON.stringify({
				root: "/",
				files: [{
					from: removeStartSlash(oldPath + "/") + copiedLoc,
					to: removeStartSlash(newPath + "/") + destination.path.split("/").pop()
				}]
			})
		})
		await this.forConnection("rename after copy: " + source.path + " -> " + destination.path, renameRes)
	}

	public async createDirectory(uri: vscode.Uri): Promise<void> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		const res = await fetch(proxyUrl(serverApiUrl + "/create-folder"), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: authHeader
			},
			body: JSON.stringify({
				root: "/",
				name: uri.path
			})
		})
		await this.forConnection("createDirectory: " + uri, res)
	}

	public async delete(uri: vscode.Uri, options: { recursive: boolean } = { recursive: true }): Promise<void> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		if (options.recursive === false) {
			let items: any = []
			try {
				items = await this.readDirectory(uri)
			} catch {}

			if (items && items.length > 0) throw vscode.FileSystemError.Unavailable("Directory not empty")
		}

		const res = await fetch(proxyUrl(serverApiUrl + "/delete"), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: authHeader
			},
			body: JSON.stringify({
				root: "/",
				files: [removeStartSlash(uri.path)]
			})
		})
		await this.forConnection("delete: " + uri, res)
	}

	public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		log("Reading directory: " + proxyUrl(serverApiUrl + "/list?directory=" + encodeURIComponent(uri.path)))
		const res = await fetch(proxyUrl(serverApiUrl + "/list?directory=" + encodeURIComponent(uri.path)), {
			headers: {
				Authorization: authHeader,
				Accept: "application/json"
			}
		})
		log("readDirectory response: " + res.status + " " + res.statusText)
		await this.forConnection("readDirectory: " + uri, res)

		const json: any = await res.json()
		return json.data.map((file: any) => [
			file.attributes.name,
			file.attributes.is_file ?
				(file.attributes.is_symlink ? vscode.FileType.File | vscode.FileType.SymbolicLink : vscode.FileType.File) :
				(file.attributes.is_symlink ? vscode.FileType.Directory | vscode.FileType.SymbolicLink : vscode.FileType.Directory)
		])
	}

	public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		// Retry logic for file reading to handle temporary network issues
		const maxRetries = 3
		let lastError: any = null

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const res = await fetch(proxyUrl(serverApiUrl + "/contents?file=" + encodeURIComponent(uri.path)), {
					headers: {
						Authorization: authHeader
					}
				})
				await this.forConnection("readFile: " + uri + " (attempt " + attempt + ")", res)
				return new Uint8Array(await res.arrayBuffer())
			} catch (error) {
				lastError = error
				log("readFile attempt " + attempt + " failed for " + uri.path + ": " + String(error))
				if (attempt < maxRetries) {
					// Wait before retrying (exponential backoff)
					await new Promise<void>(resolve => {
						setTimeout(resolve, Math.pow(2, attempt) * 100)
					})
				}
			}
		}

		// If all retries failed, throw the last error
		throw lastError
	}

	public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean } = { overwrite: false }): Promise<void> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		if (options.overwrite) {
			try {
				await this.delete(newUri)
			} catch {}
		}

		const res = await fetch(proxyUrl(serverApiUrl + "/rename"), {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: authHeader
			},
			body: JSON.stringify({
				root: "/",
				files: [{
					from: removeStartSlash(oldUri.path),
					to: removeStartSlash(newUri.path)
				}]
			})
		})
		await this.forConnection("rename: " + oldUri + " -> " + newUri, res)
	}

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		if (responseCache.has("stat:" + uri.toString())) {
			responseCacheHits.set("stat:" + uri.toString(), responseCacheHits.get("stat:" + uri.toString()) + 1)
			return responseCache.get("stat:" + uri.toString())
		}

		if (uri.path == "/") return {
			ctime: 0,
			mtime: 0,
			size: 0,
			type: vscode.FileType.Directory
		}

		const folderPath = uri.path.split("/").slice(0, -1).join("/") || "/"
		const res = await fetch(proxyUrl(serverApiUrl + "/list?directory=" + encodeURIComponent(folderPath)), {
			headers: {
				Authorization: authHeader,
				Accept: "application/json"
			}
		})
		await this.forConnection("stat: " + uri, res)

		const json: any = await res.json()
		if (!res.ok) {
			if (json.errors[0].code == "DaemonConnectionException") throw vscode.FileSystemError.FileNotFound(uri)
			throw vscode.FileSystemError.Unavailable(json.errors[0].detail)
		}

		const file = json.data.find((f: any) => f.attributes.name == uri.path.split("/").pop())?.attributes
		if (!file) throw vscode.FileSystemError.FileNotFound(uri)

		const response = {
			ctime: new Date(file.created_at).getTime(),
			mtime: new Date(file.modified_at).getTime(),
			permissions: file.mode[2] == "w" ? undefined : vscode.FilePermission.Readonly,
			size: file.size,
			type: file.is_file
				? (file.is_symlink ? vscode.FileType.File | vscode.FileType.SymbolicLink : vscode.FileType.File)
				: (file.is_symlink ? vscode.FileType.Directory | vscode.FileType.SymbolicLink : vscode.FileType.Directory)
		}

		responseCache.set("stat:" + uri.toString(), response)
		responseCacheHits.set("stat:" + uri.toString(), 0)
		setTimeout(() => {
			log(responseCacheHits.get("stat:" + uri.toString()) + " cache hits for stat requests on " + uri.toString())

			responseCache.delete("stat:" + uri.toString())
			responseCacheHits.delete("stat:" + uri.toString())
		}, 1000 * 10)

		return response
	}

	public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		if (serverApiUrl == "") throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")

		let fileExists = false
		try {
			const stat = await this.stat(uri)
			fileExists = true
			if (stat.type == vscode.FileType.Directory) throw vscode.FileSystemError.FileIsADirectory(uri)

			if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri)
		} catch {
			if (!options.create) throw vscode.FileSystemError.FileNotFound(uri)
		}

		// If file doesn't exist and we need to create it, try creating an empty file first
		if (!fileExists && options.create) {
			try {
				// Create an empty file first
				const createRes = await fetch(proxyUrl(serverApiUrl + "/write?file=" + uri.path), {
					method: "POST",
					headers: {
						Authorization: authHeader
					},
					body: new Uint8Array(0) // Empty content to create the file
				})
				// Ignore errors here as the file might already exist or creation might fail
				log("createFile attempt: " + createRes.status + " " + createRes.statusText)
			} catch (error) {
				log("Failed to create file first: " + String(error))
			}
		}

		const res = await fetch(proxyUrl(serverApiUrl + "/write?file=" + uri.path), {
			method: "POST",
			headers: {
				Authorization: authHeader
			},
			body: content
		})
		await this.forConnection("writeFile: " + uri, res)
	}

	public watch(): vscode.Disposable {
		return {
			dispose: () => {}
		}
	}
}



async function sendPowerSignal(signal: string) {
	if (!serverApiUrl || !authHeader) {
		vscode.window.showErrorMessage("No server connected")
		return
	}

	const panelUrl = vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl")
	const serverId = vscode.workspace.getConfiguration("pterodactyl-vsc").get("serverId")
	if (!panelUrl || !serverId) {
		vscode.window.showErrorMessage("Server configuration incomplete")
		return
	}

	const powerUrl = panelUrl + "/api/client/servers/" + serverId + "/power"

	try {
		const res = await fetch(proxyUrl(powerUrl), {
			method: "POST",
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/json",
				Accept: "application/vnd.pterodactyl.v1+json"
			},
			body: JSON.stringify({ signal })
		})

		if (res.status === 204) {
			vscode.window.showInformationMessage(`Server ${signal} command sent successfully`)
			// Refresh status bar after power action
			updateStatusBar()
		} else {
			const error: any = await res.json()
			vscode.window.showErrorMessage(`Failed to ${signal} server: ${error.errors[0].detail}`)
		}
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to ${signal} server: ${String(error)}`)
	}
}

function updateStatusBar() {
	if (!statusBarItem || !openButtonItem) return

	if (!serverApiUrl || !authHeader) {
		statusBarItem.text = "No Server"
		statusBarItem.tooltip = "No server connected"
		statusBarItem.command = "pterodactyl-vsc.init"
		statusBarItem.show()
		openButtonItem.hide()
		return
	}

	// Fetch current status
	const panelUrl = vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl")
	const serverId = vscode.workspace.getConfiguration("pterodactyl-vsc").get("serverId")
	if (!panelUrl || !serverId) {
		statusBarItem.text = "Config Error"
		statusBarItem.tooltip = "Server configuration incomplete"
		statusBarItem.command = "pterodactyl-vsc.init"
		statusBarItem.show()
		openButtonItem.hide()
		return
	}

	// Show open button when server is configured
	openButtonItem.text = "Open Server on Panel"
	openButtonItem.tooltip = "Open server in panel"
	openButtonItem.command = "pterodactyl-vsc.openPanel"
	openButtonItem.show()

	const resourcesUrl = panelUrl + "/api/client/servers/" + serverId + "/resources"
	fetch(proxyUrl(resourcesUrl), {
		headers: {
			Authorization: authHeader,
			Accept: "application/json"
		}
	}).then(res => {
		if (res.ok) {
			return res.json()
		}
		throw new Error("Failed to fetch resources")
	}).then((data: any) => {
		let state = data.attributes.current_state
		if (state === "starting") {
			state = "running"
		}
		statusBarItem.text = `${state.charAt(0).toUpperCase() + state.slice(1)}`
		statusBarItem.tooltip = `Server Status: ${state}\nClick to show power menu`
		statusBarItem.command = "pterodactyl-vsc.showPowerMenu"
		statusBarItem.show()
	}).catch(() => {
		statusBarItem.text = "Offline"
		statusBarItem.tooltip = "Unable to connect to server"
		statusBarItem.command = "pterodactyl-vsc.init"
		statusBarItem.show()
	})
}

async function showPowerMenu() {
	const items = [
		{ label: "Start Server", description: "Start the server", action: "start" },
		{ label: "Stop Server", description: "Stop the server gracefully", action: "stop" },
		{ label: "Restart Server", description: "Restart the server", action: "restart" },
		{ label: "Kill Server", description: "Force kill the server", action: "kill" }
	]

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: "Select a power action"
	})

	if (selected) {
		sendPowerSignal(selected.action)
	}
}

export const activate = (context: vscode.ExtensionContext) => {
	context.subscriptions.push(
		outputChannel = vscode.window.createOutputChannel("Pterodactyl file system")
	)
	log("Loading extension...")

	const fsProvider = new PterodactylFileSystemProvider()
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider("pterodactyl", fsProvider, { isCaseSensitive: true }))

	treeDataProvider = new PterodactylTreeDataProvider(fsProvider)
	const treeDragAndDropController = new PterodactylTreeDragAndDropController(fsProvider, treeDataProvider)
	const treeView = vscode.window.createTreeView('pterodactyl-explorer', {
		treeDataProvider,
		dragAndDropController: treeDragAndDropController,
		canSelectMany: true
	})
	context.subscriptions.push(treeView)

	// Create status bar items
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
	context.subscriptions.push(statusBarItem)

	openButtonItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
	context.subscriptions.push(openButtonItem)

	if (vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl") && vscode.workspace.getConfiguration("pterodactyl-vsc").get("serverId"))
		serverApiUrl = vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl") + "/api/client/servers/" + vscode.workspace.getConfiguration("pterodactyl-vsc").get("serverId") + "/files"
	if (vscode.workspace.getConfiguration("pterodactyl-vsc").get("apiKey")) authHeader = "Bearer " + vscode.workspace.getConfiguration("pterodactyl-vsc").get("apiKey")

	if (serverApiUrl) {
		vscode.commands.executeCommand('setContext', 'pterodactyl-connected', true)
	}

	// Update status bar initially and start refresh interval
	updateStatusBar()
	statusBarRefreshInterval = setInterval(() => updateStatusBar(), 5000) // Refresh every 5 seconds

	context.subscriptions.push({
		dispose: () => {
			if (statusBarRefreshInterval) {
				clearInterval(statusBarRefreshInterval)
			}
		}
	})

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		log("Detected configuration change")
		if (event.affectsConfiguration("pterodactyl-vsc.panelUrl") || event.affectsConfiguration("pterodactyl-vsc.serverId")) {
			const serverId = vscode.workspace.getConfiguration("pterodactyl-vsc").get("serverId")
			if (!serverId) return log("-> No server ID set, not updating server API URL")

			const parsedUrl = vscode.Uri.parse(vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl") || "")

			log("Setting server api URL to " + parsedUrl.scheme + "://" + parsedUrl.authority + "/api/client/servers/" + serverId + "/files")
			serverApiUrl = parsedUrl.scheme + "://" + parsedUrl.authority + "/api/client/servers/" + serverId + "/files"
			updateStatusBar()
		}

		if (event.affectsConfiguration("pterodactyl-vsc.apiKey")) {
			const key = vscode.workspace.getConfiguration("pterodactyl-vsc").get("apiKey")
			authHeader = key ? "Bearer " + key : ""
			updateStatusBar()
		}
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.init", () => {
		addPanel().then(() => {
			updateStatusBar()
		})
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.reset", () => {
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length || 0)

		serverApiUrl = ""
		authHeader = ""

		vscode.commands.executeCommand('setContext', 'pterodactyl-connected', false)

		log("Reset workspace")
		updateStatusBar()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.refresh", () => {
		log("Refreshing workspace server files...")

		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length || 0, {
			uri: vscode.Uri.parse("pterodactyl:/"),
			name: "Pterodactyl"
		})

		treeDataProvider?.refresh()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.startServer", () => {
		sendPowerSignal("start")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.stopServer", () => {
		sendPowerSignal("stop")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.restartServer", () => {
		sendPowerSignal("restart")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.killServer", () => {
		sendPowerSignal("kill")
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.showPowerMenu", () => {
		showPowerMenu()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.clearApiKey", () => {
		vscode.workspace.getConfiguration("pterodactyl-vsc").update("apiKey", undefined)
		authHeader = ""
		log("API key cleared")
		vscode.window.showInformationMessage("API key has been cleared")
		updateStatusBar()
	}))

	context.subscriptions.push(vscode.commands.registerCommand("pterodactyl-vsc.openPanel", () => {
		const panelUrl = vscode.workspace.getConfiguration("pterodactyl-vsc").get("panelUrl")
		const serverId = vscode.workspace.getConfiguration("pterodactyl-vsc").get("serverId")
		if (panelUrl && typeof panelUrl === "string" && serverId && typeof serverId === "string") {
			const serverUrl = panelUrl + "/server/" + serverId
			vscode.env.openExternal(vscode.Uri.parse(serverUrl))
		} else {
			vscode.window.showErrorMessage("Panel URL or server ID not configured")
		}
	}))
}
