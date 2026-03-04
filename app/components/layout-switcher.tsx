import { useLocation, useNavigate } from "react-router";

const LAYOUTS = [
  { label: "Home", path: "/" },
  { label: "Grid", path: "/grid" },
  { label: "Lanes", path: "/lanes" },
] as const;

/**
 * DaisyUI radio tab group for switching between Home, Grid, and Lanes views.
 * Desktop-only — hidden on mobile (< lg breakpoint).
 */
export function LayoutSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="hidden lg:flex join">
      {LAYOUTS.map(({ label, path }) => (
        <input
          key={path}
          className="join-item btn btn-sm"
          type="radio"
          name="layout"
          aria-label={label}
          checked={location.pathname === path}
          onChange={() => navigate(path)}
        />
      ))}
    </div>
  );
}
