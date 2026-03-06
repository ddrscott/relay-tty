import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("gallery", "routes/gallery.tsx"),
  route("grid", "routes/grid.tsx"),
  route("lanes", "routes/lanes.tsx"),
  route("sessions/:id", "routes/sessions.$id.tsx"),
  route("share/:token", "routes/share.$token.tsx"),
] satisfies RouteConfig;
