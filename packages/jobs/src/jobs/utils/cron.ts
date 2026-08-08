import type {ScheduleDefinition} from '@ooopsstudio/core/contracts/jobs'

interface ZonedParts {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	weekday: number
}

interface ParsedField {
	any: boolean
	values: Set<number>
}

interface ParsedCron {
	minute: ParsedField
	hour: ParsedField
	day: ParsedField
	month: ParsedField
	weekday: ParsedField
}

const MINUTE_MS = 60_000
const MAX_DATE_MS = 8_640_000_000_000_000
const MAX_JOBS_TIMESTAMP = 99_999_999_999_999
const MAX_CRON_SEARCH_DAYS = 8 * 366
const MAX_DAYS_PER_MONTH: Record<number, number> = {
	1: 31,
	2: 29,
	3: 31,
	4: 30,
	5: 31,
	6: 30,
	7: 31,
	8: 31,
	9: 30,
	10: 31,
	11: 30,
	12: 31
}

function parseField(input: string, min: number, max: number): ParsedField {
	if (input === '*') {
		return {any: true, values: new Set<number>()}
	}

	const values = new Set<number>()
	for (const part of input.split(',')) {
		const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
		if (!match) {
			throw new Error(`Invalid cron field: ${input}`)
		}
		const rawBase = match[1] as string
		const rawStep = match[2]
		const step = rawStep === undefined ? 1 : Number(rawStep)
		if (!Number.isSafeInteger(step) || step < 1) {
			throw new Error(`Invalid cron field: ${input}`)
		}
		const [start, end] = rawBase === '*'
			? [min, max]
			: rawBase.includes('-')
				? rawBase.split('-').map(Number) as [number, number]
				: [Number(rawBase), rawStep === undefined ? Number(rawBase) : max]
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) {
			throw new Error(`Invalid cron field: ${input}`)
		}
		for (let value = start; value <= end; value += step) {
			values.add(value)
		}
	}

	return {any: false, values}
}

function hasPossibleCalendarDate(day: ParsedField, month: ParsedField, weekday: ParsedField): boolean {
	// Unix cron treats restricted day-of-month and day-of-week fields as OR.
	// A weekday can therefore make an otherwise impossible month/day pair valid.
	if (!day.any && !weekday.any) return true
	if (day.any || month.any) {
		return true
	}

	for (const monthValue of month.values) {
		const maxDay = MAX_DAYS_PER_MONTH[monthValue]
		if (!maxDay) {
			continue
		}
		for (const dayValue of day.values) {
			if (dayValue <= maxDay) {
				return true
			}
		}
	}

	return false
}

function parseCronExpression(cron: string): ParsedCron {
	const fields = cron.trim().split(/\s+/)
	if (fields.length !== 5) throw new Error(`Invalid cron expression: ${cron}`)
	const [minuteField, hourField, dayField, monthField, weekdayField] = fields
	const parsed = {
		minute: parseField(minuteField ?? '*', 0, 59),
		hour: parseField(hourField ?? '*', 0, 23),
		day: parseField(dayField ?? '*', 1, 31),
		month: parseField(monthField ?? '*', 1, 12),
		weekday: parseField(weekdayField ?? '*', 0, 6)
	}
	if (!hasPossibleCalendarDate(parsed.day, parsed.month, parsed.weekday)) {
		throw new Error(`Unable to compute next cron occurrence for ${cron}`)
	}
	return parsed
}

export function validateCronExpression(cron: string): void { parseCronExpression(cron) }

function createZonedFormatter(timezone: string): Intl.DateTimeFormat | undefined {
	if (timezone === 'UTC' || timezone === 'Etc/UTC') return undefined
	return new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short'
	})
}

function getZonedParts(timestamp: number, formatter: Intl.DateTimeFormat | undefined): ZonedParts {
	if (!formatter) {
		const date = new Date(timestamp)
		return {
			year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
			hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: date.getUTCDay()
		}
	}
	const parts = formatter.formatToParts(new Date(timestamp))
	const get = (type: string): string => parts.find((part) => part.type === type)?.value || ''
	const weekdayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6
	}

	return {
		year: Number(get('year')),
		month: Number(get('month')),
		day: Number(get('day')),
		hour: Number(get('hour')) % 24,
		minute: Number(get('minute')),
		weekday: weekdayMap[get('weekday')] ?? 0
	}
}

