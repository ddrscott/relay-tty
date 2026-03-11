import { forwardRef, type ComponentPropsWithoutRef } from "react";

/**
 * A plain text input with mobile autocomplete, autocorrect, spellcheck,
 * and password-manager autofill uniformly suppressed.
 *
 * Use this instead of raw <input> for all text fields in the app.
 * Passes through all standard input props; suppression attrs cannot be overridden.
 *
 * Android Chrome ignores autocomplete="off" and still shows the autofill bar
 * (passwords, credit cards, addresses). Using "one-time-code" tells Chrome
 * this field is for a verification code, which suppresses all autofill
 * suggestions including the suggestion strip above the keyboard.
 */
export const PlainInput = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<"input">
>(function PlainInput(props, ref) {
  return (
    <input
      {...props}
      ref={ref}
      autoComplete="one-time-code"
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
