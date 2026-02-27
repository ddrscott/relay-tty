# Mic opens scratchpad without virtual keyboard

## Problem
Pressing the mic button opens the scratchpad and focuses the textarea, which triggers the mobile virtual keyboard. This wastes screen space — the whole point of dictation is hands-free input, and the user wants to see as much terminal output as possible while speaking.

## Expected Behavior
1. **Mic tap**: scratchpad opens, dictation starts, but textarea is NOT focused — no virtual keyboard
2. **Dictation text** still appears in the scratchpad textarea (via speech recognition API inserting text)
3. **User taps textarea**: NOW focus it, show keyboard for manual editing
4. **Send button**: works regardless of focus state

## Acceptance Criteria
- Mic button opens scratchpad without triggering virtual keyboard on iOS/Android
- Dictated text is visible in the scratchpad as it arrives
- Tapping the textarea focuses it and shows the keyboard for editing
- More terminal content is visible during dictation vs current behavior

## Technical Approach
- On mic press: open scratchpad, set textarea to `readOnly` (prevents keyboard) — speech recognition writes to state, React renders the text
- On textarea tap: remove `readOnly`, call `.focus()` — keyboard appears
- Alternative: use `inputMode="none"` on the textarea until user taps it, then switch to `inputMode="text"`
- Must test on both iOS Safari and Android Chrome — keyboard suppression behaves differently

## Relevant Files
- `app/routes/sessions.$id.tsx` — scratchpad component, mic button handler
- CLAUDE.md mobile considerations — keyboard suppression patterns

## Constraints
- Don't break existing keyboard input flow when scratchpad is opened via non-mic interaction
- Speech recognition API availability varies — graceful fallback needed
