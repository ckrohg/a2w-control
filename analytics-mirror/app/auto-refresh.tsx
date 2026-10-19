"use client";
// @purpose Re-render the server component around it every `everyMs` (router.refresh keeps client
// state, e.g. an in-progress Heat now read-back). Used on Home so the backup line, pump cards and
// tank card re-read the database instead of freezing at first render (#184, Codex pass 2).
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
