/**
 * Backend barrels: the public surface is unchanged, but the implementation is
 * split into focused modules (model, media, synthesis chain, runs).
 */
export * from "./backend/model.js";
export * from "./backend/media.js";
export * from "./backend/synthesis.js";
export * from "./backend/runs.js";
