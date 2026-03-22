import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Project } from "../shared/types.js";

const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
const SESSIONS_DIR = path.join(RELAY_DIR, "sessions");
const PROJECT_ROOTS_FILE = path.join(RELAY_DIR, "project-roots.txt");
const HOME = os.homedir();

/** Common project parent directories relative to HOME */
const DEFAULT_ROOT_NAMES = [
  "code", "Code",
  "projects", "Projects",
  "src", "Src",
  "Developer",
  "repos", "Repos",
  "workspace", "Workspace",
  "github", "GitHub",
];

/** Cache with 30s TTL */
let cache: { projects: Project[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

export function invalidateProjectCache(): void {
  cache = null;
}

export function discoverProjects(): Project[] {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.projects;

  const seen = new Set<string>();
  const projects: Project[] = [];

  function addProject(absPath: string, source: Project["source"], lastUsed?: number): void {
    let resolved: string;
    try {
      resolved = fs.realpathSync(absPath);
    } catch {
      resolved = absPath;
    }
    if (seen.has(resolved)) return;
    seen.add(resolved);

    projects.push({
      path: resolved,
      name: path.basename(resolved),
      label: resolved.startsWith(HOME) ? "~" + resolved.slice(HOME.length) : resolved,
      source,
      lastUsed,
    });
  }

  // 1. Recent session directories (exclude HOME)
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    const cwdMap = new Map<string, number>(); // cwd -> most recent timestamp
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
        const session = JSON.parse(raw);
        if (session.cwd && session.cwd !== HOME && session.cwd !== "/") {
          const existing = cwdMap.get(session.cwd) || 0;
          const ts = session.lastActivity || session.createdAt || 0;
          if (ts > existing) cwdMap.set(session.cwd, ts);
        }
      } catch {}
    }
    // Sort by most recent first
    const sorted = [...cwdMap.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cwd, lastUsed] of sorted) {
      // Verify directory still exists
      try {
        if (fs.statSync(cwd).isDirectory()) {
          addProject(cwd, "recent", lastUsed);
        }
      } catch {}
    }
  } catch {}

  // 2. Git repo scan — project-roots.txt is the single source of truth
  const roots = readProjectRoots();
  for (const root of roots) {
    scanForGitRepos(root, (repoPath) => {
      addProject(repoPath, "discovered");
    });
  }

  cache = { projects, ts: Date.now() };
  return projects;
}

function scanForGitRepos(parentDir: string, onFound: (absPath: string) => void): void {
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      const childPath = path.join(parentDir, entry.name);
      try {
        if (fs.existsSync(path.join(childPath, ".git"))) {
          onFound(childPath);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Read project roots from ~/.relay-tty/project-roots.txt.
 * If the file doesn't exist, seed it with defaults so users can just edit.
 */
export function readProjectRoots(): string[] {
  if (!fs.existsSync(PROJECT_ROOTS_FILE)) {
    seedProjectRootsFile();
  }
  try {
    const raw = fs.readFileSync(PROJECT_ROOTS_FILE, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .filter((l) => {
        try { return fs.statSync(l).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

/**
 * Read the raw text content of project-roots.txt for the settings UI.
 * Returns the full file contents including comments.
 */
export function readProjectRootsRaw(): string {
  if (!fs.existsSync(PROJECT_ROOTS_FILE)) {
    seedProjectRootsFile();
  }
  try {
    return fs.readFileSync(PROJECT_ROOTS_FILE, "utf-8");
  } catch {
    return "";
  }
}

export function writeProjectRoots(content: string): void {
  fs.mkdirSync(RELAY_DIR, { recursive: true });
  fs.writeFileSync(PROJECT_ROOTS_FILE, content);
  invalidateProjectCache();
}

/**
 * Seed project-roots.txt with the default scan directories.
 * Dirs that exist on disk are uncommented; others are commented out.
 */
function seedProjectRootsFile(): void {
  const lines = [
    "# Project root directories — one per line.",
    "# The project picker scans each directory for git repos (one level deep).",
    "# Uncomment or add paths to customize.",
    "",
  ];
  for (const name of DEFAULT_ROOT_NAMES) {
    const dir = path.join(HOME, name);
    let exists = false;
    try { exists = fs.statSync(dir).isDirectory(); } catch {}
    lines.push(exists ? dir : `# ${dir}`);
  }
  lines.push(""); // trailing newline
  fs.mkdirSync(RELAY_DIR, { recursive: true });
  fs.writeFileSync(PROJECT_ROOTS_FILE, lines.join("\n"));
}
