/** Options shared by logging sink writes. */
export interface SinkWriteOptions {
	readonly signal?: AbortSignal
}

/** Minimal destination contract owned by the logging domain. */
export interface Sink<T> {
	write(item: T, options?: SinkWriteOptions): void | Promise<void>
	writeBatch?(items: readonly T[], options?: SinkWriteOptions): void | Promise<void>
	flush?(options?: SinkWriteOptions): Promise<void> | void
	close?(): Promise<void> | void
}
