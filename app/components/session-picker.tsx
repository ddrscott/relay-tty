import type { SessionGroup } from "../lib/session-groups";
import { CopyableId } from "./copyable-id";

interface SessionPickerProps {
  groups: SessionGroup[];
  activeSessionId: string;
  onSelect: (id: string) => void;
}

export function SessionPicker({ groups, activeSessionId, onSelect }: SessionPickerProps) {
  return (
    <div className="absolute top-full left-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl max-h-72 overflow-y-auto min-w-64">
      {groups.map((group, gi) => (
        <div key={group.cwd}>
          {gi > 0 && (
            <div className="border-t border-[#2d2d44] mx-2 my-1" />
          )}
          {groups.length > 1 && (
            <div className="px-3 pt-2 pb-1">
              <code className="text-xs text-[#64748b] font-mono">
                {group.label}
              </code>
            </div>
          )}
          {group.sessions.map((s) => (
            <button
              key={s.id}
              className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[#0f0f1a] transition-colors ${
                s.id === activeSessionId ? "bg-[#0f0f1a]" : ""
              } ${s.status === "exited" ? "opacity-50" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                s.status === "running" ? "bg-[#22c55e]" : "bg-[#64748b]/30"
              }`} />
              <code className="text-sm font-mono truncate flex-1 text-[#e2e8f0]">
                {s.title || `${s.command} ${s.args.join(" ")}`}
              </code>
              <CopyableId value={s.id} className="text-xs text-[#64748b] font-mono shrink-0" />
              {s.status === "exited" && (
                <span
                  className={`text-xs shrink-0 ${
                    s.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"
                  }`}
                >
                  {s.exitCode}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
