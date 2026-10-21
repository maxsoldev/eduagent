// pi-only parts. pi's edit tool returns a diff in result.details: "+NN line" (added, new line
// number), "-NN line" (removed, old line number), " NN line" (context) and " ..." (skipped lines).
// Source: packages/coding-agent/src/core/tools/edit-diff.ts generateDiffString, at the pinned commit.

import { Status, ToolCard } from "../../components/parts";
import type { Entry, NativePart } from "../../view/model";

export function NativeEntry({ entry, part }: { entry: Entry; part: NativePart }) {
	if (part.type === "editDiff" && entry.kind === "tool")
		return <EditDiff entry={entry} path={part.data.path} diff={part.data.diff} />;
	return <pre className="small">{JSON.stringify(part.data)}</pre>;
}

function EditDiff({ entry, path, diff }: { entry: Extract<Entry, { kind: "tool" }>; path: string; diff: string }) {
	return (
		<ToolCard
			testId="edit-diff"
			head={
				<>
					<span className="badge patch">edit</span>
					<code className="grow">{path}</code>
					<Status s={entry.status} />
				</>
			}
		>
			<pre className="diff">
				{diff.split("\n").map((line, i) => (
					<span key={i} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>
						{`${line}\n`}
					</span>
				))}
			</pre>
			{entry.output && <pre className="out">{entry.output}</pre>}
		</ToolCard>
	);
}
