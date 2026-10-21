// The launcher's API: GET /backends lists the backends, and /backends/<name>?cwd=<dir> is the WebSocket
// that starts one backend process for this viewer (launcher/src/server.ts).
export type BackendInfo = { name: string; harness: string; protocol: string; description?: string; capabilities: string[] };
export type BackendList = { cwd: string; backends: BackendInfo[] };

export async function fetchBackends(): Promise<BackendList> {
  const res = await fetch("/backends");
  if (!res.ok) throw new Error(`GET /backends: ${res.status}`);
  return res.json();
}

export function backendUrl(name: string, cwd: string): string {
  const base = import.meta.env.VITE_LAUNCHER_URL as string | undefined ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base}/backends/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`;
}