export function getNextCronOccurrence(
	cron: string,
	fromTimestamp: number,
	timezone = 'UTC'
): number {
	if (!Number.isFinite(fromTimestamp) || Math.abs(fromTimestamp) > MAX_DATE_MS) {
		throw new Error('Cron start timestamp is outside the supported date range')
	}
	const {minute, hour, day, month, weekday} = parseCronExpression(cron)

	const formatter = createZonedFormatter(timezone)
	let cursor = Math.floor(fromTimestamp / MINUTE_MS) * MINUTE_MS + MINUTE_MS
	// A valid February 29 schedule can be almost eight years away around a
	// non-leap century year (for example, from 2097 to 2104).
	const deadline = Math.min(MAX_DATE_MS, fromTimestamp + (MAX_CRON_SEARCH_DAYS * 24 * 60 * MINUTE_MS))

	while (cursor <= deadline) {
		const parts = getZonedParts(cursor, formatter)
		const dayMatches = day.any || day.values.has(parts.day)
		const weekdayMatches = weekday.any || weekday.values.has(parts.weekday)
		const calendarMatches = day.any || weekday.any
			? dayMatches && weekdayMatches
			: dayMatches || weekdayMatches
		const hourMatches = hour.any || hour.values.has(parts.hour)
		const monthMatches = month.any || month.values.has(parts.month)
		if ((!monthMatches || !calendarMatches) && !formatter) {
			cursor += Math.max(1, ((23 - parts.hour) * 60) + (60 - parts.minute)) * MINUTE_MS
			continue
		}
		if (!monthMatches || !calendarMatches || !hourMatches) {
			// No minute in the remainder of this local hour can match. Skipping it
			// avoids millions of Intl calls for sparse schedules such as February 29.
			cursor += Math.max(1, 60 - parts.minute) * MINUTE_MS
			continue
		}
		if (minute.any || minute.values.has(parts.minute)) {
			return cursor
		}
		cursor += MINUTE_MS
		if (!Number.isSafeInteger(cursor) || cursor > MAX_DATE_MS) break
	}

	throw new Error(`Unable to compute next cron occurrence for ${cron}`)
}

export function getNextScheduleTime(
	schedule: ScheduleDefinition,
	now: number,
	includeCurrent = false
): number | undefined {
	const earliest = Math.max(now, schedule.startAt ?? now)
	if (!Number.isSafeInteger(earliest) || earliest < 0 || earliest > MAX_JOBS_TIMESTAMP
		|| (schedule.endAt !== undefined && earliest > schedule.endAt)) {
		return undefined
	}

	switch (schedule.kind) {
		case 'interval': {
			const interval = schedule.intervalMs ?? MINUTE_MS
			const delay = Number.isFinite(interval) ? Math.max(1, interval) : MINUTE_MS
			const next = earliest + delay
			return !Number.isSafeInteger(next) || next > MAX_JOBS_TIMESTAMP
				|| (schedule.endAt !== undefined && next > schedule.endAt) ? undefined : next
		}
		case 'cron': {
			if (!schedule.cron) {
				return undefined
			}
			const next = getNextCronOccurrence(
				schedule.cron,
				includeCurrent ? earliest - 1 : earliest,
				schedule.policy?.timezone ?? 'UTC'
			)
			return next > MAX_JOBS_TIMESTAMP
				|| (schedule.endAt !== undefined && next > schedule.endAt) ? undefined : next
		}
	}
}

/** Advance a triggered schedule without drifting interval cadence when processing is late. */
export function getNextScheduleTimeAfterTrigger(
	schedule: ScheduleDefinition,
	dueAt: number,
	now: number
): number | undefined {
	if (schedule.kind === 'cron') {
		if (!schedule.cron) return undefined
		const next = getNextCronOccurrence(schedule.cron, now, schedule.policy?.timezone ?? 'UTC')
		return schedule.endAt !== undefined && next > schedule.endAt ? undefined : next
	}
	const interval = schedule.intervalMs ?? MINUTE_MS
	if (!Number.isSafeInteger(interval) || interval <= 0) return undefined
	const elapsed = Math.max(0, now - dueAt)
	const steps = Math.floor(elapsed / interval) + 1
	const next = dueAt + (steps * interval)
	if (!Number.isSafeInteger(next) || next > MAX_JOBS_TIMESTAMP
		|| (schedule.endAt !== undefined && next > schedule.endAt)) return undefined
	return next
}
