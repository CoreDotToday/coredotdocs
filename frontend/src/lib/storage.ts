"use client";

import { useCallback, useSyncExternalStore } from "react";

// localStorage 값을 서버 렌더와 어긋나지 않게 읽는다 (서버 스냅샷은 null → 수화 뒤 실제 값).
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function useLocalStorage(key: string): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const set = useCallback(
    (v: string | null) => {
      try {
        if (v === null) localStorage.removeItem(key);
        else localStorage.setItem(key, v);
      } catch {}
      notify();
    },
    [key],
  );
  return [value, set];
}
