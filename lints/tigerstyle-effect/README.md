# tigerstyle-effect

An `oxlint` JS plugin and preset config that enforce mechanically checkable TigerStyle principles in Effect TypeScript codebases.

- Zero runtime dependencies (`plugin.mjs` is a standalone ESM module for `oxlint` `jsPlugins`).
- Ready-to-use `oxlintrc.json` preset pairing the custom rules with complementary built-in `oxlint` rules (including `max-lines-per-function` capped at 70 lines and `require-yield: "off"` so `Effect.gen` does not trigger false positives).

## Setup

### Option 1: Extend the preset config (recommended)

Point `extends` in your project's `.oxlintrc.json` at `lints/tigerstyle-effect/oxlintrc.json`. `oxlint` resolves `jsPlugins` relative to the extended config file, so both the custom plugin and the built-in rules load automatically:

```json
{
  "extends": ["./path/to/clanker_whips/lints/tigerstyle-effect/oxlintrc.json"]
}
```

### Option 2: Load only the JS plugin

If you maintain your own built-in rule set, register `plugin.mjs` directly under `jsPlugins`:

```json
{
  "jsPlugins": ["./path/to/clanker_whips/lints/tigerstyle-effect/plugin.mjs"],
  "rules": {
    "tigerstyle-effect/no-unbounded-loop": "error",
    "tigerstyle-effect/no-direct-recursion": "error",
    "tigerstyle-effect/no-swallowed-error": "error",
    "tigerstyle-effect/no-nested-effect-in-sync": "error",
    "tigerstyle-effect/no-untracked-throw": "error",
    "tigerstyle-effect/require-unit-suffix": "error"
  }
}
```

Then run `oxlint` as usual:

```bash
pnpm exec oxlint
```

## Custom Rules

| Rule | Purpose |
| --- | --- |
| `tigerstyle-effect/no-unbounded-loop` | Flags `while (true)`, `do ... while (true)`, `for (;;)`, `Effect.forever(...)`, and `Effect.repeat` / `Effect.retry` calls without an explicit bound (`times`, `while`, `until`, `Schedule.recurs`, `Schedule.upTo`, or `Schedule.intersect` with a bounded schedule). |
| `tigerstyle-effect/no-direct-recursion` | Flags direct self-recursive functions, arrow functions, `Effect.fn` bodies, and class methods (instance and static) so execution stays iterative and bounded. |
| `tigerstyle-effect/no-swallowed-error` | Flags empty `catch {}` blocks, `Effect.ignore`, and `Effect.catchAll` / `Effect.catch` / `Effect.catchTag` / `Effect.catchTags` handlers that silently return `Effect.void`, `Effect.succeed(undefined)`, or an empty body without logging or handling the error. |
| `tigerstyle-effect/no-nested-effect-in-sync` | Flags `Effect.sync`, `Effect.try`, and `Effect.tryPromise` callbacks that construct or return an unexecuted `Effect.*` value (such as `Effect.logError` or `Effect.fail`) instead of composing it in `Effect.gen` or `Effect.flatMap`. |
| `tigerstyle-effect/no-untracked-throw` | Flags raw `throw` statements directly inside `Effect.gen`, `Effect.fn`, and `Effect.fnUntraced` bodies so expected domain errors use `Effect.fail` and invariant violations use `Effect.die`. |
| `tigerstyle-effect/require-unit-suffix` | Flags ambiguous duration and byte/memory size identifiers (such as `timeout`, `delay`, `interval`, `ttl`, `maxSize`, `bufferSize`, `retry_delay`, `buffer_size`) that omit an explicit unit suffix (`Ms`/`_ms`, `Seconds`/`_s`, `Bytes`/`_bytes`, `Kb`/`Mb`) and are not typed as Effect `Duration`. |

## Complementary Built-in Rules in `oxlintrc.json`

- `max-lines-per-function`: max 70 lines (skipping blank lines and comments)
- `max-depth`: max nesting depth 4
- `no-constant-condition`: error on constant conditions including loops (`checkLoops: "all"`)
- `no-empty`, `no-eval`, `no-implied-eval`, `no-new-func`, `no-with`, `no-var`, `prefer-const`, `eqeqeq`, `curly`, `no-unmodified-loop-condition`, `no-unreachable-loop`, `no-throw-literal`, `no-debugger`
- `require-yield`: `"off"` to avoid false positives on `Effect.gen` and `Effect.fn` generators without `yield*`

## Verification

Run the test suite and self-lint from `lints/tigerstyle-effect/`:

```bash
pnpm install
pnpm test
pnpm run lint
```
