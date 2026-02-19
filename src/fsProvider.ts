import * as vscode from "vscode"

import {proxyUrl, removeStartSlash} from "./config"
import type {createLogger} from "./logger"
import type {RuntimeState} from "./state"

interface PterodactylErrorResponse {
	errors: Array<{
		code?: string
		detail: string
	}>
}

interface PterodactylFileAttributes {
	name: string
	is_file: boolean
	is_symlink: boolean
	created_at: string
	modified_at: string
	mode: string
	size: number
}

interface PterodactylFileResponse {
	data: Array<{
		attributes: PterodactylFileAttributes
	}>
}

interface FileSystemProviderDependencies {
	state: RuntimeState
	log: ReturnType<typeof createLogger>
	onAuthenticationFailed: () => void
}

export class PterodactylFileSystemProvider implements vscode.FileSystemProvider {
	private readonly eventEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
	private readonly responseCache = new Map<string, vscode.FileStat>()
	private readonly responseCacheHits = new Map<string, number>()
	private readonly state: RuntimeState
	private readonly log: ReturnType<typeof createLogger>
	private readonly onAuthenticationFailed: () => void

	public readonly onDidChangeFile = this.eventEmitter.event

	public constructor(deps: FileSystemProviderDependencies) {
		this.state = deps.state
		this.log = deps.log
		this.onAuthenticationFailed = deps.onAuthenticationFailed
	}

	private ensureConnected(): void {
		if (!this.state.serverApiUrl) {
			throw vscode.FileSystemError.Unavailable("No server API URL set, please init the extension first.")
		}
	}

	private async forConnection(operation: string, response: Response): Promise<void> {
		this.log(`${operation}: ${response.status} ${response.statusText}`)

		switch (response.status) {
			case 401: {
				const host = vscode.Uri.parse(this.state.serverApiUrl).authority
				const message = await vscode.window.showWarningMessage(`Authentication failed for ${host}.`, "Authenticate")
				if (message === "Authenticate") {
					this.onAuthenticationFailed()
				}
				throw vscode.FileSystemError.NoPermissions(response.url)
			}
			case 403:
				throw vscode.FileSystemError.NoPermissions(response.url)
			case 404:
				throw vscode.FileSystemError.FileNotFound(response.url)
			case 422: {
				const json = await response.json() as PterodactylErrorResponse
				throw vscode.FileSystemError.Unavailable(json.errors[0]?.detail ?? "Request could not be completed.")
			}
			case 429:
				throw vscode.FileSystemError.Unavailable("You have been ratelimited by the Pterodactyl panel.")
			case 500: {
				const text = await response.text()
				this.log(`-> Response: ${text}`)
				throw vscode.FileSystemError.Unavailable("The server (or a proxy) was unable to handle the request. Check Output -> Pterodactyl for more information.")
			}
			default:
				if (!response.ok) {
					throw vscode.FileSystemError.Unavailable(`Unknown error: ${response.status} ${response.statusText}`)
				}
		}
	}

