/** Optional, call-local display-only observer. Never changes execution semantics. */
export type ProgressCallback = (text: string) => void;

/** No late updates after cancellation; observer failures cannot trigger paid retries. */
export function reportProgress(
  options: { progress?: ProgressCallback; signal?: AbortSignal },
  text: string,
): void {
  if (!options.progress || options.signal?.aborted) return;
  try { void Promise.resolve(options.progress(text)).catch(() => {}); }
  catch { /* Display-only observer. */ }
}
