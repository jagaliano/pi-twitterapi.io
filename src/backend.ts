/**
 * Backend barrel: internal wiring for the split modules (model, media,
 * synthesis chain, runs). The *published* surface is `src/index.ts`, which
 * re-exports an explicit subset; `export *` here also exposes sibling-module
 * helpers (e.g. `applyFallbackNote`, `resolveSynthesisBackend`) to the rest of
 * the source tree by design.
 */
export * from "./backend/model.js";
export * from "./backend/media.js";
export * from "./backend/synthesis.js";
export * from "./backend/runs.js";
