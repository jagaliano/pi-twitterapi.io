import assert from "node:assert/strict";
import test from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergePiSettings, readMergedPiSettings, readPiProjectSettings, readPiUserSettings } from "./settings.js";

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-twitterapi-settings-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readPiUserSettings reads settings.json from an explicit agent dir", () => {
  const { dir, cleanup } = scratch();
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ twitter: { synthesisModel: "anthropic/haiku" } }));
    assert.deepEqual(readPiUserSettings(dir), { twitter: { synthesisModel: "anthropic/haiku" } });
  } finally {
    cleanup();
  }
});

test("readPiUserSettings returns {} when the file is missing", () => {
  const { dir, cleanup } = scratch();
  try {
    assert.deepEqual(readPiUserSettings(dir), {});
  } finally {
    cleanup();
  }
});

test("readPiProjectSettings reads the project .pi/settings.json", () => {
  const { dir, cleanup } = scratch();
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ twitter: { maxPages: 2 } }));
    assert.deepEqual(readPiProjectSettings(dir), { twitter: { maxPages: 2 } });
  } finally {
    cleanup();
  }
});

test("readMergedPiSettings lets project settings override the user block", () => {
  const { dir, cleanup } = scratch();
  try {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ twitter: { synthesisModel: "anthropic/haiku", maxPages: 5 } }),
    );
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ twitter: { maxPages: 2 } }));
    assert.deepEqual(readMergedPiSettings({ agentDir, cwd }), {
      twitter: { synthesisModel: "anthropic/haiku", maxPages: 2 },
    });
  } finally {
    cleanup();
  }
});

test("readPiUserSettings honours PI_CODING_AGENT_DIR by default", () => {
  const { dir, cleanup } = scratch();
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ twitter: { maxPages: 1 } }));
    process.env.PI_CODING_AGENT_DIR = dir;
    assert.deepEqual(readPiUserSettings(), { twitter: { maxPages: 1 } });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    cleanup();
  }
});

test("deep merge keeps unrelated top-level keys from both scopes", () => {
  assert.deepEqual(mergePiSettings({ a: { x: 1 }, keep: true }, { a: { y: 2 } }), {
    a: { x: 1, y: 2 },
    keep: true,
  });
});
