// Mirrors pi packages/ai/src/utils/uuid.ts (pinned 16f5f0af4): time-ordered UUIDv7 ids. pi uses
// them for session ids, so session files sort by creation time. edupi leaves out pi's counter
// that keeps ids made in the same millisecond in order; the other 74 bits are random.

/** A UUIDv7: 48 bits of Unix ms time, the version 7, the variant bits, then random bits. */
export function uuidv7(timestampMs: number = Date.now()): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	const timestamp = BigInt(timestampMs);
	for (let index = 5; index >= 0; index--) {
		bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
	}
	bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
	bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10xx
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
