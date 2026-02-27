import type { Route } from "./+types/auth.callback";
import { redirect } from "react-router";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new Response("Missing token", { status: 400 });
  }

  // Set Secure flag when accessed over HTTPS (e.g. behind Cloudflare Tunnel)
  const isSecure = url.protocol === "https:";
  const securePart = isSecure ? " Secure;" : "";

  return redirect("/", {
    headers: {
      "Set-Cookie": `session=${token}; HttpOnly; SameSite=Lax;${securePart} Path=/; Max-Age=${30 * 24 * 60 * 60}`,
    },
  });
}

export default function AuthCallback() {
  return null;
}
