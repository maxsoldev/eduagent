import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BackendPicker } from "./components/BackendPicker";
import { fetchBackends, type BackendList } from "./launcher";
import { ADAPTERS } from "./adapters";
import "./styles.css";

// Without ?backend=..., show the picker. With it, connect to that backend through the launcher.
function Root() {
  const [list, setList] = useState<BackendList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchBackends().then(setList, (err) => setError(String(err))); }, []);
  if (error) return <div className="banner">Cannot reach the launcher ({error}). Start it with <code>pnpm eduagent</code>.</div>;
  if (!list) return null;
  const params = new URLSearchParams(location.search);
  const name = params.get("backend");
  if (!name) return <BackendPicker list={list} />;
  const backend = list.backends.find((b) => b.name === name);
  if (!backend) return <BackendPicker list={list} error={`Unknown backend: ${name}`} />;
  const module = ADAPTERS[backend.protocol]; // the adapter comes from the protocol named in the backend list
  if (!module) return <BackendPicker list={list} error={`No adapter yet for the ${backend.protocol} protocol.`} />;
  return <App backend={backend} cwd={params.get("cwd") || list.cwd} module={module} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
