import { useEffect } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/home";
import { SessionCard } from "../components/session-card";
import type { Session } from "../../shared/types";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "relay-tty" },
    { name: "description", content: "Terminal relay service" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sessions } = loaderData as { sessions: Session[] };
  const { revalidate } = useRevalidator();

  useEffect(() => {
    const interval = setInterval(revalidate, 3000);
    return () => clearInterval(interval);
  }, [revalidate]);

  return (
    <main className="container mx-auto p-4 max-w-2xl h-screen overflow-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold font-mono">relay-tty</h1>
        <span className="text-sm text-base-content/50">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-base-content/50 mb-2">No active sessions</p>
          <code className="text-sm text-base-content/30">
            relay bash
          </code>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </main>
  );
}
