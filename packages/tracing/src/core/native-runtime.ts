/** Shared intrinsic runtime boundary for delivery and lifecycle ownership. */
export {
	captureNativePromiseResult,
	createNativePromise,
	deferNativePromise,
	mapNativePromise,
	observeNativePromiseSettlement,
	raceNativePromises
} from '@ooopsstudio/core/runtime/async/native-promise'
export {
	addNativeSet,
	deleteNativeMap,
	deleteNativeSet,
	hasNativeSet,
	pushNativeArray,
	setNativeMap,
	sizeNativeMap,
	sizeNativeSet,
	sliceNativeArray,
	snapshotNativeMapValues,
	snapshotNativeSet,
	spliceNativeArray
} from '@ooopsstudio/core/runtime/collections/native-collections'
