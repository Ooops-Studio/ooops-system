import type {Clock} from '@ooopsstudio/core/contracts/clock'

export const createFixedClock = (fixedTime: number): Clock => ({
	now: () => fixedTime
})
