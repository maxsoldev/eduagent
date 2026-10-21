// The launcher's API: GET /backends lists the backends, and /backends/<name>?cwd=<dir> is the WebSocket
// that starts one backend process for this viewer (launcher/src/server.ts).
import type { BackendList } from "@eduagent/launcher/api";

export type { BackendInfo, BackendList } from "@eduagent/launcher/api";

export async function fetchBackends(): Promise<BackendList> {
  const res = await fetch("/backends");
  if (!res.ok) throw new Error(`GET /backends: ${res.status}`);
  return res.json();
}

export function backendUrl(name: string, cwd: string): string {
  const base = import.meta.env.VITE_LAUNCHER_URL as string | undefined ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base}/backends/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`;
}
