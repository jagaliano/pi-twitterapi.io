import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExecFn } from "./video.js";

const MAX_ENTRIES = 128;
const MAX_PROBE_MS = 5_000;
// A custom executor must never inherit another executor's availability result.
const successes = new WeakMap<ExecFn, Map<string, string>>();
interface BinaryIdentity { path: string; stamp: string }

async function identity(bin: string, alive: () => boolean): Promise<BinaryIdentity | undefined> {
  const explicit = isAbsolute(bin) || bin.includes("/") || (process.platform === "win32" && bin.includes("\\"));
  const extensions = process.platform === "win32" && !/\.(exe|com)$/i.test(bin) ? ["", ".exe", ".com"] : [""];
  const pathEnv = process.env.PATH;
  if (!explicit && pathEnv === undefined) return undefined; // Do not guess the OS default search path.
  // Let realpath/OS traversal resolve symlink/..; resolve() and join() would
  // lexically erase those components and can select a different executable.
  const candidates = explicit ? [bin] : pathEnv!.split(delimiter)
    .flatMap(dir => extensions.map(ext => dir ? `${dir}${sep}${bin}${ext}` : bin + ext));
  for (const candidate of candidates) {
    if (!alive()) return undefined;
    try {
      const path = await realpath(candidate);
      const s = await stat(path, { bigint: true });
      await access(path, constants.X_OK);
      if (s.isFile()) return { path, stamp: [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].join(":") };
    } catch { /* Missing/inaccessible/unstatable paths are never memoized. */ }
  }
  return undefined;
}

/**
 * Process-local positive availability cache, not a promise cache. Concurrent
 * misses probe independently with their own signal/deadline: cancellation and
 * transient failure cannot poison another caller. Unknown file identities can
 * still be probed (custom executors), but cannot produce reusable cache entries.
 */
export async function cachedCheckBinary(
  exec: ExecFn,
  bin: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<boolean> {
  if (options.signal?.aborted || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return false;
  const budget = Math.min(MAX_PROBE_MS, options.timeoutMs);
  const until = performance.now() + budget;
  return new Promise<boolean>(resolveResult => {
    let done = false;
    let pending: BinaryIdentity | undefined;
    const alive = () => !done && !options.signal?.aborted && performance.now() < until;
    const finish = (value: boolean) => {
      if (done) return;
      // A queued microtask may consume the remaining deadline before timers run.
      // Commit new positives only at the same checked boundary as delivery.
      const accepted = value && alive();
      if (accepted && pending) {
        const entries = successes.get(exec) ?? new Map<string, string>();
        entries.delete(pending.path);
        entries.set(pending.path, pending.stamp);
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
        successes.set(exec, entries);
      }
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveResult(accepted);
    };
    const abort = () => finish(false);
    // Also bounds metadata I/O and uncooperative injected executors. No late
    // resolution may start a probe or populate the success cache after return.
    const timer = setTimeout(abort, budget);
    options.signal?.addEventListener("abort", abort, { once: true });
    const run = async () => {
      const before = await identity(bin, alive);
      if (!alive()) return false;
      const cache = successes.get(exec);
      if (before && cache?.get(before.path) === before.stamp) return true;
      await exec(before?.path ?? bin, ["-version"], {
        timeout: Math.max(1, Math.ceil(until - performance.now())),
        signal: options.signal,
      });
      if (!alive()) return false;
      if (before) {
        // Re-resolve the requested path, not just the old target: catches PATH
        // changes, symlink retargeting, replacement, edits and chmod mid-probe.
        const after = await identity(bin, alive);
        if (!alive() || !after || after.path !== before.path || after.stamp !== before.stamp) return false;
        pending = before;
      }
      return true;
    };
    // Failures (including non-ENOENT errors, timeout and cancellation) are not
    // availability successes and never overwrite another caller's valid entry.
    void run().then(finish, () => finish(false));
  });
}
