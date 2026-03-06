import type { Route } from "./+types/auth.callback";
import { redirect } from "react-router";

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new Response("Missing token", { status: 400 });
  }

  // Validate the incoming token before granting access
  if (!context.verifyAccessToken(token)) {
    throw new Response("Invalid or expired token", { status: 401 });
  }

  // Generate a fresh long-lived token for the cookie.
  // This allows the incoming token to be short-lived (e.g. QR code with 24h expiry)
  // while the session cookie remains valid for 30 days.
  const sessionToken = context.generateToken?.() || token;

  // Detect HTTPS: check the request protocol and X-Forwarded-Proto (set by tunnels/proxies
  // that terminate TLS at the edge — the local request arrives as http).
  const isSecure = url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https";
  const securePart = isSecure ? " Secure;" : "";

  // SameSite=Lax allows the cookie to be set on top-level navigations from external
  // origins (QR code scans, links from other apps). Strict would block the cookie
  // because the QR scan is a cross-site navigation.
  return redirect("/", {
    headers: {
      "Set-Cookie": `session=${sessionToken}; HttpOnly; SameSite=Lax;${securePart} Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    },
  });
}

export default function AuthCallback() {
  return null;
}
