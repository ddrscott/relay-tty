import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { Terminal, Sparkles, Loader2 } from "lucide-react";
import { ProjectPicker } from "./project-picker";

interface CommandOption {
  name: string;
  label: string;
}

interface AvailableCommands {
  tools: CommandOption[];
  shells: CommandOption[];
}

export function QuickLaunch({ compact }: { compact?: boolean }) {
  const navigate = useNavigate();
  const [commands, setCommands] = useState<AvailableCommands | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<{ cmd: CommandOption; isAiTool: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/available-commands")
      .then((r) => r.json())
      .then((data: AvailableCommands) => {
        if (!cancelled) setCommands(data);
      })
      .catch(() => {
        if (!cancelled) setCommands({ tools: [], shells: [{ name: "$SHELL", label: "shell" }] });
      });
    return () => { cancelled = true; };
  }, []);

  const launchWithCwd = useCallback(
    async (command: string, cwd?: string) => {
      if (creating) return;
      setCreating(command);
      try {
        const body: Record<string, unknown> = { command };
        if (cwd) body.cwd = cwd;
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        const { session } = await res.json();
        navigate(`/sessions/${session.id}`);
      } finally {
        setCreating(null);
      }
    },
    [creating, navigate],
  );

  const launch = useCallback(
    (command: string, label: string, isAiTool: boolean) => {
      if (creating) return;
      setPendingCommand({ cmd: { name: command, label }, isAiTool });
    },
    [creating],
  );

  if (!commands) {
    return (
      <div className={compact ? "py-4" : "py-8"}>
        <div className="flex justify-center">
          <Loader2 className="w-5 h-5 text-[#64748b] animate-spin" />
        </div>
      </div>
    );
  }

  const { tools, shells } = commands;

  const pickerContent = pendingCommand && (
    <ProjectPicker
      command={pendingCommand.cmd.name}
      commandLabel={pendingCommand.cmd.label}
      isAiTool={pendingCommand.isAiTool}
      onSelect={(cwd) => {
        const cmd = pendingCommand.cmd.name;
        setPendingCommand(null);
        launchWithCwd(cmd, cwd || undefined);
      }}
      onCancel={() => setPendingCommand(null)}
    />
  );

  // In compact mode (sidebar), ProjectPicker renders as absolute overlay within the sidebar's relative container.
  // In full mode (main content), wrap in a fixed overlay so it covers the viewport.
  const picker = compact ? pickerContent : pendingCommand && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative w-full max-w-lg h-full sm:h-[80vh] sm:rounded-2xl overflow-hidden border-0 sm:border sm:border-[#2d2d44]">
        {pickerContent}
      </div>
    </div>
  );

  if (compact) {
    return (
      <div className="px-3 py-4">
        <p className="text-xs text-[#64748b] mb-3 text-center">Launch a session</p>
        <div className="flex flex-col gap-1.5">
          {tools.map((t) => (
            <LaunchButton key={t.name} cmd={t} icon="sparkles" creating={creating} onLaunch={() => launch(t.name, t.label, true)} />
          ))}
          {tools.length > 0 && shells.length > 0 && <div className="border-t border-[#1e1e2e] my-1" />}
          {shells.map((s) => (
            <LaunchButton key={s.name} cmd={s} icon="terminal" creating={creating} onLaunch={() => launch(s.name, s.label, false)} />
          ))}
        </div>
        <p className="text-xs text-[#64748b]/60 mt-3 text-center font-mono">
          relay &lt;command&gt;
        </p>
        {picker}
      </div>
    );
  }

  return (
    <div className="text-center max-w-md mx-auto">
      <h2 className="text-lg font-mono text-[#e2e8f0] mb-1">Launch a session</h2>
      <p className="text-sm text-[#64748b] mb-6">
        Start a terminal session to access from any device
      </p>

      {tools.length > 0 && (
        <div className="mb-5">
          <p className="text-xs text-[#64748b] uppercase tracking-wider mb-2.5">AI Assistants</p>
          <div className="flex flex-wrap justify-center gap-2">
            {tools.map((t) => (
              <LaunchButton key={t.name} cmd={t} icon="sparkles" creating={creating} onLaunch={() => launch(t.name, t.label, true)} />
            ))}
          </div>
        </div>
      )}

      <div className="mb-6">
        <p className="text-xs text-[#64748b] uppercase tracking-wider mb-2.5">Shells</p>
        <div className="flex flex-wrap justify-center gap-2">
          {shells.map((s) => (
            <LaunchButton key={s.name} cmd={s} icon="terminal" creating={creating} onLaunch={() => launch(s.name, s.label, false)} />
          ))}
        </div>
      </div>

      <p className="text-xs text-[#64748b]/60 font-mono">
        or from your terminal: relay &lt;command&gt;
      </p>
      {picker}
    </div>
  );
}

function LaunchButton({
  cmd,
  icon,
  creating,
  onLaunch,
}: {
  cmd: CommandOption;
  icon: "sparkles" | "terminal";
  creating: string | null;
  onLaunch: () => void;
}) {
  const isCreating = creating === cmd.name;
  const disabled = creating !== null;
  const Icon = icon === "sparkles" ? Sparkles : Terminal;

  return (
    <button
      className="inline-flex items-center gap-2 bg-[#0f0f1a] border border-[#2d2d44] hover:bg-[#1a1a2e] hover:border-[#3d3d5c] disabled:opacity-40 text-[#e2e8f0] font-mono text-sm rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
      disabled={disabled}
      onClick={onLaunch}
      onMouseDown={(e) => e.preventDefault()}
      tabIndex={-1}
    >
      {isCreating ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Icon className="w-4 h-4 text-[#64748b]" />
      )}
      {cmd.label}
    </button>
  );
}
