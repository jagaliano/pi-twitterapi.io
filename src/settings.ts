import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PiSettings = Record<string, unknown>;

/**
 * A settings file plus, when it could not be used, why not.
 *
 * A malformed file must never take the tool down: `twitter` is registered from
 * this, and a stray trailing comma in a cloned repo's `.pi/settings.json` used to
 * throw at registration time, silently removing the tool (G2).
 */
export interface PiSettingsRead {
	settings: PiSettings;
	/** Human-readable reason the file was ignored; unset when it was read fine. */
	error?: string;
}

function readJsonFile(filePath: string): PiSettingsRead {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return { settings: {} };
		return { settings: {}, error: `${filePath} could not be read: ${err.message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { settings: {}, error: `${filePath} is not valid JSON: ${(error as Error).message}` };
	}
	if (!isPlainObject(parsed)) {
		return { settings: {}, error: `${filePath} is not a JSON object` };
	}
	return { settings: parsed };
}

export function readPiProjectSettingsResult(cwd = process.cwd()): PiSettingsRead {
	return readJsonFile(join(cwd, ".pi", "settings.json"));
}

export function readPiProjectSettings(cwd = process.cwd()): PiSettings {
	return readPiProjectSettingsResult(cwd).settings;
}

/**
 * Read the global settings file. The directory comes from pi's `getAgentDir()`,
 * so `PI_CODING_AGENT_DIR` (and any other supported override) is respected
 * instead of assuming `~/.pi/agent`.
 */
export function readPiUserSettingsResult(agentDir = getAgentDir()): PiSettingsRead {
	return readJsonFile(join(agentDir, "settings.json"));
}

export function readPiUserSettings(agentDir = getAgentDir()): PiSettings {
	return readPiUserSettingsResult(agentDir).settings;
}

export interface ReadMergedPiSettingsOptions {
	cwd?: string;
	/** Override the global agent config directory (defaults to pi's `getAgentDir()`). */
	agentDir?: string;
}

export function mergePiSettings(userSettings: PiSettings = {}, projectSettings: PiSettings = {}): PiSettings {
	return deepMerge(userSettings, projectSettings);
}

export function readMergedPiSettings(options: ReadMergedPiSettingsOptions = {}): PiSettings {
	return mergePiSettings(
		readPiUserSettings(options.agentDir),
		readPiProjectSettings(options.cwd),
	);
}

function deepMerge(base: PiSettings, override: PiSettings): PiSettings {
	const result: PiSettings = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;

		const existing = result[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			result[key] = deepMerge(existing, value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function isPlainObject(value: unknown): value is PiSettings {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
