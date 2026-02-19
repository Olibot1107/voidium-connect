import * as vscode from "vscode"

import type {PterodactylFileSystemProvider} from "./fsProvider"

export class PterodactylTreeItem extends vscode.TreeItem {
	public constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly uri: vscode.Uri,
		public readonly isFile: boolean
	) {
		super(label, collapsibleState)
		this.resourceUri = uri
		this.contextValue = isFile ? "file" : "folder"
	}
}

export class PterodactylTreeDataProvider implements vscode.TreeDataProvider<PterodactylTreeItem> {
	private readonly eventEmitter = new vscode.EventEmitter<PterodactylTreeItem | undefined | null | void>()
	private readonly fsProvider: PterodactylFileSystemProvider
	private readonly allItemsByDirectory = new Map<string, PterodactylTreeItem[]>()
	private readonly visibleItemsByDirectory = new Map<string, PterodactylTreeItem[]>()
	private readonly loadInFlightByDirectory = new Map<string, Promise<void>>()
	private readonly refreshTargetByDirectory = new Map<string, PterodactylTreeItem | undefined>()
	private readonly revealTimersByDirectory = new Map<string, ReturnType<typeof globalThis.setTimeout>>()

	public readonly onDidChangeTreeData = this.eventEmitter.event

	public constructor(fsProvider: PterodactylFileSystemProvider) {
		this.fsProvider = fsProvider
	}

	public getTreeItem(element: PterodactylTreeItem): vscode.TreeItem {
		return element
	}

	public async getChildren(element?: PterodactylTreeItem): Promise<PterodactylTreeItem[]> {
		const directoryUri = element ? element.uri : vscode.Uri.parse("pterodactyl:/")
		const directoryKey = directoryUri.toString()
		this.refreshTargetByDirectory.set(directoryKey, element)

		const visibleItems = this.visibleItemsByDirectory.get(directoryKey)
		if (visibleItems) {
			return visibleItems
		}

		void this.startAnimatedLoad(directoryUri, element)
		return []
	}

	public refresh(): void {
		for (const timer of this.revealTimersByDirectory.values()) {
			globalThis.clearTimeout(timer)
		}

		this.revealTimersByDirectory.clear()
		this.allItemsByDirectory.clear()
		this.visibleItemsByDirectory.clear()
		this.loadInFlightByDirectory.clear()
		this.refreshTargetByDirectory.clear()
		this.eventEmitter.fire()
	}

	private async startAnimatedLoad(directoryUri: vscode.Uri, element?: PterodactylTreeItem): Promise<void> {
		const directoryKey = directoryUri.toString()
		const inFlight = this.loadInFlightByDirectory.get(directoryKey)
		if (inFlight) {
			await inFlight
			return
		}

		const loadPromise = (async () => {
			try {
				const items = await this.fsProvider.readDirectory(directoryUri)
				const treeItems = items.map(([name, type]) => this.toTreeItem(directoryUri, name, type))
				treeItems.sort((left, right) => {
					if (left.isFile !== right.isFile) {
						return left.isFile ? 1 : -1
					}

					return left.label.localeCompare(right.label)
				})

				this.allItemsByDirectory.set(directoryKey, treeItems)
				this.visibleItemsByDirectory.set(directoryKey, [])
				this.revealNextItems(directoryKey, element)
			} catch {
				this.visibleItemsByDirectory.set(directoryKey, [])
				this.eventEmitter.fire(element)
			}
		})()

		this.loadInFlightByDirectory.set(directoryKey, loadPromise)
		await loadPromise.finally(() => {
			this.loadInFlightByDirectory.delete(directoryKey)
		})
	}

	private revealNextItems(directoryKey: string, element?: PterodactylTreeItem): void {
		const allItems = this.allItemsByDirectory.get(directoryKey)
		const visibleItems = this.visibleItemsByDirectory.get(directoryKey)
		if (!allItems || !visibleItems) {
			return
		}

		if (visibleItems.length >= allItems.length) {
			this.revealTimersByDirectory.delete(directoryKey)
			return
		}

		this.visibleItemsByDirectory.set(directoryKey, allItems.slice(0, visibleItems.length + 1))
		const target = this.refreshTargetByDirectory.get(directoryKey) ?? element
		this.eventEmitter.fire(target)

		const timer = globalThis.setTimeout(() => {
			this.revealNextItems(directoryKey, element)
		}, 12)
		this.revealTimersByDirectory.set(directoryKey, timer)
	}

	private toTreeItem(directoryUri: vscode.Uri, name: string, type: vscode.FileType): PterodactylTreeItem {
		const uri = vscode.Uri.joinPath(directoryUri, name)
		const isFile = (type & vscode.FileType.File) !== 0
		const collapsibleState = isFile ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
		return new PterodactylTreeItem(name, collapsibleState, uri, isFile)
	}
}

export class PterodactylTreeDragAndDropController implements vscode.TreeDragAndDropController<PterodactylTreeItem> {
	public readonly dropMimeTypes = ["application/vnd.code.tree.pterodactyl-explorer"]
	public readonly dragMimeTypes = ["application/vnd.code.tree.pterodactyl-explorer"]
	private readonly fsProvider: PterodactylFileSystemProvider
	private readonly treeDataProvider: PterodactylTreeDataProvider

	public constructor(fsProvider: PterodactylFileSystemProvider, treeDataProvider: PterodactylTreeDataProvider) {
		this.fsProvider = fsProvider
		this.treeDataProvider = treeDataProvider
	}

	public handleDrag(source: readonly PterodactylTreeItem[], dataTransfer: vscode.DataTransfer): void {
		dataTransfer.set("application/vnd.code.tree.pterodactyl-explorer", new vscode.DataTransferItem(source))
	}

	public async handleDrop(target: PterodactylTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const draggedItems = dataTransfer.get("application/vnd.code.tree.pterodactyl-explorer")?.value as readonly PterodactylTreeItem[] | undefined
		if (!draggedItems) {
			return
		}

		const targetUri = target && target.isFile === false ? target.uri : vscode.Uri.parse("pterodactyl:/")

		for (const item of draggedItems) {
			if (item.isFile === false) {
				continue
			}

			try {
				const content = await this.fsProvider.readFile(item.uri)
				const newUri = vscode.Uri.joinPath(targetUri, item.label)
				await this.fsProvider.writeFile(newUri, content, {create: true, overwrite: true})
				await this.fsProvider.delete(item.uri)
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to move ${item.label}: ${String(error)}`)
			}
		}

		this.treeDataProvider.refresh()
	}
}
