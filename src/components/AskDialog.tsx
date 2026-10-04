import { useEffect, useRef } from "react";
import { answerAsk, useUi } from "../state/ui";

/* The in-page confirm and prompt (ask() in state/ui.ts). */
export function AskDialog() {
  const req = useUi((s) => s.ask);
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const check = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (req && !d.open) {
      d.returnValue = "";
      d.showModal();
      if (req.value !== null && input.current) {
        input.current.focus();
        input.current.select();
      } else ok.current?.focus();
    }
    if (!req && d.open) d.close();
  }, [req]);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    const onClose = () => {
      const a = useUi.getState().ask;
      if (!a) return;
      if (d.returnValue !== "ok") return answerAsk(null);
      answerAsk(a.value === null ? true : input.current?.value.trim() || null, !!check.current?.checked);
    };
    d.addEventListener("close", onClose);
    return () => d.removeEventListener("close", onClose);
  }, []);

  return (
    <dialog id="dlg" ref={dlg} aria-labelledby="dlg-title">
      <form method="dialog" className="dlg">
        <h2 id="dlg-title">{req?.title}</h2>
        <p id="dlg-body" hidden={!req?.body}>
          {req?.body}
        </p>
        <input
          id="dlg-input"
          key={req?.id}
          ref={input}
          defaultValue={req?.value ?? ""}
          aria-labelledby="dlg-title"
          autoComplete="off"
          spellCheck={false}
          hidden={req?.value === null || req?.value === undefined}
        />
        {req?.check && (
          <label className="check" id="dlg-check-row" key={`c${req.id}`}>
            <input type="checkbox" id="dlg-check" ref={check} defaultChecked={!!req.checked} />
            {req.check}
          </label>
        )}
        <div className="dlg-actions">
          <button value="ok" className={`btn ${req?.danger ? "danger" : "primary"}`} id="dlg-ok" ref={ok}>
            {req?.ok ?? "OK"}
          </button>
          <button value="cancel" className="btn">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
