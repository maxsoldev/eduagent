import { useState } from "react";
import type { BackendList } from "../launcher";

// The first screen of a viewer: pick a backend and the directory it works in. Opening one navigates to
// ?backend=<name>&cwd=<dir>, so a reload reconnects to a fresh process of the same backend.
export function BackendPicker({ list, error }: { list: BackendList; error?: string }) {
	const [cwd, setCwd] = useState(list.cwd);
	const open = (name: string) => {
		location.search = new URLSearchParams({ backend: name, cwd }).toString();
	};
	return (
		<div className="picker" data-testid="backend-picker">
			<h1>eduagent</h1>
			<p className="muted">
				Pick a backend. Each viewer gets its own backend process. Open a second viewer (another browser tab) to
				compare two backends.
			</p>
			{error && <div className="banner">{error}</div>}
			<label className="picker-cwd">
				working directory <input value={cwd} onChange={(e) => setCwd(e.target.value)} data-testid="picker-cwd" />
			</label>
			<ul>
				{list.backends.map((b) => (
					<li key={b.name} data-testid={`backend-${b.name}`}>
						<div>
							<b>{b.name}</b>{" "}
							<span className="muted">
								re-implements {b.harness} · speaks {b.protocol}
							</span>
						</div>
						{b.description && <div className="muted small">{b.description}</div>}
						<button type="button" onClick={() => open(b.name)}>
							Open
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
