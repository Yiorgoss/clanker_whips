import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(TEST_DIR, "..");
const OXLINT_BIN = path.join(PKG_DIR, "node_modules", ".bin", "oxlint");
const PRESET_CONFIG = path.join(PKG_DIR, "oxlintrc.json");
const OXLINT_TIMEOUT_MS = 15_000;

function runOxlintOnSource(sourceCode, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tigerstyle-effect-test-"));
  const filePath = path.join(tmpDir, options.filename ?? "fixture.ts");
  const configPath = options.useExtends
    ? path.join(tmpDir, ".oxlintrc.json")
    : PRESET_CONFIG;

  try {
    fs.writeFileSync(filePath, sourceCode, "utf8");
    if (options.useExtends) {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ extends: [PRESET_CONFIG] }, null, 2),
        "utf8",
      );
    }

    let stdout = "";
    let exitCode = 0;
    try {
      stdout = execFileSync(OXLINT_BIN, ["-c", configPath, "--format", "json", filePath], {
        encoding: "utf8",
        timeout: OXLINT_TIMEOUT_MS,
      });
    } catch (err) {
      if (typeof err.status !== "number") {
        throw err;
      }
      exitCode = err.status;
      stdout = String(err.stdout ?? "");
    }

    const parsed = JSON.parse(stdout);
    return { exitCode, diagnostics: parsed.diagnostics ?? [] };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getRuleCodes(diagnostics) {
  return diagnostics.map((d) => d.code);
}

function assertHasRule(sourceCode, expectedRuleCode, expectedCount) {
  const result = runOxlintOnSource(sourceCode);
  const matching = result.diagnostics.filter((d) => d.code === expectedRuleCode);
  assert.ok(
    matching.length >= (expectedCount ?? 1),
    `Expected at least ${expectedCount ?? 1} diagnostic(s) for ${expectedRuleCode}, got ${matching.length}. All diagnostics: ${JSON.stringify(result.diagnostics, null, 2)}`,
  );
  if (expectedCount !== undefined) {
    assert.equal(
      matching.length,
      expectedCount,
      `Expected exactly ${expectedCount} diagnostic(s) for ${expectedRuleCode}, got ${matching.length}. Diagnostics: ${JSON.stringify(matching, null, 2)}`,
    );
  }
  return result;
}

function assertNoErrors(sourceCode, options = {}) {
  const result = runOxlintOnSource(sourceCode, options);
  assert.equal(
    result.diagnostics.length,
    0,
    `Expected 0 diagnostics, got ${result.diagnostics.length}: ${JSON.stringify(result.diagnostics, null, 2)}`,
  );
  assert.equal(result.exitCode, 0);
}

const VALID_EFFECT_PROGRAM = `
declare const Effect: any;
declare const Schedule: any;
declare const Duration: any;
declare function pipe(...args: any[]): any;

export interface ClientConfig {
  requestTimeoutMs: number;
  maxPayloadSizeBytes: number;
  retryDelay: Duration.Duration;
  batchSize: number;
}

export class Worker {
  private readonly pollIntervalMs = 250;
  private readonly bufferSizeKb = 64;

  runBatch(items: number[], maxAttempts: number): number {
    let total = 0;
    for (let i = 0; i < items.length && i < maxAttempts; i += 1) {
      total += items[i] ?? 0;
    }
    return total;
  }

  delegate(other: { delegate: () => number }): number {
    return other.delegate();
  }
}

export const pureGenWithoutYield = Effect.gen(function* () {
  return 42;
});

export const fetchWithBoundedRetry = Effect.fn("fetchWithBoundedRetry")(function* (
  url: string,
  timeoutMs: number,
  timeout: Duration.Duration,
) {
  const delaySeconds = 1;
  const max_size_bytes = 4096;
  const hasTimeout = timeoutMs > 0;
  const fallbackTimeout = Duration.seconds(5);
  const delay = (delayMs: number) => Effect.sleep(delayMs);

  const boundedSchedule = Schedule.exponential("100 millis").pipe(
    Schedule.intersect(Schedule.recurs(5)),
  );

  const raw = yield* Effect.try({
    try: () => {
      if (!url) {
        throw new Error("missing url");
      }
      return JSON.stringify({
        url,
        delaySeconds,
        max_size_bytes,
        hasTimeout,
        timeout,
        fallbackTimeout,
      });
    },
    catch: (cause) => ({ _tag: "ParseError", cause }),
  });

  const checked = yield* Effect.sync(() => Effect.isEffect(raw));
  const factory = yield* Effect.sync(() => ({
    trigger: () => Effect.logInfo("deferred effect"),
  }));

  yield* delay(10);
  const retried = yield* Effect.retry(Effect.succeed(raw), boundedSchedule);
  const retriedByTimes = yield* pipe(
    Effect.succeed(retried),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 3 }),
    Effect.repeat({ until: (val: string) => val.length > 0 }),
    Effect.catchTag("ParseError", () => Effect.succeed(null)),
    Effect.catchAll((err: unknown) => Effect.logError("fetch failed", err)),
  );

  yield* Effect.ignoreLogged(Effect.succeed(checked));
  return { retriedByTimes, factory };
});
`;

