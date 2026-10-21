// Where a harness's source and its backend's guide live. Timeline links are built from the
// connected backend's harness (launcher config "harness"), so each link points to the pinned
// commit of the harness that backend re-implements.
type HarnessInfo = { source: string; guide: string };

export const HARNESSES: Record<string, HarnessInfo> = {
  Codex: { source: "https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/", guide: "educodex" },
  pi: { source: "https://github.com/earendil-works/pi/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/", guide: "edupi" },
};

export type Links = { harness: string; source?: (path: string) => string; guide?: (chapter: string) => string };

export function linksFor(harness: string): Links {
  const h = HARNESSES[harness];
  return {
    harness,
    source: h && ((path) => h.source + path),
    // The launcher serves docs/guide/<section>/<chapter>-*.md at /guide/<section>/<chapter>.
    guide: h && ((chapter) => `/guide/${h.guide}/${chapter}`),
  };
}
