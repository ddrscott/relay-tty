import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("activity", "routes/activity.tsx"),
  route("grid", "routes/grid.tsx"),
  route("lanes", "routes/lanes.tsx"),
  route("tiles", "routes/tiles.tsx"),
  route("settings", "routes/settings.tsx"),
  route("sessions/:id", "routes/sessions.$id.tsx"),
  route("share/:token", "routes/share.$token.tsx"),
] satisfies RouteConfig;
