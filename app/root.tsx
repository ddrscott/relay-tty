import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRevalidator,
} from "react-router";
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

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  const customCommands: string[] = context.readCustomCommands ? context.readCustomCommands() : [];
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
      <body className="h-screen overflow-hidden bg-base-100">
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
  const { sessions, hostname, customCommands } = loaderData as {
    sessions: any[];
    hostname: string;
    customCommands: string[];
  };
  const { revalidate } = useRevalidator();
  useSessionEvents(revalidate);

  return (
    <SidebarDrawer sessions={sessions} hostname={hostname} customCommands={customCommands}>
      <Outlet />
    </SidebarDrawer>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "This page doesn't exist."
        : error.statusText || details;
  } else if (error instanceof Error) {
    details = error.message;
  }

  return (
    <main className="container mx-auto p-8">
      <h1 className="text-4xl font-bold">{message}</h1>
      <p className="mt-4 text-base-content/70">{details}</p>
    </main>
  );
}
