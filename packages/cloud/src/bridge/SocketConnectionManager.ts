import { io, type Socket } from "socket.io-client"

import { ConnectionState, type RetryConfig } from "@roo-code/types"

export interface SocketConnectionOptions {
	url: string
	socketOptions: Record<string, unknown>
	onConnect?: () => void | Promise<void>
	onDisconnect?: (reason: string) => void
	onReconnect?: (attemptNumber: number) => void | Promise<void>
	onError?: (error: Error) => void
	logger?: {
		log: (message: string, ...args: unknown[]) => void
		error: (message: string, ...args: unknown[]) => void
		warn: (message: string, ...args: unknown[]) => void
	}
}

export class SocketConnectionManager {
	private socket: Socket | null = null
	private connectionState: ConnectionState = ConnectionState.DISCONNECTED
	private retryAttempt: number = 0
	private retryTimeout: NodeJS.Timeout | null = null
	private hasConnectedOnce: boolean = false

	private readonly retryConfig: RetryConfig = {
		maxInitialAttempts: 10,
		initialDelay: 1_000,
		maxDelay: 15_000,
		backoffMultiplier: 2,
	}

	private readonly CONNECTION_TIMEOUT = 2_000
	private readonly options: SocketConnectionOptions

	constructor(options: SocketConnectionOptions, retryConfig?: Partial<RetryConfig>) {
		this.options = options

		if (retryConfig) {
			this.retryConfig = { ...this.retryConfig, ...retryConfig }
		}
	}

	public async connect(): Promise<void> {
		if (this.connectionState === ConnectionState.CONNECTED) {
			console.log(`[SocketConnectionManager] Already connected`)
			return
		}

		if (this.connectionState === ConnectionState.CONNECTING || this.connectionState === ConnectionState.RETRYING) {
			console.log(`[SocketConnectionManager] Connection attempt already in progress`)

			return
		}

		// Start connection attempt without blocking.
		this.startConnectionAttempt()
	}

	private async startConnectionAttempt() {
		this.retryAttempt = 0

		try {
			await this.connectWithRetry()
		} catch (error) {
			console.error(`[SocketConnectionManager] Initial connection attempts failed:`, error)

			// If we've never connected successfully, we've exhausted our retry attempts
			// The user will need to manually retry or fix the issue
			this.connectionState = ConnectionState.FAILED
		}
	}

	private async connectWithRetry(): Promise<void> {
		let delay = this.retryConfig.initialDelay

		while (this.retryAttempt < this.retryConfig.maxInitialAttempts) {
			try {
				this.connectionState = this.retryAttempt === 0 ? ConnectionState.CONNECTING : ConnectionState.RETRYING

				console.log(
					`[SocketConnectionManager] Connection attempt ${this.retryAttempt + 1} / ${this.retryConfig.maxInitialAttempts}`,
				)

				await this.connectSocket()

				console.log(`[SocketConnectionManager] Connected to ${this.options.url}`)

				this.connectionState = ConnectionState.CONNECTED
				this.retryAttempt = 0

				this.clearRetryTimeouts()

				if (this.options.onConnect) {
					await this.options.onConnect()
				}

				return
			} catch (error) {
				this.retryAttempt++

				console.error(`[SocketConnectionManager] Connection attempt ${this.retryAttempt} failed:`, error)

				if (this.socket) {
					this.socket.disconnect()
					this.socket = null
				}

				if (this.retryAttempt >= this.retryConfig.maxInitialAttempts) {
					this.connectionState = ConnectionState.FAILED

					throw new Error(`Failed to connect after ${this.retryConfig.maxInitialAttempts} attempts`)
				}

				console.log(`[SocketConnectionManager] Waiting ${delay}ms before retry...`)

				await this.delay(delay)

				delay = Math.min(delay * this.retryConfig.backoffMultiplier, this.retryConfig.maxDelay)
			}
		}
	}

	private async connectSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = io(this.options.url, this.options.socketOptions)

			const connectionTimeout = setTimeout(() => {
				console.error(`[SocketConnectionManager] Connection timeout`)

				if (this.connectionState !== ConnectionState.CONNECTED) {
					this.socket?.disconnect()
					reject(new Error("Connection timeout"))
				}
			}, this.CONNECTION_TIMEOUT)

