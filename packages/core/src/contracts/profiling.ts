/** Request for an explicit CPU profile capture. */
export interface ProfileCaptureOptions {
	type: 'cpu'
	name?: string
	durationMs?: number
	labels?: Readonly<Record<string, string>>
}

/** Application-facing result. Raw profile data never crosses this boundary. */
export interface ProfileCaptureSummary {
	type: 'cpu'
	name: string
	startedAt: number
	endedAt: number
	durationMs: number
	captured: boolean
	reason?: string
}