	public async copy(source: vscode.Uri, destination: vscode.Uri, options: {overwrite: boolean} = {overwrite: false}): Promise<void> {
		this.ensureConnected()

		if (options.overwrite) {
			try {
				await this.delete(destination)
			} catch {}
		}

		const copyResponse = await fetch(proxyUrl(`${this.state.serverApiUrl}/copy`), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.state.authHeader
			},
			body: JSON.stringify({
				location: source.path
			})
		})
		await this.forConnection(`copy: ${source.path} -> ${destination.path}`, copyResponse)

		const oldPath = source.path.split("/").slice(0, -1).join("/") || "/"
		const oldName = source.path.split("/").pop()
		const oldNameSegments = oldName?.split(".") ?? []
		const oldNamePrefix = oldNameSegments.slice(0, -1).join(".")
		const oldNameSuffix = oldNameSegments.at(-1)
		const copiedLocation = `${oldNamePrefix} copy.${oldNameSuffix}`
		const newPath = destination.path.split("/").slice(0, -1).join("/") || "/"

		if (oldPath === newPath) {
			this.log(`copy: Not renaming file ${newPath}/${copiedLocation} due to same directory`)
			return
		}

		this.log(`copy: ${oldPath}/${copiedLocation} -> ${newPath}/${destination.path.split("/").pop()}`)
		const renameResponse = await fetch(proxyUrl(`${this.state.serverApiUrl}/rename`), {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.state.authHeader
			},
			body: JSON.stringify({
				root: "/",
				files: [{
					from: removeStartSlash(`${oldPath}/${copiedLocation}`),
					to: removeStartSlash(`${newPath}/${destination.path.split("/").pop()}`)
				}]
			})
		})
		await this.forConnection(`rename after copy: ${source.path} -> ${destination.path}`, renameResponse)
	}

	public async createDirectory(uri: vscode.Uri): Promise<void> {
		this.ensureConnected()

		const response = await fetch(proxyUrl(`${this.state.serverApiUrl}/create-folder`), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.state.authHeader
			},
			body: JSON.stringify({
				root: "/",
				name: uri.path
			})
		})
		await this.forConnection(`createDirectory: ${uri}`, response)
	}

	public async delete(uri: vscode.Uri, options: {recursive: boolean} = {recursive: true}): Promise<void> {
		this.ensureConnected()

		if (options.recursive === false) {
			let items: [string, vscode.FileType][] = []
			try {
				items = await this.readDirectory(uri)
			} catch {}

			if (items.length > 0) {
				throw vscode.FileSystemError.Unavailable("Directory not empty")
			}
		}

		const response = await fetch(proxyUrl(`${this.state.serverApiUrl}/delete`), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.state.authHeader
			},
			body: JSON.stringify({
				root: "/",
				files: [removeStartSlash(uri.path)]
			})
		})
		await this.forConnection(`delete: ${uri}`, response)
	}

	public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		this.ensureConnected()

		const requestUrl = `${this.state.serverApiUrl}/list?directory=${encodeURIComponent(uri.path)}`
		this.log(`Reading directory: ${proxyUrl(requestUrl)}`)

		const response = await fetch(proxyUrl(requestUrl), {
			headers: {
				Authorization: this.state.authHeader,
				Accept: "application/json"
			}
		})
		this.log(`readDirectory response: ${response.status} ${response.statusText}`)
		await this.forConnection(`readDirectory: ${uri}`, response)

		const json = await response.json() as PterodactylFileResponse
		return json.data.map(file => {
			const attributes = file.attributes
			let type = vscode.FileType.Directory
			if (attributes.is_file && attributes.is_symlink) {
				type = vscode.FileType.File | vscode.FileType.SymbolicLink
			} else if (attributes.is_file) {
				type = vscode.FileType.File
			} else if (attributes.is_symlink) {
				type = vscode.FileType.Directory | vscode.FileType.SymbolicLink
			}

			return [attributes.name, type]
		})
	}

	public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		this.ensureConnected()

		const maxRetries = 3
		let lastError: unknown

		for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
			try {
				const response = await fetch(proxyUrl(`${this.state.serverApiUrl}/contents?file=${encodeURIComponent(uri.path)}`), {
					headers: {
						Authorization: this.state.authHeader
					}
				})
				await this.forConnection(`readFile: ${uri} (attempt ${attempt})`, response)
				return new Uint8Array(await response.arrayBuffer())
			} catch (error) {
				lastError = error
				this.log(`readFile attempt ${attempt} failed for ${uri.path}: ${String(error)}`)
				if (attempt < maxRetries) {
					await new Promise<void>(resolve => {
						setTimeout(resolve, 2 ** attempt * 100)
					})
				}
			}
		}

		throw lastError
	}

	public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: {overwrite: boolean} = {overwrite: false}): Promise<void> {
		this.ensureConnected()

		if (options.overwrite) {
			try {
				await this.delete(newUri)
			} catch {}
		}

		const response = await fetch(proxyUrl(`${this.state.serverApiUrl}/rename`), {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.state.authHeader
			},
			body: JSON.stringify({
				root: "/",
				files: [{
					from: removeStartSlash(oldUri.path),
					to: removeStartSlash(newUri.path)
				}]
			})
		})
		await this.forConnection(`rename: ${oldUri} -> ${newUri}`, response)
	}

	public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		this.ensureConnected()

		const cacheKey = `stat:${uri.toString()}`
		const cached = this.responseCache.get(cacheKey)
		if (cached) {
			const cacheHits = this.responseCacheHits.get(cacheKey) ?? 0
			this.responseCacheHits.set(cacheKey, cacheHits + 1)
			return cached
		}

		if (uri.path === "/") {
			return {
				ctime: 0,
				mtime: 0,
				size: 0,
				type: vscode.FileType.Directory
			}
		}

		const folderPath = uri.path.split("/").slice(0, -1).join("/") || "/"
		const response = await fetch(proxyUrl(`${this.state.serverApiUrl}/list?directory=${encodeURIComponent(folderPath)}`), {
			headers: {
				Authorization: this.state.authHeader,
				Accept: "application/json"
			}
		})
		await this.forConnection(`stat: ${uri}`, response)

		const json = await response.json() as PterodactylFileResponse & PterodactylErrorResponse
		if (!response.ok) {
			if (json.errors[0]?.code === "DaemonConnectionException") {
				throw vscode.FileSystemError.FileNotFound(uri)
			}
			throw vscode.FileSystemError.Unavailable(json.errors[0]?.detail ?? "Stat request failed")
		}

		const targetName = uri.path.split("/").pop()
		const file = json.data.find(entry => entry.attributes.name === targetName)?.attributes
		if (!file) {
			throw vscode.FileSystemError.FileNotFound(uri)
		}

		const responseStat: vscode.FileStat = {
			ctime: new Date(file.created_at).getTime(),
			mtime: new Date(file.modified_at).getTime(),
			permissions: file.mode[2] === "w" ? void 0 : vscode.FilePermission.Readonly,
			size: file.size,
			type: this.getFileType(file.is_file, file.is_symlink)
		}

		this.responseCache.set(cacheKey, responseStat)
		this.responseCacheHits.set(cacheKey, 0)
		setTimeout(() => {
			this.log(`${this.responseCacheHits.get(cacheKey)} cache hits for stat requests on ${uri.toString()}`)
			this.responseCache.delete(cacheKey)
			this.responseCacheHits.delete(cacheKey)
		}, 10_000)

		return responseStat
	}

	public async writeFile(uri: vscode.Uri, content: Uint8Array, options: {create: boolean, overwrite: boolean}): Promise<void> {
		this.ensureConnected()

		let fileExists = false
		try {
			const fileStat = await this.stat(uri)
			fileExists = true

			if (fileStat.type === vscode.FileType.Directory) {
				throw vscode.FileSystemError.FileIsADirectory(uri)
			}

			if (options.overwrite === false) {
				throw vscode.FileSystemError.FileExists(uri)
			}
		} catch {
			if (options.create === false) {
				throw vscode.FileSystemError.FileNotFound(uri)
			}
		}

		if (fileExists === false && options.create) {
			try {
				const createResponse = await fetch(proxyUrl(`${this.state.serverApiUrl}/write?file=${uri.path}`), {
					method: "POST",
					headers: {
						Authorization: this.state.authHeader
					},
					body: new Uint8Array(0)
				})
				this.log(`createFile attempt: ${createResponse.status} ${createResponse.statusText}`)
			} catch (error) {
				this.log(`Failed to create file first: ${String(error)}`)
			}
		}

		const response = await fetch(proxyUrl(`${this.state.serverApiUrl}/write?file=${uri.path}`), {
			method: "POST",
			headers: {
				Authorization: this.state.authHeader
			},
			body: content
		})
		await this.forConnection(`writeFile: ${uri}`, response)
	}

	public watch(resource: vscode.Uri, options: {readonly excludes: readonly string[], readonly recursive: boolean}): vscode.Disposable {
		void resource
		void options
		return {
			dispose: () => {}
		}
	}

	private getFileType(isFile: boolean, isSymlink: boolean): vscode.FileType {
		if (isFile && isSymlink) {
			return vscode.FileType.File | vscode.FileType.SymbolicLink
		}
		if (isFile) {
			return vscode.FileType.File
		}
		if (isSymlink) {
			return vscode.FileType.Directory | vscode.FileType.SymbolicLink
		}
		return vscode.FileType.Directory
	}
}
