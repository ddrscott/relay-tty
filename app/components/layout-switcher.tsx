import { useLocation, useNavigate } from "react-router";
import { List, LayoutGrid, Columns } from "lucide-react";

const LAYOUTS = [
  { icon: List, title: "Home", path: "/" },
  { icon: LayoutGrid, title: "Grid", path: "/grid" },
  { icon: Columns, title: "Lanes", path: "/lanes" },
] as const;

/**
 * Icon-based layout switcher for toggling between Home, Grid, and Lanes views.
 * Desktop-only — hidden on mobile (< lg breakpoint).
 */
export function LayoutSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-1 border border-[#2d2d44] rounded-lg p-0.5 w-fit">
      {LAYOUTS.map(({ icon: Icon, title, path }) => {
        const active = location.pathname === path;
        return (
          <button
            key={path}
            className={`p-1.5 rounded-md transition-colors ${
              active
                ? "text-[#e2e8f0]"
                : "text-[#64748b] hover:text-[#e2e8f0]"
            }`}
            onClick={() => navigate(path)}
            aria-label={title}
            title={title}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}
    </div>
  );
}