describe("tigerstyle-effect: valid Effect and TypeScript baseline", () => {
  it("passes idiomatic TigerStyle + Effect code with zero diagnostics", () => {
    assertNoErrors(VALID_EFFECT_PROGRAM);
  });

  it("works when a downstream project uses extends pointing to oxlintrc.json", () => {
    assertNoErrors(VALID_EFFECT_PROGRAM, { useExtends: true });
    const bad = runOxlintOnSource("export const timeout = 5000;\n", { useExtends: true });
    assert.deepEqual(getRuleCodes(bad.diagnostics), ["tigerstyle-effect(require-unit-suffix)"]);
  });
});

const INVALID_UNBOUNDED_LOOPS = `
declare const Effect: any;
declare function pipe(...args: any[]): any;
declare function step(): boolean;
declare const task: any;

export function badLoops() {
  while (true) {
    if (step()) {
      break;
    }
  }
  do {
    if (step()) {
      break;
    }
  } while (!false);
  for (;;) {
    if (step()) {
      break;
    }
  }
  const a = Effect.forever(task);
  const b = pipe(task, Effect.forever);
  return [a, b];
}
`;

const INVALID_UNBOUNDED_POLICIES = `
declare const Effect: any;
declare const Schedule: any;
declare function pipe(...args: any[]): any;
declare const task: any;

const unboundedSchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);

export const badPolicies = [
  Effect.repeat(task, Schedule.spaced("1 second")),
  Effect.retry(task, Schedule.exponential("100 millis")),
  pipe(task, Effect.retry(Schedule.forever)),
  Effect.retry(task, { schedule: Schedule.fixed("500 millis") }),
  Effect.repeat(task, {}),
  Effect.retry(task, unboundedSchedule),
  Effect.retry(task, Schedule.union(Schedule.forever, Schedule.recurs(3))),
];
`;

const VALID_BOUNDED_LOOPS = `
declare const Effect: any;
declare const Schedule: any;
declare function pipe(...args: any[]): any;
declare const task: any;

export function boundedExamples(maxItems: number, externalPolicy: unknown) {
  let remaining = maxItems;
  while (remaining > 0) {
    remaining -= 1;
  }
  for (let i = 0; i < maxItems; i += 1) {
    remaining += i;
  }
  const capped = Schedule.intersect(Schedule.exponential("100 millis"), Schedule.recurs(4));
  return [
    Effect.repeat(task, { times: 5 }),
    Effect.repeat(task, { while: (n: number) => n < 5 }),
    Effect.repeat(task, { until: (n: number) => n >= 5 }),
    Effect.retry(task, { schedule: Schedule.spaced("100 millis"), times: 3 }),
    Effect.retry(task, Schedule.recurs(3)),
    Effect.retry(task, Schedule.exponential("100 millis").pipe(Schedule.upTo("5 seconds"))),
    pipe(task, Effect.retry(capped)),
    Effect.retry(task, externalPolicy),
  ];
}
`;

describe("tigerstyle-effect/no-unbounded-loop", () => {
  it("flags while(true), do-while(true), for(;;), and Effect.forever", () => {
    assertHasRule(INVALID_UNBOUNDED_LOOPS, "tigerstyle-effect(no-unbounded-loop)", 5);
  });

  it("flags unbounded Effect.repeat and Effect.retry policies", () => {
    assertHasRule(INVALID_UNBOUNDED_POLICIES, "tigerstyle-effect(no-unbounded-loop)", 7);
  });

  it("allows bounded loops and bounded repeat/retry policies", () => {
    assertNoErrors(VALID_BOUNDED_LOOPS);
  });
});

