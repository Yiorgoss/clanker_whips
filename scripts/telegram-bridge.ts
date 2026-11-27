#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"

import { runCli } from "../packages/telegram-bridge/src/index.ts"

export * from "../packages/telegram-bridge/src/index.ts"

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  const exitCode = await runCli()
  process.exitCode = exitCode
}
