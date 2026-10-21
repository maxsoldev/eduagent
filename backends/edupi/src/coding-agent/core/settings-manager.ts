// Mirrors pi packages/coding-agent/src/core/settings-manager.ts and settings-defaults.ts (pinned
// 16f5f0af4): settings from <agent dir>/settings.json. edupi reads only the compaction settings,
// and only the global file: pi also merges <cwd>/.pi/settings.json once the project is trusted.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.ts";

interface Settings {
	compaction?: Partial<CompactionSettings>;
}

export class SettingsManager {
	private constructor(private readonly settings: Settings) {}

	/** Reads <agentDir>/settings.json. A missing file means pi's defaults. */
	static create(agentDir: string = getAgentDir()): SettingsManager {
		const path = join(agentDir, "settings.json");
		return new SettingsManager(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Settings) : {});
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled;
	}

	getCompactionSettings(): CompactionSettings {
		const compaction = this.settings.compaction;
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};
	}
}
