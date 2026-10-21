// Mirrors pi packages/coding-agent/src/core/settings-manager.ts and settings-defaults.ts (pinned
// 16f5f0af4): settings from <agent dir>/settings.json. edupi reads only the compaction settings,
// and only the global file: pi also merges <cwd>/.pi/settings.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.ts";

export class SettingsManager {
	private constructor(private readonly compaction: CompactionSettings) {}

	/** Reads <agentDir>/settings.json. A missing file or field means pi's default. */
	static create(agentDir: string = getAgentDir()): SettingsManager {
		const path = join(agentDir, "settings.json");
		const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
		return new SettingsManager({ ...DEFAULT_COMPACTION_SETTINGS, ...settings.compaction });
	}

	getCompactionEnabled(): boolean {
		return this.compaction.enabled;
	}

	getCompactionSettings(): CompactionSettings {
		return this.compaction;
	}
}
