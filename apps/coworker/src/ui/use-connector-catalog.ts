import { useCallback, useEffect, useState } from "react";
import { listConnectionPresets, listUsableConnections, type DenSession } from "@/lib/den";
import type { ConnectorCatalog } from "@/lib/marketplace";

const SIGNED_OUT: ConnectorCatalog = { signedIn: false, connections: [], presets: [] };

/** The member's connectors as OpenWork's Library lists them, re-read whenever the window comes back (after a browser sign-in). */
export function useConnectorCatalog(session: DenSession | null, enabled: boolean) {
  const [catalog, setCatalog] = useState<ConnectorCatalog>(SIGNED_OUT);
  const [loading, setLoading] = useState(Boolean(session) && enabled);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!session || !enabled) {
      setCatalog(session ? { signedIn: true, connections: [], presets: [] } : SIGNED_OUT);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [connections, presets] = await Promise.all([listUsableConnections(session), listConnectionPresets(session)]);
      setCatalog({ signedIn: true, connections, presets });
      setError("");
    } catch (cause) {
      setCatalog({ signedIn: true, connections: [], presets: [] });
      setError(`Apps could not be read from OpenWork. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setLoading(false);
    }
  }, [enabled, session]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);
  return { catalog, loading, error, refresh };
}
