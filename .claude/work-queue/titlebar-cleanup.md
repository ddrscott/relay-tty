# Slim Down Session Titlebars

## Problem
Session titlebars are cluttered with data size stats, font sizing controls, and session cycling arrows, leaving insufficient room for the session title.

## Changes
1. **Remove data size stats from titlebar** — move into an info submenu
2. **Keep activity dot** in titlebar so users can see session busyness at a glance
3. **Move font sizing controls to info menu** — mobile users pinch-and-zoom anyway
4. **Remove session cycling arrows** — sessions are navigated via carousel/swipe
5. **Result**: more horizontal space for the session title

## Acceptance Criteria
- Titlebar shows: activity dot + session title (with more room than before)
- Data size stats accessible via info/menu dropdown
- Font size controls accessible via info/menu dropdown
- No session prev/next arrows in titlebar
- Mobile and desktop both look correct
