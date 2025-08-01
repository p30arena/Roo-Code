import * as vscode from "vscode"
import { CloudSettingsService } from "../CloudSettingsService"
import { RefreshTimer } from "../RefreshTimer"
import type { AuthService } from "../auth"
import type { OrganizationSettings } from "@roo-code/types"

// Mock dependencies
vi.mock("../RefreshTimer")
vi.mock("../Config", () => ({
	getRooCodeApiUrl: vi.fn().mockReturnValue("https://api.example.com"),
}))

// Mock fetch globally
global.fetch = vi.fn()

describe("CloudSettingsService", () => {
	let mockContext: vscode.ExtensionContext
	let mockAuthService: {
		getState: ReturnType<typeof vi.fn>
		getSessionToken: ReturnType<typeof vi.fn>
		hasActiveSession: ReturnType<typeof vi.fn>
		on: ReturnType<typeof vi.fn>
	}
	let mockRefreshTimer: {
		start: ReturnType<typeof vi.fn>
		stop: ReturnType<typeof vi.fn>
	}
	let cloudSettingsService: CloudSettingsService
	let mockLog: ReturnType<typeof vi.fn>

	const mockSettings: OrganizationSettings = {
		version: 1,
		defaultSettings: {},
		allowList: {
			allowAll: true,
			providers: {},
		},
	}

	beforeEach(() => {
		vi.clearAllMocks()

		mockContext = {
			globalState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as vscode.ExtensionContext

		mockAuthService = {
			getState: vi.fn().mockReturnValue("logged-out"),
			getSessionToken: vi.fn(),
			hasActiveSession: vi.fn().mockReturnValue(false),
			on: vi.fn(),
		}

		mockRefreshTimer = {
			start: vi.fn(),
			stop: vi.fn(),
		}

		mockLog = vi.fn()

		// Mock RefreshTimer constructor
		vi.mocked(RefreshTimer).mockImplementation(() => mockRefreshTimer as unknown as RefreshTimer)

		cloudSettingsService = new CloudSettingsService(mockContext, mockAuthService as unknown as AuthService, mockLog)
	})

	afterEach(() => {
		cloudSettingsService.dispose()
	})

	describe("constructor", () => {
		it("should create CloudSettingsService with proper dependencies", () => {
			expect(cloudSettingsService).toBeInstanceOf(CloudSettingsService)
			expect(RefreshTimer).toHaveBeenCalledWith({
				callback: expect.any(Function),
				successInterval: 30000,
				initialBackoffMs: 1000,
				maxBackoffMs: 30000,
			})
		})

		it("should use console.log as default logger when none provided", () => {
			const service = new CloudSettingsService(mockContext, mockAuthService as unknown as AuthService)
			expect(service).toBeInstanceOf(CloudSettingsService)
		})
	})

	describe("initialize", () => {
		it("should load cached settings on initialization", () => {
			const cachedSettings = {
				version: 1,
				defaultSettings: {},
				allowList: { allowAll: true, providers: {} },
			}

			// Create a fresh mock context for this test
			const testContext = {
				globalState: {
					get: vi.fn().mockReturnValue(cachedSettings),
					update: vi.fn().mockResolvedValue(undefined),
				},
			} as unknown as vscode.ExtensionContext

			// Mock auth service to not be logged out
			const testAuthService = {
				getState: vi.fn().mockReturnValue("active"),
				getSessionToken: vi.fn(),
				hasActiveSession: vi.fn().mockReturnValue(false),
				on: vi.fn(),
			}

			// Create a new instance to test initialization
			const testService = new CloudSettingsService(
				testContext,
				testAuthService as unknown as AuthService,
				mockLog,
			)
			testService.initialize()

			expect(testContext.globalState.get).toHaveBeenCalledWith("organization-settings")
			expect(testService.getSettings()).toEqual(cachedSettings)

			testService.dispose()
		})

		it("should clear cached settings if user is logged out", async () => {
			const cachedSettings = {
				version: 1,
				defaultSettings: {},
				allowList: { allowAll: true, providers: {} },
			}
			mockContext.globalState.get = vi.fn().mockReturnValue(cachedSettings)
			mockAuthService.getState.mockReturnValue("logged-out")

			cloudSettingsService.initialize()

			expect(mockContext.globalState.update).toHaveBeenCalledWith("organization-settings", undefined)
		})

		it("should set up auth service event listeners", () => {
			cloudSettingsService.initialize()

			expect(mockAuthService.on).toHaveBeenCalledWith("auth-state-changed", expect.any(Function))
		})

		it("should start timer if user has active session", () => {
			mockAuthService.hasActiveSession.mockReturnValue(true)

			cloudSettingsService.initialize()

			expect(mockRefreshTimer.start).toHaveBeenCalled()
		})

		it("should not start timer if user has no active session", () => {
			mockAuthService.hasActiveSession.mockReturnValue(false)

			cloudSettingsService.initialize()

			expect(mockRefreshTimer.start).not.toHaveBeenCalled()
		})
	})

	describe("event emission", () => {
		beforeEach(() => {
			cloudSettingsService.initialize()
		})

		it("should emit 'settings-updated' event when settings change", async () => {
			const eventSpy = vi.fn()
			cloudSettingsService.on("settings-updated", eventSpy)

			mockAuthService.getSessionToken.mockReturnValue("valid-token")
			vi.mocked(fetch).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockSettings),
			} as unknown as Response)

			// Get the callback function passed to RefreshTimer
			const timerCallback = vi.mocked(RefreshTimer).mock.calls[0][0].callback
			await timerCallback()

			expect(eventSpy).toHaveBeenCalledWith({
				settings: mockSettings,
				previousSettings: undefined,
			})
		})

		it("should emit event with previous settings when updating existing settings", async () => {
			const eventSpy = vi.fn()

			const previousSettings = {
				version: 1,
				defaultSettings: {},
				allowList: { allowAll: true, providers: {} },
			}
			const newSettings = {
				version: 2,
				defaultSettings: {},
				allowList: { allowAll: true, providers: {} },
			}

			// Create a fresh mock context for this test
			const testContext = {
				globalState: {
					get: vi.fn().mockReturnValue(previousSettings),
					update: vi.fn().mockResolvedValue(undefined),
				},
			} as unknown as vscode.ExtensionContext

			// Mock auth service to not be logged out
			const testAuthService = {
				getState: vi.fn().mockReturnValue("active"),
				getSessionToken: vi.fn().mockReturnValue("valid-token"),
				hasActiveSession: vi.fn().mockReturnValue(false),
				on: vi.fn(),
			}

			// Create a new service instance with cached settings
			const testService = new CloudSettingsService(
				testContext,
				testAuthService as unknown as AuthService,
				mockLog,
			)
			testService.on("settings-updated", eventSpy)
			testService.initialize()

			vi.mocked(fetch).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(newSettings),
			} as unknown as Response)

			// Get the callback function passed to RefreshTimer for this instance
			const timerCallback =
				vi.mocked(RefreshTimer).mock.calls[vi.mocked(RefreshTimer).mock.calls.length - 1][0].callback
			await timerCallback()

			expect(eventSpy).toHaveBeenCalledWith({
				settings: newSettings,
				previousSettings,
			})

			testService.dispose()
		})

		it("should not emit event when settings version is unchanged", async () => {
			const eventSpy = vi.fn()

			// Create a fresh mock context for this test
			const testContext = {
				globalState: {
					get: vi.fn().mockReturnValue(mockSettings),
					update: vi.fn().mockResolvedValue(undefined),
				},
			} as unknown as vscode.ExtensionContext

			// Mock auth service to not be logged out
			const testAuthService = {
				getState: vi.fn().mockReturnValue("active"),
				getSessionToken: vi.fn().mockReturnValue("valid-token"),
				hasActiveSession: vi.fn().mockReturnValue(false),
				on: vi.fn(),
			}

			// Create a new service instance with cached settings
			const testService = new CloudSettingsService(
				testContext,
				testAuthService as unknown as AuthService,
				mockLog,
			)
			testService.on("settings-updated", eventSpy)
			testService.initialize()

			vi.mocked(fetch).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockSettings), // Same version
			} as unknown as Response)

			// Get the callback function passed to RefreshTimer for this instance
			const timerCallback =
				vi.mocked(RefreshTimer).mock.calls[vi.mocked(RefreshTimer).mock.calls.length - 1][0].callback
			await timerCallback()

			expect(eventSpy).not.toHaveBeenCalled()

			testService.dispose()
		})

		it("should not emit event when fetch fails", async () => {
			const eventSpy = vi.fn()
			cloudSettingsService.on("settings-updated", eventSpy)

			mockAuthService.getSessionToken.mockReturnValue("valid-token")
			vi.mocked(fetch).mockResolvedValue({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as unknown as Response)

			// Get the callback function passed to RefreshTimer
			const timerCallback = vi.mocked(RefreshTimer).mock.calls[0][0].callback
			await timerCallback()

			expect(eventSpy).not.toHaveBeenCalled()
		})

		it("should not emit event when no auth token available", async () => {
			const eventSpy = vi.fn()
			cloudSettingsService.on("settings-updated", eventSpy)

			mockAuthService.getSessionToken.mockReturnValue(null)

			// Get the callback function passed to RefreshTimer
			const timerCallback = vi.mocked(RefreshTimer).mock.calls[0][0].callback
			await timerCallback()

			expect(eventSpy).not.toHaveBeenCalled()
			expect(fetch).not.toHaveBeenCalled()
		})
	})

	describe("fetchSettings", () => {
		beforeEach(() => {
			cloudSettingsService.initialize()
		})

		it("should fetch and cache settings successfully", async () => {
			mockAuthService.getSessionToken.mockReturnValue("valid-token")
			vi.mocked(fetch).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue(mockSettings),
			} as unknown as Response)

			// Get the callback function passed to RefreshTimer
			const timerCallback = vi.mocked(RefreshTimer).mock.calls[0][0].callback
			const result = await timerCallback()

			expect(result).toBe(true)
			expect(fetch).toHaveBeenCalledWith("https://api.example.com/api/organization-settings", {
				headers: {
					Authorization: "Bearer valid-token",
				},
			})
			expect(mockContext.globalState.update).toHaveBeenCalledWith("organization-settings", mockSettings)
		})

		it("should handle fetch errors gracefully", async () => {
			mockAuthService.getSessionToken.mockReturnValue("valid-token")
			vi.mocked(fetch).mockRejectedValue(new Error("Network error"))

			// Get the callback function passed to RefreshTimer
			const timerCallback = vi.mocked(RefreshTimer).mock.calls[0][0].callback
			const result = await timerCallback()

			expect(result).toBe(false)
			expect(mockLog).toHaveBeenCalledWith(
				"[cloud-settings] Error fetching organization settings:",
				expect.any(Error),
			)
		})

		it("should handle invalid response format", async () => {
			mockAuthService.getSessionToken.mockReturnValue("valid-token")
			vi.mocked(fetch).mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ invalid: "data" }),
			} as unknown as Response)

			// Get the callback function passed to RefreshTimer
			const timerCallback = vi.mocked(RefreshTimer).mock.calls[0][0].callback
			const result = await timerCallback()

			expect(result).toBe(false)
			expect(mockLog).toHaveBeenCalledWith(
				"[cloud-settings] Invalid organization settings format:",
				expect.any(Object),
			)
		})
	})

	describe("getAllowList", () => {
		it("should return settings allowList when available", () => {
			mockContext.globalState.get = vi.fn().mockReturnValue(mockSettings)
			cloudSettingsService.initialize()

			const allowList = cloudSettingsService.getAllowList()
			expect(allowList).toEqual(mockSettings.allowList)
		})

		it("should return default allow all when no settings available", () => {
			const allowList = cloudSettingsService.getAllowList()
			expect(allowList).toEqual({ allowAll: true, providers: {} })
		})
	})

	describe("getSettings", () => {
		it("should return current settings", () => {
			// Create a fresh mock context for this test
			const testContext = {
				globalState: {
					get: vi.fn().mockReturnValue(mockSettings),
					update: vi.fn().mockResolvedValue(undefined),
				},
			} as unknown as vscode.ExtensionContext

			// Mock auth service to not be logged out
			const testAuthService = {
				getState: vi.fn().mockReturnValue("active"),
				getSessionToken: vi.fn(),
				hasActiveSession: vi.fn().mockReturnValue(false),
				on: vi.fn(),
			}

			const testService = new CloudSettingsService(
				testContext,
				testAuthService as unknown as AuthService,
				mockLog,
			)
			testService.initialize()

			const settings = testService.getSettings()
			expect(settings).toEqual(mockSettings)

			testService.dispose()
		})

		it("should return undefined when no settings available", () => {
			const settings = cloudSettingsService.getSettings()
			expect(settings).toBeUndefined()
		})
	})

	describe("dispose", () => {
		it("should remove all listeners and stop timer", () => {
			const removeAllListenersSpy = vi.spyOn(cloudSettingsService, "removeAllListeners")

			cloudSettingsService.dispose()

			expect(removeAllListenersSpy).toHaveBeenCalled()
			expect(mockRefreshTimer.stop).toHaveBeenCalled()
		})
	})

	describe("auth service event handlers", () => {
		it("should start timer when auth-state-changed event is triggered with active-session", () => {
			cloudSettingsService.initialize()

			// Get the auth-state-changed handler
			const authStateChangedHandler = mockAuthService.on.mock.calls.find(
				(call) => call[0] === "auth-state-changed",
			)?.[1]
			expect(authStateChangedHandler).toBeDefined()

			// Simulate active-session state change
			authStateChangedHandler({ state: "active-session", previousState: "attempting-session" })
			expect(mockRefreshTimer.start).toHaveBeenCalled()
		})

		it("should stop timer and remove settings when auth-state-changed event is triggered with logged-out", async () => {
			cloudSettingsService.initialize()

			// Get the auth-state-changed handler
			const authStateChangedHandler = mockAuthService.on.mock.calls.find(
				(call) => call[0] === "auth-state-changed",
			)?.[1]
			expect(authStateChangedHandler).toBeDefined()

			// Simulate logged-out state change from active-session
			await authStateChangedHandler({ state: "logged-out", previousState: "active-session" })
			expect(mockRefreshTimer.stop).toHaveBeenCalled()
			expect(mockContext.globalState.update).toHaveBeenCalledWith("organization-settings", undefined)
		})
	})
})
