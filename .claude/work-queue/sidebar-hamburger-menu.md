# Replace sidebar collapse button with hamburger menu

## Problem
The desktop sidebar has a `PanelLeftClose` icon in the sidebar header and a thin `PanelLeftOpen` edge button when collapsed. This is different from mobile which uses DaisyUI's drawer toggle (`label htmlFor="sidebar-drawer"`). The hamburger menu pattern is more recognizable and consistent across breakpoints.

## Acceptance Criteria
- Replace the `PanelLeftOpen` edge button (visible when sidebar collapsed on desktop) with a hamburger menu icon button in the main content area (top-left corner or toolbar)
- Replace the `PanelLeftClose` button in the sidebar header with a matching close/hamburger toggle
- Hamburger button should be visible on desktop when sidebar is collapsed (similar to how mobile uses `label htmlFor="sidebar-drawer"`)
- Persist collapsed preference in localStorage (already working)
- Mobile behavior unchanged — still uses DaisyUI drawer toggle as-is

## Relevant Files
- `app/components/sidebar-drawer.tsx` — sidebar component with collapse controls (lines 217-228 for edge button, lines 244-256 for header close button)

## Constraints
- Keep mobile drawer behavior intact (DaisyUI checkbox toggle)
- Use lucide-react icons (e.g., `Menu`, `X`, or `PanelLeft` variants)
- Follow existing button patterns: `onMouseDown={e.preventDefault()}`, `tabIndex={-1}`
