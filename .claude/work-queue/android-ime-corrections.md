# Handle Android IME correction/word-replace via beforeinput event listeners

## Problem
When Android's keyboard suggests a correction (e.g. "teh" → "the"), tapping the suggestion should delete the current word and type the corrected one. Currently, the `setAttribute` calls (autocomplete=off, autocorrect=off, etc.) suppress composition so Android can't auto-fill corrections. Android still *shows* correction suggestions in the keyboard bar — which IS the desired behavior — but tapping a correction doesn't work because composition events are suppressed.

The goal: make tapping a suggested correction actually replace the word in the terminal.

## Approach
Add more `beforeinput` event listeners to xterm's hidden textarea (`.xterm-helper-textarea`) in the `setupMobileInput` function. The existing `setAttribute` calls should remain as-is — they prevent the full composition duplication problem while still showing suggestions.

Key `beforeinput` `inputType` values to handle:
- `deleteWordBackward` — hold-delete or correction replacing a word (send Ctrl-W or N backspaces)
- `deleteContentBackward` — single backspace (send `\x7f`)
- `deleteContentForward` — forward delete (send `\x1b[3~`)
- `deleteWordForward` — forward word delete (send `\x1bd` or equivalent)
- `insertReplacementText` — autocorrect replacement (delete old word + type new)
- `insertText` — committed text after correction
- `insertLineBreak` — already handled (Enter → `\r`)

When a correction is tapped, Android fires a sequence like:
1. `deleteWordBackward` (or `deleteByCut`/`deleteByDrag`) to remove the old word
2. `insertText` (or `insertReplacementText`) with the new word

Each of these should be intercepted via `e.preventDefault()` (if cancelable) and translated to appropriate PTY escape sequences.

## Acceptance Criteria
- Tapping an Android keyboard suggestion replaces the current word in the terminal
- Hold-delete on Android deletes words (sends Ctrl-W or equivalent backspaces)
- Regular character-by-character typing still works (no duplication)
- Existing `setAttribute` suppression stays in place
- Desktop/iOS behavior unchanged
- Interactive programs (vim, less) not broken — raw keystrokes still flow through

## Relevant Files
- `app/hooks/use-terminal-core.ts` — `setupMobileInput()` function (line ~434)
- xterm.js `CompositionHelper.ts` — upstream reference for how composition is handled

## Constraints
- Do NOT remove the existing `setAttribute("autocorrect", "off")` etc. calls
- Do NOT modify xterm.js internals or CompositionHelper — work purely via addEventListener on the textarea
- Use `capture: true` where needed to intercept before xterm's own handlers
- Test that basic typing (character by character) still works — this is the critical regression to avoid
- The `insertCompositionText` inputType is NOT cancelable on Android — don't try to preventDefault it

## Research Context
- xterm.js has no upstream fix for Android composition (issues #3600, #2403, #675, #4345 all open)
- CodeMirror 6 solved this for editors by diffing DOM mutations, but terminals can't use that approach
- The `beforeinput` event with `inputType` discrimination is the best available tool
- `deleteWordBackward` and `insertReplacementText` ARE cancelable — these are the key events to intercept
