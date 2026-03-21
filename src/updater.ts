import * as vscode from "vscode"

import type {createLogger} from "./logger"

const DEFAULT_REPOSITORY = "Olibot1107/voidium-connect"
const MIN_CHECK_INTERVAL_MINUTES = 5
const STATE_LAST_CHECK = "pterodactyl-vsc.autoUpdate.lastCheck"
const STATE_LAST_VERSION = "pterodactyl-vsc.autoUpdate.lastNotifiedVersion"
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json"

interface LatestReleaseResult {
  version: string
  url: string
}

interface GitHubReleaseResponse {
  tag_name?: string
  name?: string
  html_url?: string
}

export class GitRepoUpdater implements vscode.Disposable {
  private checkTimer: ReturnType<typeof globalThis.setInterval> | undefined
  private readonly context: vscode.ExtensionContext
  private readonly log: ReturnType<typeof createLogger>
  private readonly localVersion: string

  public constructor(
    context: vscode.ExtensionContext,
    log: ReturnType<typeof createLogger>,
    localVersion: string
  ) {
    this.context = context
    this.log = log
    this.localVersion = localVersion
  }

  public initialize(): void {
    const settings = this.getSettings()
    if (!settings.enabled) {
      this.log("Auto-update checks are disabled")
      return
    }

    this.schedule(settings.checkIntervalMinutes)
    void this.checkNow(true)
  }

  public dispose(): void {
    if (this.checkTimer) {
      globalThis.clearInterval(this.checkTimer)
    }
  }

  public async checkNow(force = false): Promise<void> {
    const settings = this.getSettings()
    if (!settings.enabled && !force) {
      return
    }

    if (!this.isRepositoryValid(settings.repository)) {
      this.log("Skipping update check because repository is invalid")
      return
    }

    const now = Date.now()
    const lastCheck = this.context.globalState.get<number>(STATE_LAST_CHECK) ?? 0
    const minDelay = Math.max(1000, settings.checkIntervalMinutes * 60_000)
    if (!force && now - lastCheck < minDelay) {
      return
    }

    this.context.globalState.update(STATE_LAST_CHECK, now)

    try {
      const release = await this.fetchLatestRelease(settings.repository)
      if (!release) {
        return
      }

      if (this.compareVersions(release.version, this.localVersion) <= 0) {
        this.log("No newer version found")
        return
      }

      const alreadyNotified = this.context.globalState.get<string>(STATE_LAST_VERSION)
      if (alreadyNotified === release.version) {
        return
      }

      await this.promptUserForRelease(release, settings.repository)
      await this.context.globalState.update(STATE_LAST_VERSION, release.version)
    } catch (error) {
      this.log(`Update check failed: ${String(error)}`)
    }
  }

  private getSettings(): {enabled: boolean; repository: string; checkIntervalMinutes: number} {
    const config = vscode.workspace.getConfiguration("pterodactyl-vsc")
    const enabled = config.get<boolean>("autoUpdate.enabled") ?? true
    const repository = config.get<string>("autoUpdate.repository")?.trim() ?? ""
    const intervalMinutes = Math.max(
      MIN_CHECK_INTERVAL_MINUTES,
      config.get<number>("autoUpdate.checkIntervalMinutes") ?? 60
    )

    return {
      enabled,
      repository: repository || DEFAULT_REPOSITORY,
      checkIntervalMinutes: intervalMinutes
    }
  }

  private schedule(intervalMinutes: number): void {
    if (this.checkTimer) {
      globalThis.clearInterval(this.checkTimer)
    }

    this.checkTimer = globalThis.setInterval(() => {
      void this.checkNow()
    }, intervalMinutes * 60_000)
  }

  private async fetchLatestRelease(repository: string): Promise<LatestReleaseResult | undefined> {
    const releaseUrl = `https://api.github.com/repos/${repository}/releases/latest`
    this.log(`Checking repository updates at ${releaseUrl}`)

    const response = await fetch(releaseUrl, {
      headers: {
        Accept: GITHUB_ACCEPT_HEADER
      }
    })

    if (!response.ok) {
      this.log(`Release check responded ${response.status}`)
      return
    }

    const json = (await response.json()) as GitHubReleaseResponse
    const rawVersion = (json.tag_name ?? json.name ?? "").toString()
    const version = this.normalizeVersion(rawVersion)
    const htmlUrl = (json.html_url ?? "").toString()

    if (!version || !htmlUrl) {
      return
    }

    return {
      version,
      url: htmlUrl
    }
  }

  private normalizeVersion(value: string): string {
    return value.trim().replace(/^v/i, "").replace(/[\s_-]+/g, ".")
  }

  private compareVersions(a: string, b: string): number {
    const left = this.toChunks(a)
    const right = this.toChunks(b)
    const length = Math.max(left.length, right.length)

    for (let index = 0; index < length; index += 1) {
      const leftChunk = left[index] ?? 0
      const rightChunk = right[index] ?? 0

      if (leftChunk > rightChunk) {
        return 1
      }
      if (leftChunk < rightChunk) {
        return -1
      }
    }

    return 0
  }

  private toChunks(value: string): number[] {
    return value
      .split(".")
      .map(chunk => {
        const numeric = Number.parseInt(chunk, 10)
        return Number.isNaN(numeric) ? 0 : numeric
      })
  }

  private async promptUserForRelease(release: LatestReleaseResult, repository: string): Promise<void> {
    const selection = await vscode.window.showInformationMessage(
      `A new Voidium Hosting extension (${release.version}) is available from ${repository}`,
      "Open release notes",
      "Ignore"
    )

    if (selection === "Open release notes") {
      void vscode.env.openExternal(vscode.Uri.parse(release.url))
    }
  }

  private isRepositoryValid(repository: string): boolean {
    return /^[^/]+\/[^/]+$/.test(repository)
  }
}
