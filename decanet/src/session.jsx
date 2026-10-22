import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.js";

const SessionContext = createContext(null);

// Who is signed in, their credits and chapter, plus the public catalog.
export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, account: null, credits: 0, chapter: null, catalog: null });
  const [toast, setToast] = useState(null);

  const refresh = useCallback(async () => {
    const me = await api("/me").catch(() => ({ account: null }));
    setState((current) => ({ ...current, loading: false, account: me.account, credits: me.credits ?? 0, chapter: me.chapter ?? null }));
    return me;
  }, []);

  useEffect(() => {
    refresh();
    api("/catalog").then((catalog) => setState((current) => ({ ...current, catalog }))).catch(() => {});
  }, [refresh]);

  const notify = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 3600);
  }, []);

  const eventByCode = useCallback((code) => state.catalog?.events.find((event) => event.code === code) ?? null, [state.catalog]);

  return (
    <SessionContext.Provider value={{ ...state, refresh, notify, eventByCode, setAccount: (account) => setState((current) => ({ ...current, account })) }}>
      {children}
      {toast && <div className="toast" role="status">{toast}</div>}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
