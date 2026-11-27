import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect"

import { StateStoreError } from "./errors.ts"
import {
  BridgeStateJsonSchema,
  PersistedStateJsonSchema,
  type BridgeState,
} from "./schemas.ts"

const decodePersistedState = Schema.decodeUnknownEffect(PersistedStateJsonSchema)
const encodeBridgeState = Schema.encodeEffect(BridgeStateJsonSchema)

export const EMPTY_BRIDGE_STATE: BridgeState = {
  version: 1,
  offset: 0,
  deliveredReplyIds: [],
}

export const loadState = Effect.fn("loadState")(function*(
  stateFilePath: string,
): Effect.fn.Return<BridgeState, StateStoreError> {
  const raw = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await fs.readFile(stateFilePath, "utf8")
      } catch (err) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          err.code === "ENOENT"
        ) {
          return null
        }
        throw err
      }
    },
    catch: (err) =>
      new StateStoreError({
        operation: "load",
        path: stateFilePath,
        message: `Failed to read state file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
  })

  if (raw === null) {
    return EMPTY_BRIDGE_STATE
  }

  const decoded = yield* decodePersistedState(raw).pipe(
    Effect.mapError((err) =>
      new StateStoreError({
        operation: "load",
        path: stateFilePath,
        message: `Invalid state file format: ${err.message}`,
      })
    ),
  )

  return {
    version: 1,
    offset: decoded.offset ?? 0,
    deliveredReplyIds: Array.from(new Set(decoded.deliveredReplyIds ?? [])),
  }
})

export const saveStateAtomic = Effect.fn("saveStateAtomic")(function*(
  stateFilePath: string,
  state: BridgeState,
): Effect.fn.Return<void, StateStoreError> {
  const encoded = yield* encodeBridgeState({
    version: 1,
    offset: state.offset,
    deliveredReplyIds: [...state.deliveredReplyIds],
  }).pipe(
    Effect.mapError((err) =>
      new StateStoreError({
        operation: "save",
        path: stateFilePath,
        message: `Failed to encode state: ${err.message}`,
      })
    ),
  )

  const payload = `${encoded}\n`
  const dir = path.dirname(stateFilePath)
  const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`
  const tmpPath = `${stateFilePath}.tmp.${uniqueSuffix}`

  yield* Effect.tryPromise({
    try: async () => {
      await fs.mkdir(dir, { recursive: true })
      try {
        await fs.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 })
        await fs.chmod(tmpPath, 0o600)
        await fs.rename(tmpPath, stateFilePath)
        await fs.chmod(stateFilePath, 0o600)
      } catch (err) {
        await fs.rm(tmpPath, { force: true }).catch(() => {})
        throw err
      }
    },
    catch: (err) =>
      new StateStoreError({
        operation: "save",
        path: stateFilePath,
        message: `Failed to write state file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
  })
})

export interface StateStoreShape {
  readonly get: Effect.Effect<BridgeState>
  readonly advanceOffset: (nextOffset: number) => Effect.Effect<boolean, StateStoreError>
  readonly hasDeliveredReply: (replyId: string) => Effect.Effect<boolean>
  readonly markReplyDelivered: (replyId: string) => Effect.Effect<boolean, StateStoreError>
}

export class StateStore extends Context.Service<StateStore, StateStoreShape>()(
  "clanker-whips/telegram-bridge/StateStore",
) {
  static layerFile(stateFilePath: string): Layer.Layer<StateStore, StateStoreError> {
    return Layer.effect(
      StateStore,
      Effect.gen(function*() {
        const initial = yield* loadState(stateFilePath)
        const stateRef = yield* Ref.make<BridgeState>(initial)
        const writeLock = yield* Semaphore.make(1)

        const get = Ref.get(stateRef)

        const advanceOffset = Effect.fn("StateStore.advanceOffset")(
          function*(nextOffset: number) {
            const current = yield* Ref.get(stateRef)
            if (nextOffset <= current.offset) {
              return false
            }
            const nextState: BridgeState = {
              version: 1,
              offset: nextOffset,
              deliveredReplyIds: current.deliveredReplyIds,
            }
            yield* Effect.uninterruptible(saveStateAtomic(stateFilePath, nextState))
            yield* Ref.set(stateRef, nextState)
            return true
          },
          writeLock.withPermit,
        )

        const hasDeliveredReply = (replyId: string): Effect.Effect<boolean> =>
          Ref.get(stateRef).pipe(
            Effect.map((state) => state.deliveredReplyIds.includes(replyId)),
          )

        const markReplyDelivered = Effect.fn("StateStore.markReplyDelivered")(
          function*(replyId: string) {
            const current = yield* Ref.get(stateRef)
            if (current.deliveredReplyIds.includes(replyId)) {
              return false
            }
            const nextState: BridgeState = {
              version: 1,
              offset: current.offset,
              deliveredReplyIds: [...current.deliveredReplyIds, replyId],
            }
            yield* Effect.uninterruptible(saveStateAtomic(stateFilePath, nextState))
            yield* Ref.set(stateRef, nextState)
            return true
          },
          writeLock.withPermit,
        )

        return StateStore.of({
          get,
          advanceOffset,
          hasDeliveredReply,
          markReplyDelivered,
        })
      }),
    )
  }

  static layerMemory(options: {
    readonly initialState?: BridgeState | undefined
    readonly onSave?: ((state: BridgeState) => Effect.Effect<void, StateStoreError>) | undefined
  } = {}): Layer.Layer<StateStore> {
    return Layer.effect(
      StateStore,
      Effect.gen(function*() {
        const stateRef = yield* Ref.make<BridgeState>(
          options.initialState ?? EMPTY_BRIDGE_STATE,
        )
        const writeLock = yield* Semaphore.make(1)

        const get = Ref.get(stateRef)

        const advanceOffset = Effect.fnUntraced(
          function*(nextOffset: number) {
            const current = yield* Ref.get(stateRef)
            if (nextOffset <= current.offset) {
              return false
            }
            const nextState: BridgeState = {
              version: 1,
              offset: nextOffset,
              deliveredReplyIds: current.deliveredReplyIds,
            }
            if (options.onSave) {
              yield* options.onSave(nextState)
            }
            yield* Ref.set(stateRef, nextState)
            return true
          },
          writeLock.withPermit,
        )

        const hasDeliveredReply = (replyId: string): Effect.Effect<boolean> =>
          Ref.get(stateRef).pipe(
            Effect.map((state) => state.deliveredReplyIds.includes(replyId)),
          )

        const markReplyDelivered = Effect.fnUntraced(
          function*(replyId: string) {
            const current = yield* Ref.get(stateRef)
            if (current.deliveredReplyIds.includes(replyId)) {
              return false
            }
            const nextState: BridgeState = {
              version: 1,
              offset: current.offset,
              deliveredReplyIds: [...current.deliveredReplyIds, replyId],
            }
            if (options.onSave) {
              yield* options.onSave(nextState)
            }
            yield* Ref.set(stateRef, nextState)
            return true
          },
          writeLock.withPermit,
        )

        return StateStore.of({
          get,
          advanceOffset,
          hasDeliveredReply,
          markReplyDelivered,
        })
      }),
    )
  }
}
