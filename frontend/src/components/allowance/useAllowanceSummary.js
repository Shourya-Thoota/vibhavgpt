import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.js";
import { ALLOWANCE_LOAD_STATES, allowanceLoadErrorState } from "./allowance-view.js";

const EMPTY = Object.freeze({ forUserId: null, status: ALLOWANCE_LOAD_STATES.IDLE, summary: null, error: null });

/**
 * Loads GET /api/usage/allowance for the signed-in account.
 *
 * State is tagged with the account it was loaded for. When the account changes
 * or signs out, results for any other account are never returned, even for the
 * render before effects run, and in-flight requests for the old account are
 * aborted and ignored. Nothing is cached outside React state.
 */
export function useAllowanceSummary({ userId = null, enabled = false } = {}) {
  const [state, setState] = useState(EMPTY);
  const controllerRef = useRef(null);
  const activeUserRef = useRef(userId);
  activeUserRef.current = userId;

  const load = useCallback(async () => {
    if (!enabled || !userId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const forUserId = userId;
    setState((prev) => ({
      forUserId,
      status: ALLOWANCE_LOAD_STATES.LOADING,
      // Keep the current account's last figures visible while refreshing.
      summary: prev.forUserId === forUserId ? prev.summary : null,
      error: null,
    }));
    try {
      const summary = await api("/api/usage/allowance", { signal: controller.signal });
      if (controller.signal.aborted || activeUserRef.current !== forUserId) return;
      setState({ forUserId, status: ALLOWANCE_LOAD_STATES.READY, summary, error: null });
    } catch (error) {
      if (controller.signal.aborted || activeUserRef.current !== forUserId) return;
      const status = allowanceLoadErrorState(error);
      // An expired session or disabled feature must not keep showing old figures.
      setState((prev) => ({
        forUserId,
        status,
        summary: status === ALLOWANCE_LOAD_STATES.ERROR && prev.forUserId === forUserId ? prev.summary : null,
        error,
      }));
    }
  }, [enabled, userId]);

  useEffect(() => {
    setState(EMPTY);
    if (!enabled || !userId) return undefined;
    load();
    const refresh = () => load();
    window.addEventListener("vibhavgpt:subscription-changed", refresh);
    window.addEventListener("vibhavgpt:allowance-changed", refresh);
    return () => {
      window.removeEventListener("vibhavgpt:subscription-changed", refresh);
      window.removeEventListener("vibhavgpt:allowance-changed", refresh);
      controllerRef.current?.abort();
    };
  }, [enabled, userId, load]);

  const current = enabled && userId && state.forUserId === userId ? state : null;
  return {
    status: current?.status ?? (enabled && userId ? ALLOWANCE_LOAD_STATES.LOADING : ALLOWANCE_LOAD_STATES.IDLE),
    summary: current?.summary ?? null,
    error: current?.error ?? null,
    reload: load,
  };
}
