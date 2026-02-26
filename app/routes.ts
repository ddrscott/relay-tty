import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sessions/:id", "routes/sessions.$id.tsx"),
  route("api/auth/callback", "routes/auth.callback.tsx"),
  route("api/auth/logout", "routes/auth.logout.tsx"),
] satisfies RouteConfig;
