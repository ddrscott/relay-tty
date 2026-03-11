import { forwardRef, type ComponentPropsWithoutRef } from "react";

/**
 * A plain text input with mobile autocomplete, autocorrect, spellcheck,
 * and password-manager autofill uniformly suppressed.
 *
 * Use this instead of raw <input> for all text fields in the app.
 * Passes through all standard input props; suppression attrs cannot be overridden.
 */
export const PlainInput = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<"input">
>(function PlainInput(props, ref) {
  return (
    <input
      {...props}
      ref={ref}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-form-type="other"
      data-lpignore="true"
      data-1p-ignore="true"
      data-gramm="false"
    />
  );
});
