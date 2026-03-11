import { forwardRef, type ComponentPropsWithoutRef } from "react";

/**
 * A plain text input that suppresses Android's Gboard autofill toolbar.
 *
 * Android's autofill service targets <input> elements but leaves <textarea>
 * alone. We render a single-line <textarea> styled identically to an input —
 * rows=1, no resize, horizontal scroll, no wrapping. This is the same
 * technique used by the scratchpad, which is the only input that reliably
 * suppresses the Gboard toolbar (passwords, credit cards, addresses).
 *
 * Callers use this exactly like <input> — className, value, onChange,
 * onKeyDown, placeholder, ref all work the same way. The `type` prop is
 * accepted but ignored (textarea doesn't have types).
 */

type PlainInputProps = Omit<ComponentPropsWithoutRef<"textarea">, "rows" | "wrap" | "children"> & {
  /** Accepted for API compat with <input> but ignored */
  type?: string;
  /** Accepted for API compat with <input> but ignored */
  inputMode?: string;
};

export const PlainInput = forwardRef<
  HTMLTextAreaElement,
  PlainInputProps
>(function PlainInput({ type: _type, style, className, ...props }, ref) {
  return (
    <textarea
      rows={1}
      wrap="off"
      {...props}
      ref={ref}
      className={`plain-input-no-scrollbar${className ? ` ${className}` : ""}`}
      style={{
        ...style,
        resize: "none",
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        touchAction: "pan-x",  // iOS: prevent vertical drag/snapback
      }}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // Suppress password managers
      data-form-type="other"
      data-lpignore="true"
      data-1p-ignore="true"
      data-gramm="false"
    />
  );
});
