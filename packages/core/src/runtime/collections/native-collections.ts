const nativeReflectApply = Reflect.apply
const nativeSetAdd = Set.prototype.add
const nativeSetDelete = Set.prototype.delete
const nativeSetHas = Set.prototype.has
const nativeSetSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get
const nativeSetValues = Set.prototype.values
const nativeSetIteratorNext = Object.getPrototypeOf(new Set().values()).next as (
	this: SetIterator<unknown>
) => IteratorResult<unknown>
const nativeMapGet = Map.prototype.get
const nativeMapSet = Map.prototype.set
const nativeMapDelete = Map.prototype.delete
const nativeMapHas = Map.prototype.has
const nativeMapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
const nativeMapValues = Map.prototype.values
const nativeMapIteratorNext = Object.getPrototypeOf(new Map().values()).next as (
	this: MapIterator<unknown>
) => IteratorResult<unknown>
const nativeWeakSetAdd = WeakSet.prototype.add
const nativeWeakSetHas = WeakSet.prototype.has
const nativeWeakSetDelete = WeakSet.prototype.delete
const nativeWeakMapGet = WeakMap.prototype.get
const nativeWeakMapSet = WeakMap.prototype.set
const nativeWeakMapHas = WeakMap.prototype.has
const nativeWeakMapDelete = WeakMap.prototype.delete
const nativeArrayPush = Array.prototype.push
const nativeArraySlice = Array.prototype.slice
const nativeArraySplice = Array.prototype.splice

export function addNativeSet<T>(set: Set<T>, value: T): void {
	nativeReflectApply(nativeSetAdd, set, [value])
}

export function deleteNativeSet<T>(set: Set<T>, value: T): void {
	nativeReflectApply(nativeSetDelete, set, [value])
}

export function hasNativeSet<T>(set: Set<T>, value: T): boolean {
	return nativeReflectApply(nativeSetHas, set, [value]) as boolean
}

export function sizeNativeSet<T>(set: Set<T>): number {
	if (!nativeSetSize) return 0
	return nativeReflectApply(nativeSetSize, set, []) as number
}

export function snapshotNativeSet<T>(set: Set<T>): T[] {
	const snapshot: T[] = []
	const iterator = nativeReflectApply(nativeSetValues, set, []) as SetIterator<T>
	for (let remaining = sizeNativeSet(set); remaining > 0; remaining -= 1) {
		const next = nativeReflectApply(nativeSetIteratorNext, iterator, []) as IteratorResult<T>
		if (next.done) break
		nativeReflectApply(nativeArrayPush, snapshot, [next.value])
	}
	return snapshot
}

export function getNativeMap<TKey, TValue>(map: Map<TKey, TValue>, key: TKey): TValue | undefined {
	return nativeReflectApply(nativeMapGet, map, [key]) as TValue | undefined
}

export function setNativeMap<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, value: TValue): void {
	nativeReflectApply(nativeMapSet, map, [key, value])
}

export function deleteNativeMap<TKey, TValue>(map: Map<TKey, TValue>, key: TKey): boolean {
	return nativeReflectApply(nativeMapDelete, map, [key]) as boolean
}

export function hasNativeMap<TKey, TValue>(map: Map<TKey, TValue>, key: TKey): boolean {
	return nativeReflectApply(nativeMapHas, map, [key]) as boolean
}

export function sizeNativeMap<TKey, TValue>(map: Map<TKey, TValue>): number {
	if (!nativeMapSize) return 0
	return nativeReflectApply(nativeMapSize, map, []) as number
}

export function snapshotNativeMapValues<TKey, TValue>(map: Map<TKey, TValue>): TValue[] {
	const snapshot: TValue[] = []
	const iterator = nativeReflectApply(nativeMapValues, map, []) as MapIterator<TValue>
	for (let remaining = sizeNativeMap(map); remaining > 0; remaining -= 1) {
		const next = nativeReflectApply(nativeMapIteratorNext, iterator, []) as IteratorResult<TValue>
		if (next.done) break
		nativeReflectApply(nativeArrayPush, snapshot, [next.value])
	}
	return snapshot
}

export function addNativeWeakSet<T extends object>(set: WeakSet<T>, value: T): void {
	nativeReflectApply(nativeWeakSetAdd, set, [value])
}

export function hasNativeWeakSet<T extends object>(set: WeakSet<T>, value: T): boolean {
	return nativeReflectApply(nativeWeakSetHas, set, [value]) as boolean
}

export function deleteNativeWeakSet<T extends object>(set: WeakSet<T>, value: T): void {
	nativeReflectApply(nativeWeakSetDelete, set, [value])
}

export function getNativeWeakMap<TKey extends object, TValue>(
	map: WeakMap<TKey, TValue>, key: TKey
): TValue | undefined {
	return nativeReflectApply(nativeWeakMapGet, map, [key]) as TValue | undefined
}

export function setNativeWeakMap<TKey extends object, TValue>(
	map: WeakMap<TKey, TValue>, key: TKey, value: TValue
): void {
	nativeReflectApply(nativeWeakMapSet, map, [key, value])
}

export function hasNativeWeakMap<TKey extends object, TValue>(
	map: WeakMap<TKey, TValue>, key: TKey
): boolean {
	return nativeReflectApply(nativeWeakMapHas, map, [key]) as boolean
}

export function deleteNativeWeakMap<TKey extends object, TValue>(
	map: WeakMap<TKey, TValue>, key: TKey
): void {
	nativeReflectApply(nativeWeakMapDelete, map, [key])
}

export function pushNativeArray<T>(array: T[], value: T): void {
	nativeReflectApply(nativeArrayPush, array, [value])
}

export function sliceNativeArray<T>(array: readonly T[], start: number): T[] {
	return nativeReflectApply(nativeArraySlice, array, [start]) as T[]
}

export function spliceNativeArray<T>(array: T[], start: number): T[] {
	return nativeReflectApply(nativeArraySplice, array, [start]) as T[]
}

export function deleteNativeArrayPrefix<T>(array: T[], count: number): void {
	nativeReflectApply(nativeArraySplice, array, [0, count])
}
