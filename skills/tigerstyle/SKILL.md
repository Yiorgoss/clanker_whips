---
name: tigerstyle
description: TigerStyle programming principles (Safety, Performance, Developer Experience). Use when writing or reviewing safety-critical or systems code, applying TigerStyle, hardening invariants, resource bounds, or error handling, or designing deterministic simulation tests.
---

# TigerStyle

Apply TigerStyle in strict priority order: **Safety** first, **Performance** second, **Developer Experience** third. When goals conflict, satisfy the higher priority.

Apply this reference during both implementation and code review. Before finishing, account for every principle below across every touched function, boundary, and data structure.

## 1. Safety

### Static allocation and bounded resources

- Allocate memory, buffers, pools, and arenas up front at startup where possible so steady-state execution stays bounded and predictable.
- Enforce an explicit, fixed upper bound on every loop, queue, buffer, batch, and retry count.
- Use bounded iteration with explicit caps instead of unbounded loops or recursion.
- Size queues and buffers explicitly and define backpressure or explicit rejection when capacity is reached.

### Dense assertions

- Assert preconditions, postconditions, and invariants aggressively, targeting at least two assertions per function.
- Split compound assertions into separate statements (`assert(a)` then `assert(b)`) so a failure pinpoints the exact violated invariant.
- Assert **positive space** (conditions that must hold) and **negative space** (impossible states, invalid ranges, and transitions that must never happen).
- **Pair assertions** across boundaries: check the same invariant on both sides of a boundary (for example, before writing to storage or the wire and again on read-back, or on enqueue and dequeue).
- Assert compile-time invariants (struct layouts, sizes, constant relationships) wherever the language supports static assertions.

### Crash on programmer bugs, handle operational errors explicitly

- Separate **programmer errors** (violated invariants, unreachable branches, invalid internal arguments) from **operational errors** (I/O failures, timeouts, resource exhaustion, malformed external input).
- Fail fast on programmer errors by crashing immediately via assertion or abort so corrupt state stops at the bug instead of propagating.
- Handle every operational error explicitly at the point it occurs: propagate it, retry within a fixed bound, or fail cleanly. Never swallow errors or continue in a corrupt state.

### Explicitly sized types and simple control flow

- Use explicitly sized fixed-width types (such as `u32`, `u64`, `i64`, `uint32_t`) for interfaces, persisted layouts, counters, and arithmetic where bit width or signedness matters.
- Keep functions short with a ~70-line ceiling so each function fits on one screen and can be verified in one read; split larger routines into cohesive helpers with clear invariants.
- Keep control flow flat and direct: use early returns, explicit state machines, and straightforward branches instead of deep nesting or clever abstractions.

## 2. Performance

### Batching

- Amortize fixed per-item overhead (syscalls, locks, network round trips, disk flushes, allocations) by operating on batches of items instead of one item at a time.
- Cap every batch with an explicit maximum size so throughput gains preserve bounded memory and tail latency.

### Back-of-the-envelope math

- Before writing code, calculate back-of-the-envelope estimates for throughput, latency, memory footprint, and I/O volume to know the theoretical limits of network, disk, memory, and CPU.
- Check proposed designs against those limits so optimization targets the real bottleneck rather than guesswork.

## 3. Developer Experience

### Big-endian naming with units

- Order identifier parts from most significant to least significant (big-endian), placing qualifiers and explicit units at the end (for example, `timeout_ms`, `size_bytes`, `buffer_size_max`).
- Share prefixes across related identifiers so they align visually, sort together, and expose unit mismatches at every call site.

### Zero or minimal external dependencies

- Default to zero external dependencies; add a dependency only when its capability clearly justifies the supply-chain, build, security, and runtime complexity cost.
- Favor small, self-contained implementations you control so builds stay fast and runtime behavior stays predictable.

### Comments explain why, not what

- Write comments that explain *why*: invariants, non-obvious tradeoffs, ordering requirements, failure modes, and design rationale.
- Rely on clear names and simple control flow to show *what* the code does, and omit comments that restate syntax.

### Deterministic simulation testing (DST)

- Route every source of nondeterminism - time and clocks, randomness/PRNG, disk I/O, and network - through controllable interfaces driven by a single seed.
- Inject faults deterministically (drops, reordering, partitions, crashes, corrupt reads, clock skew) so rare distributed-system and concurrency bugs reproduce reliably from one seed.
