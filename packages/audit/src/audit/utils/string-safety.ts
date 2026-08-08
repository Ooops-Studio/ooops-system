export function isAuditSafeString(value: string): boolean {
	// Preserve ordinary multiline diagnostics, but reject terminal controls and
	// directional overrides that can execute or visually reorder immutable evidence.
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index)
		if (unit <= 0x0008 || unit === 0x000B || unit === 0x000C
			|| (unit >= 0x000E && unit <= 0x001F) || (unit >= 0x007F && unit <= 0x009F)
			|| unit === 0x061C || unit === 0x200E || unit === 0x200F
			|| (unit >= 0x202A && unit <= 0x202E) || (unit >= 0x2066 && unit <= 0x2069)) return false
		if (unit >= 0xD800 && unit <= 0xDBFF) {
			if (index + 1 >= value.length) return false
			const next = value.charCodeAt(index + 1)
			if (next < 0xDC00 || next > 0xDFFF) return false
			index += 1
		} else if (unit >= 0xDC00 && unit <= 0xDFFF) return false
	}
	return true
}
