"use client";
// @purpose Dependency-free, in-app replacement for window.confirm/window.prompt on the
// high-stakes control page. useModals() returns confirm()/prompt() that resolve a Promise
// when the user answers, plus a <Modals/> element the caller renders once. Uses A's shared
// .scrim/.modal* classes (globals.css). Enter submits, Esc/backdrop cancels, primary action
// or the input autofocuses. No portals — the dialog renders in-tree.
import { useCallback, useEffect, useRef, useState } from "react";

type ConfirmOpts = { title: string; body?: string; danger?: boolean };
type PromptOpts = { title: string; body?: string; inputType?: string };

type Pending =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

export function useModals() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        setValue("");
        setPending({ kind: "confirm", opts, resolve });
      }),
    [],
  );

  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue("");
        setPending({ kind: "prompt", opts, resolve });
      }),
    [],
  );

  const close = useCallback(
    (result: boolean | string | null) => {
      setPending((cur) => {
        if (cur) {
          if (cur.kind === "confirm") cur.resolve(result === true);
          else cur.resolve(typeof result === "string" ? result : null);
        }
        return null;
      });
    },
    [],
  );

  // Cancel = false for confirm, null for prompt (Promise typing handled in close()).
  const cancel = useCallback(() => close(pending?.kind === "confirm" ? false : null), [close, pending]);
  const accept = useCallback(
    () => close(pending?.kind === "prompt" ? value : true),
    [close, pending, value],
  );

  // Autofocus the input (prompt) or the primary action (confirm) when a dialog opens.
  useEffect(() => {
    if (!pending) return;
    const t = requestAnimationFrame(() => {
      if (pending.kind === "prompt") inputRef.current?.focus();
      else primaryRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [pending]);

  // Esc cancels from anywhere while a dialog is open.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, cancel]);

  const Modals = pending ? (
    <div
      className="scrim"
      onMouseDown={(e) => {
        // Backdrop click (only when the press starts on the scrim itself) cancels.
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={pending.opts.title}
      >
        <div className="modal-title">{pending.opts.title}</div>
        {pending.opts.body ? <div className="modal-body">{pending.opts.body}</div> : null}
        {pending.kind === "prompt" ? (
          <div className="modal-body">
            <input
              ref={inputRef}
              type={pending.opts.inputType ?? "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  accept();
                }
              }}
            />
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button
            ref={pending.kind === "confirm" ? primaryRef : undefined}
            type="button"
            className={pending.kind === "confirm" && pending.opts.danger ? "danger" : undefined}
            onClick={accept}
            autoFocus={pending.kind === "confirm"}
          >
            {pending.kind === "prompt" ? "OK" : pending.opts.danger ? "Confirm" : "OK"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, prompt, Modals };
}
