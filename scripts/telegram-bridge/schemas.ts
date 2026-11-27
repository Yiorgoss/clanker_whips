import { Schema } from "effect"

export const NonNegativeIntSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

export const PositiveIntSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
)

export const BotTokenSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[^\s/?#]+$/)),
)

export const PrivateChatIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[1-9]\d*$/)),
)

export const ApiBaseUrlSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https?:\/\/.+/)),
)

export const TelegramChatSchema = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  type: Schema.String,
})

export type TelegramChat = typeof TelegramChatSchema["Type"]

export const TelegramMessageSchema = Schema.Struct({
  chat: TelegramChatSchema,
  text: Schema.optional(Schema.String),
})

export type TelegramMessage = typeof TelegramMessageSchema["Type"]

export const TelegramUpdateSchema = Schema.Struct({
  update_id: Schema.Int,
  message: Schema.optional(TelegramMessageSchema),
})

export type TelegramUpdate = typeof TelegramUpdateSchema["Type"]

export const TelegramErrorParametersSchema = Schema.Struct({
  retry_after: Schema.optional(Schema.Int),
})

export const TelegramApiResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(TelegramErrorParametersSchema),
})

export type TelegramApiResponse = typeof TelegramApiResponseSchema["Type"]

export const TelegramApiResponseJsonSchema = Schema.fromJsonString(TelegramApiResponseSchema)

export const TelegramGetUpdatesResultSchema = Schema.Array(TelegramUpdateSchema)

export const TelegramSendMessageResultSchema = Schema.Struct({
  message_id: Schema.Int,
})

export type TelegramSendMessageResult = typeof TelegramSendMessageResultSchema["Type"]

export const FmInboxNoteResponseSchema = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyString),
  outcome: Schema.optional(Schema.NonEmptyString),
  saved: Schema.optional(Schema.Boolean),
  announced: Schema.optional(Schema.Boolean),
})

export type FmInboxNoteResponse = typeof FmInboxNoteResponseSchema["Type"]

export const FmInboxNoteResponseJsonSchema = Schema.fromJsonString(FmInboxNoteResponseSchema)

export const FmInboxReplySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  body: Schema.String,
  at: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
})

export type FmInboxReply = typeof FmInboxReplySchema["Type"]

export const FmInboxReceiptsResponseSchema = Schema.Struct({
  replies: Schema.Array(Schema.Unknown),
})

export const FmInboxReceiptsResponseJsonSchema = Schema.fromJsonString(FmInboxReceiptsResponseSchema)

export const PersistedStateInputSchema = Schema.Struct({
  version: Schema.optional(Schema.Int),
  offset: Schema.optional(NonNegativeIntSchema),
  deliveredReplyIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export const PersistedStateJsonSchema = Schema.fromJsonString(PersistedStateInputSchema)

export const BridgeStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  offset: NonNegativeIntSchema,
  deliveredReplyIds: Schema.Array(Schema.NonEmptyString),
})

export type BridgeState = typeof BridgeStateSchema["Type"]

export const BridgeStateJsonSchema = Schema.fromJsonString(BridgeStateSchema, {
  space: 2,
})
