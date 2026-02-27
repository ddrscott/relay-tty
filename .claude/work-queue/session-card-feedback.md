# Add immediate tap feedback on session cards

## Problem
On the home screen, tapping a session card navigates to the session view, but on slow networks the transition can take a moment. There's no visual feedback that the tap registered, so the user isn't sure they touched it and may tap again.

## Acceptance Criteria
- Tapping a session card shows immediate visual feedback (pressed/active state)
- If navigation takes more than ~200ms, show a loading indicator on the tapped card
- Feedback should feel native/responsive — no janky delay before the pressed state

## Relevant Files
- `app/components/session-card.tsx` — the card component
- `app/routes/home.tsx` — the session list

## Constraints
- Keep it simple — CSS active state + a small loading spinner is sufficient
- Don't block the tap; feedback is purely visual
- Must work well on mobile (touch) and desktop (click)