describe("tigerstyle-effect/no-direct-recursion", () => {
  it("flags recursive declarations, arrows, Effect.fn, and class methods", () => {
    assertHasRule(
      `
declare const Effect: any;

export function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

export const countdown = (n: number): number => (n <= 0 ? 0 : countdown(n - 1));

export const namedExpr = function inner(n: number): number {
  return n <= 0 ? 0 : inner(n - 1);
};

export const effectSelf = Effect.fn("effectSelf")(function* (n: number): any {
  if (n <= 0) {
    return 0;
  }
  return yield* effectSelf(n - 1);
});

export class Walker {
  walk(n: number): number {
    return n <= 0 ? 0 : this.walk(n - 1);
  }

  walkGen(n: number): any {
    return Effect.gen(this, function* () {
      if (n <= 0) {
        return 0;
      }
      return yield* this.walkGen(n - 1);
    });
  }

  static scan(n: number): number {
    return n <= 0 ? 0 : Walker.scan(n - 1);
  }
}
`,
      "tigerstyle-effect(no-direct-recursion)",
      7,
    );
  });

  it("allows shadowed names and calls to other objects with the same method name", () => {
    assertNoErrors(`
export function run(run: () => number): number {
  return run();
}

export function compute(): number {
  const compute = () => 7;
  return compute();
}

export class ProxyRunner {
  execute(delegate: { execute: () => number }): number {
    return delegate.execute();
  }
}
`);
  });
});

describe("tigerstyle-effect/no-swallowed-error", () => {
  it("flags empty catch blocks, Effect.ignore, and silent catch handlers", () => {
    assertHasRule(
      `
declare const Effect: any;
declare function pipe(...args: any[]): any;
declare function risky(): void;
declare const task: any;

export function swallowAll() {
  try {
    risky();
  } catch {}

  try {
    risky();
  } catch (err) {
    // intentionally empty statement list
  }

  return [
    Effect.ignore(task),
    pipe(task, Effect.ignore),
    Effect.catchAll(task, () => Effect.void),
    pipe(task, Effect.catch(() => Effect.void)),
    Effect.catchAll(task, (_err: unknown) => {
      return Effect.void;
    }),
    Effect.catchAll(task, () => Effect.succeed(undefined)),
    Effect.catchTags(task, { TransientError: () => Effect.void }),
  ];
}
`,
      "tigerstyle-effect(no-swallowed-error)",
      9,
    );
  });

  it("allows logged or handled errors and Effect.ignoreLogged", () => {
    assertNoErrors(`
declare const Effect: any;
declare function pipe(...args: any[]): any;
declare function risky(): void;
declare function recordError(err: unknown): void;
declare const task: any;

export function handleAll() {
  try {
    risky();
  } catch (err) {
    recordError(err);
  }

  return [
    Effect.ignoreLogged(task),
    pipe(task, Effect.ignoreLogged),
    Effect.catchAll(task, (err: unknown) => Effect.logError("boom", err)),
    Effect.catchTag(task, "NotFound", () => Effect.succeed(null)),
    Effect.catchAll(task, (err: unknown) => {
      recordError(err);
      return Effect.void;
    }),
  ];
}
`);
  });
});

describe("tigerstyle-effect/no-nested-effect-in-sync", () => {
  it("flags unexecuted Effect calls inside Effect.sync and Effect.try callbacks", () => {
    assertHasRule(
      `
declare const Effect: any;

export const badSyncs = [
  Effect.sync(() => Effect.logError("dropped")),
  Effect.sync(() => {
    Effect.logInfo("also dropped");
    return 1;
  }),
  Effect.sync(() => Effect.void),
  Effect.try(() => Effect.succeed(123)),
  Effect.try({
    try: () => JSON.parse("{}"),
    catch: (err: unknown) => Effect.logError("dropped in catch", err),
  }),
];
`,
      "tigerstyle-effect(no-nested-effect-in-sync)",
      5,
    );
  });

  it("allows pure sync logic, Effect.isEffect, Effect.runSync, and deferred factories", () => {
    assertNoErrors(`
declare const Effect: any;

export const goodSyncs = [
  Effect.sync(() => JSON.parse("{}")),
  Effect.sync(() => Effect.isEffect(123)),
  Effect.sync(() => Effect.runSync(Effect.succeed(1))),
  Effect.sync(() => ({
    onClick: () => Effect.logInfo("returned for later execution"),
  })),
  Effect.try({
    try: () => JSON.parse("{}"),
    catch: (cause: unknown) => ({ _tag: "ParseError", cause }),
  }),
];
`);
  });
});

