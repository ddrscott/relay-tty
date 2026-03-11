import { forwardRef, type ComponentPropsWithoutRef } from "react";

/**
 * A plain text input with mobile autocomplete, autocorrect, spellcheck,
 * and password-manager autofill uniformly suppressed.
 *
 * Use this instead of raw <input> for all text fields in the app.
 * Passes through all standard input props; suppression attrs cannot be overridden.
 *
 * Android's autofill service (Gboard suggestion strip with password/credit card/
 * address icons) ignores autocomplete="off" and "one-time-code" for type="text".
 * Using type="search" is the most reliable suppression — Gboard and Chrome skip
 * autofill entirely for search inputs. The default search clear-X is removed via CSS.
 */
export const PlainInput = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<"input">
>(function PlainInput(props, ref) {
  return (
    <input
      type="search"
      {...props}
      ref={ref}
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