			this.socket.on("connect", async () => {
				clearTimeout(connectionTimeout)

				const isReconnection = this.hasConnectedOnce

				// If this is a reconnection (not the first connect), treat it as a
				// reconnect.
				// This handles server restarts where 'reconnect' event might not fire.
				if (isReconnection) {
					console.log(
						`[SocketConnectionManager] Treating connect as reconnection (server may have restarted)`,
					)

					this.connectionState = ConnectionState.CONNECTED

					if (this.options.onReconnect) {
						// Call onReconnect to re-register instance.
						await this.options.onReconnect(0)
					}
				}

				this.hasConnectedOnce = true
				resolve()
			})

			this.socket.on("disconnect", (reason: string) => {
				console.log(`[SocketConnectionManager] Disconnected (reason: ${reason})`)

				this.connectionState = ConnectionState.DISCONNECTED

				if (this.options.onDisconnect) {
					this.options.onDisconnect(reason)
				}

				// Don't attempt to reconnect if we're manually disconnecting.
				const isManualDisconnect = reason === "io client disconnect"

				if (!isManualDisconnect && this.hasConnectedOnce) {
					// After successful initial connection, rely entirely on Socket.IO's
					// reconnection.
					console.log(`[SocketConnectionManager] Socket.IO will handle reconnection (reason: ${reason})`)
				}
			})

			// Listen for reconnection attempts.
			this.socket.on("reconnect_attempt", (attemptNumber: number) => {
				console.log(`[SocketConnectionManager] Socket.IO reconnect attempt:`, {
					attemptNumber,
				})
			})

			this.socket.on("reconnect", (attemptNumber: number) => {
				console.log(`[SocketConnectionManager] Socket reconnected (attempt: ${attemptNumber})`)

				this.connectionState = ConnectionState.CONNECTED

				if (this.options.onReconnect) {
					this.options.onReconnect(attemptNumber)
				}
			})

			this.socket.on("reconnect_error", (error: Error) => {
				console.error(`[SocketConnectionManager] Socket.IO reconnect error:`, error)
			})

			this.socket.on("reconnect_failed", () => {
				console.error(`[SocketConnectionManager] Socket.IO reconnection failed after all attempts`)

				this.connectionState = ConnectionState.FAILED

				// Socket.IO has exhausted its reconnection attempts
				// The connection is now permanently failed until manual intervention
			})

			this.socket.on("error", (error) => {
				console.error(`[SocketConnectionManager] Socket error:`, error)

				if (this.connectionState !== ConnectionState.CONNECTED) {
					clearTimeout(connectionTimeout)
					reject(error)
				}

				if (this.options.onError) {
					this.options.onError(error)
				}
			})

			this.socket.on("auth_error", (error) => {
				console.error(`[SocketConnectionManager] Authentication error:`, error)
				clearTimeout(connectionTimeout)
				reject(new Error(error.message || "Authentication failed"))
			})
		})
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.retryTimeout = setTimeout(resolve, ms)
		})
	}

	// 1. Custom retry for initial connection attempts.
	// 2. Socket.IO's built-in reconnection after successful initial connection.

	private clearRetryTimeouts() {
		if (this.retryTimeout) {
			clearTimeout(this.retryTimeout)
			this.retryTimeout = null
		}
	}

	public async disconnect(): Promise<void> {
		console.log(`[SocketConnectionManager] Disconnecting...`)

		this.clearRetryTimeouts()

		if (this.socket) {
			this.socket.removeAllListeners()
			this.socket.disconnect()
			this.socket = null
		}

		this.connectionState = ConnectionState.DISCONNECTED

		console.log(`[SocketConnectionManager] Disconnected`)
	}

	public getSocket(): Socket | null {
		return this.socket
	}

	public getConnectionState(): ConnectionState {
		return this.connectionState
	}

	public isConnected(): boolean {
		return this.connectionState === ConnectionState.CONNECTED && this.socket?.connected === true
	}

	public async reconnect(): Promise<void> {
		if (this.connectionState === ConnectionState.CONNECTED) {
			console.log(`[SocketConnectionManager] Already connected`)
			return
		}

		console.log(`[SocketConnectionManager] Manual reconnection requested`)

		this.hasConnectedOnce = false

		await this.disconnect()
		await this.connect()
	}
}