describe("tigerstyle-effect/no-untracked-throw", () => {
  it("flags throw statements inside Effect.gen and Effect.fn bodies", () => {
    assertHasRule(
      `
declare const Effect: any;

export const genThrow = Effect.gen(function* () {
  if (Math.random() > 0.5) {
    throw new Error("untracked");
  }
  return yield* Effect.succeed(1);
});

export const fnNamedThrow = Effect.fn("fnNamedThrow")(function* (ok: boolean) {
  if (!ok) {
    throw new Error("untracked in named fn");
  }
  return 1;
});

export const fnDirectThrow = Effect.fn(function* (ok: boolean) {
  if (!ok) {
    throw new Error("untracked in direct fn");
  }
  return 1;
});

export const fnUntracedThrow = Effect.fnUntraced(function* (ok: boolean) {
  if (!ok) {
    throw new Error("untracked in untraced fn");
  }
  return 1;
});
`,
      "tigerstyle-effect(no-untracked-throw)",
      4,
    );
  });

  it("allows Effect.fail, Effect.die, throw inside Effect.try, and sync helpers", () => {
    assertNoErrors(`
declare const Effect: any;

export function syncBoundary(ok: boolean): number {
  if (!ok) {
    throw new Error("outside Effect.gen");
  }
  return 1;
}

export const safeEffect = Effect.gen(function* () {
  const parsed = yield* Effect.try(() => {
    if (Math.random() < 0) {
      throw new Error("caught by Effect.try");
    }
    return 1;
  });
  if (parsed < 0) {
    return yield* Effect.die(new Error("invariant violated"));
  }
  if (parsed === 0) {
    return yield* Effect.fail({ _tag: "ZeroError" });
  }
  return parsed;
});
`);
  });
});

describe("tigerstyle-effect/require-unit-suffix", () => {
  it("flags unitless duration and size identifiers in camelCase and snake_case", () => {
    assertHasRule(
      `
export const timeout = 5000;
export const TIMEOUT = 5000;
export const requestTimeout = 3000;
export const retry_delay = 250;
export const pollInterval = 1000;
export const ttl = 60;
export const maxSize = 1024;
export const MAX_SIZE = 1024;
export const bufferSize = 4096;
export const buffer_size = 4096;

export interface BadConfig {
  interval: number;
  max_size: number;
}

export class BadCache {
  ttl = 300;
  connect(delay: number): number {
    return delay;
  }
}
`,
      "tigerstyle-effect(require-unit-suffix)",
      14,
    );
  });

  it("allows unit-suffixed names, Effect Duration values, and non-byte count names", () => {
    assertNoErrors(`
declare const Duration: any;

export const timeoutMs = 5000;
export const request_timeout_ms = 3000;
export const retryDelaySeconds = 2;
export const retry_delay_s = 2;
export const pollIntervalMin = 1;
export const ttlSeconds = 60;
export const maxSizeBytes = 1024;
export const max_size_bytes = 1024;
export const bufferSizeKb = 64;
export const payloadSizeMb = 10;
export const batchSize = 50;
export const pageSize = 25;
export const hasTimeout = true;
export const timeout = Duration.seconds(5);
export const delay = (delayMs: number) => delayMs * 2;

export interface GoodConfig {
  timeout: Duration.Duration;
  delay: Duration.DurationInput;
  maxSizeBytes: number;
  poolSize: number;
}
`);
  });
});

describe("preset complementary built-in oxlint rules", () => {
  it("enforces max-lines-per-function at 70 lines, max-depth at 4, and no-eval", () => {
    const bodyLines = Array.from({ length: 71 }, (_, i) => `  total += ${i};`).join("\n");
    const longFnSource = `export function tooLong(): number {\n  let total = 0;\n${bodyLines}\n  return total;\n}\n`;
    assertHasRule(longFnSource, "eslint(max-lines-per-function)", 1);

    const deepSource = `
export function tooDeep(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean): number {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) {
            return 1;
          }
        }
      }
    }
  }
  return 0;
}
`;
    assertHasRule(deepSource, "eslint(max-depth)", 1);

    assertHasRule(`export const x = eval("1 + 1");\n`, "eslint(no-eval)", 1);
  });
});
