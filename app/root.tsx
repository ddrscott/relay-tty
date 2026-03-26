import { useEffect } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
  useRevalidator,
} from "react-router";
import { useKeyboardViewport } from "./hooks/use-keyboard-viewport";
import type { Route } from "./+types/root";
import { SidebarDrawer } from "./components/sidebar-drawer";
import { useSessionEvents } from "./hooks/use-session-events";
import "./app.css";

export const links: Route.LinksFunction = () => [
  {
    rel: "icon",
    href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>",
  },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "apple-touch-icon", href: "/icon-192.svg" },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Don't expose session list to unauthenticated share viewers
  const isShare = url.pathname.startsWith("/share/");
  const sessions = isShare ? [] : context.sessionStore.list({ includeExited: true });
  const customCommands: string[] = !isShare && context.readCustomCommands ? context.readCustomCommands() : [];
  return { sessions, version: context.version, hostname: context.hostname, customCommands };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="relay">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
        <meta name="theme-color" content="#0a0a0f" />
        <Meta />
        <Links />
      </head>
      <body className="h-app overflow-hidden bg-base-100">
        {children}
        <ScrollRestoration />
        <Scripts />
        <script
          dangerouslySetInnerHTML={{
            __html: `if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js")`,
          }}
        />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  useKeyboardViewport();
  const { sessions, version, hostname, customCommands } = loaderData as {
    sessions: any[];
    version: string;
    hostname: string;
    customCommands: string[];
  };
  const { revalidate } = useRevalidator();
  const location = useLocation();
  const isShareRoute = location.pathname.startsWith("/share/");
  useSessionEvents(revalidate);

  if (isShareRoute) {
    return <Outlet />;
  }

  return (
    <SidebarDrawer sessions={sessions} version={version} hostname={hostname} customCommands={customCommands}>
      <Outlet />
    </SidebarDrawer>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let isNetworkError = false;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "This page doesn't exist."
        : error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
    isNetworkError = error.message === "Failed to fetch" || error.message === "Load failed";
  }

  // Auto-reload when network returns after a network error
  useEffect(() => {
    if (!isNetworkError) return;
    const reload = () => window.location.reload();
    window.addEventListener("online", reload);
    // Also reload when user switches back to the tab (network may already be back)
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && navigator.onLine) reload();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("online", reload);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isNetworkError]);

  return (
    <main className="container mx-auto p-8">
      <h1 className="text-4xl font-bold">{message}</h1>
      <p className="mt-4 text-base-content/70">
        {isNetworkError ? "Connection lost. Reconnecting when network returns..." : details}
      </p>
      <button
        className={`btn mt-6 ${isNetworkError ? "btn-primary" : "btn-ghost"}`}
        onClick={() => window.location.reload()}
      >
        {isNetworkError ? "Reconnect Now" : "Reload"}
      </button>
    </main>
  );
}
