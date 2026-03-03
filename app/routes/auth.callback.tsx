import type { Route } from "./+types/auth.callback";
import { redirect } from "react-router";

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new Response("Missing token", { status: 400 });
  }

  // Generate a fresh long-lived token for the cookie.
  // This allows the incoming token to be short-lived (e.g. QR code with 24h expiry)
  // while the session cookie remains valid for 30 days.
  const sessionToken = context.generateToken?.() || token;

  // Set Secure flag when accessed over HTTPS (e.g. behind Cloudflare Tunnel)
  const isSecure = url.protocol === "https:";
  const securePart = isSecure ? " Secure;" : "";

  return redirect("/", {
    headers: {
      "Set-Cookie": `session=${sessionToken}; HttpOnly; SameSite=Lax;${securePart} Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    },
  });
}

export default function AuthCallback() {
  return null;
}
