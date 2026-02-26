import type { Route } from "./+types/auth.logout";
import { redirect } from "react-router";

export async function loader({}: Route.LoaderArgs) {
  return redirect("/", {
    headers: {
      "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    },
  });
}

export default function AuthLogout() {
  return null;
}
