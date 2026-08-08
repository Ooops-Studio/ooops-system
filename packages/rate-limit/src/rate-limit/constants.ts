/**
 * @file Rate limiting constants and default configurations.
 */

/** Integer precision used by token-bucket memory and Redis implementations. */
export const MICROTOKENS_PER_TOKEN = 1_000_000
export const MAX_SAFE_MICROTOKEN_AMOUNT = Math.floor(Number.MAX_SAFE_INTEGER / MICROTOKENS_PER_TOKEN)
export const MIN_MICROTOKEN_AMOUNT = 1 / MICROTOKENS_PER_TOKEN

/** Maximum logical identifier size before storage hashing. */
export const MAX_RATE_LIMIT_KEY_LENGTH = 2_048
