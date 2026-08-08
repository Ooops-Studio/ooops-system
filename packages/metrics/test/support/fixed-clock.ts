import type {Clock} from '@ooopsstudio/core/contracts/clock'

export function createFixedClock(initialTime: number): Clock & {advance(ms: number): void; set(time: number): void} {
	let currentTime = initialTime
	return {
		now: () => currentTime,
		advance: (ms: number) => {
			currentTime += ms
		},
		set: (time: number) => {
			currentTime = time
		}
	}
}
