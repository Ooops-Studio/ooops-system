/**
 * JSON family used across public contracts (stable).
 * Avoids `any`; safe to re-use in other packages.
 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonArray
export type JsonArray = ReadonlyArray<JsonValue>
export type JsonObject = {readonly [key: string]: JsonValue}