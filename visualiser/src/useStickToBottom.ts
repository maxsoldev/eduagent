import { useEffect, useRef, useState } from "react";

// A list that follows new rows while it is scrolled to the bottom, and stops when the user scrolls up.
// `marker` grows with each new row (a count or the last seq); `reset` (e.g. a thread id) starts over.
// isFresh(m) is true for rows whose marker is newer than the previous render's, for a short flash.
export function useStickToBottom(marker: number, reset?: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const seen = useRef<{ reset: unknown; marker: number } | null>(null);
	const [freshAfter, setFreshAfter] = useState<number | null>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const prev = seen.current;
		seen.current = { reset, marker };
		if (stick.current) el.scrollTop = el.scrollHeight;
		if (!prev || prev.reset !== reset || marker <= prev.marker) return;
		setFreshAfter(prev.marker);
		const t = setTimeout(() => setFreshAfter(null), 1600);
		return () => clearTimeout(t);
	}, [marker, reset]);
	// Only an upward scroll unsticks: rows arriving between our scroll and its event must not count.
	const lastTop = useRef(0);
	const onScroll = () => {
		const el = ref.current!;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) stick.current = true;
		else if (el.scrollTop < lastTop.current) stick.current = false;
		lastTop.current = el.scrollTop;
		if (stick.current !== atBottom) setAtBottom(stick.current);
	};
	const toBottom = () => ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
	const isFresh = (m: number) => freshAfter !== null && m > freshAfter;
	return { ref, onScroll, atBottom, toBottom, isFresh };
}
