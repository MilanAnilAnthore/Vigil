import { Request } from "express";

export default function fixRoutePattern(req: Request): string {
  // Handle unmatched requests / 404s
  if (!req.route || req.route.path === undefined) {
    // No route but still inside a mount, so some middleware answered on its own
    // (static files, an auth guard). Everything under it becomes one row.
    if (req.baseUrl) {
      return req.baseUrl;
    }
    return "(unmatched)";
  }

  // set a fallback for undefined baseUrl
  const baseUrl = req.baseUrl || "";
  const rawPath = req.route.path;

  // variable to store the normalized string format of rawPath
  let pathString: string;

  if (typeof rawPath === "string") {
    pathString = rawPath;
  } else if (Array.isArray(rawPath)) {
    // the host might have an array with different routes for the same handler and this check is to handle that
    // Pick the first pattern in the array to map entry to a consitent endpoint
    const first = rawPath[0];
    pathString =
      typeof first === "string"
        ? first
        : first instanceof RegExp
          ? first.source
          : String(first ?? "");
  } else if (rawPath instanceof RegExp) {
    // we take source of regular expression to remove the surrounding unwanted slashes
    pathString = rawPath.source;
  } else {
    // if its an unknown type we change it into string or if its undefined or null we return empty string
    pathString = String(rawPath ?? "");
  }

  // KNOWN LIMITATION - there might be a cardinality explosion here
  // Because the baseurl always gets the placeholder values with it, not the
  // placeholder itself. This fires on ANY use() mount whose path contains a
  // param, not just odd multi tenant setups. Plain nested rest does it too -
  // posts.use("/:id/comments", router) stores "/posts/7/comments/:cid" so i
  // get one route per post id, which breaks GROUP BY route once i start doing
  // percentiles. Params in a normal app.get("/posts/:id") are fine, the route
  // keeps its own pattern. Its only mounts that lose it.
  // To fix it i have to grab the pattern while express is still routing.
  // Express 5 never stores the declared path on a mount Layer (see
  // router/lib/layer.js, the path arg only goes into the matcher closure and
  // layer.path is later overwritten with the matched text), so it genuinely
  // cant be rebuilt from baseUrl afterwards.
  // Since this is an mvp i will address it later.

  // Clean up slash joining between baseUrl and pathString
  // Strip trailing slashes from baseUrl (unless baseUrl is empty)
  const cleanBase = baseUrl.replace(/\/+$/, "");

  // Clean up Regex strings that start with ^ so they append cleanly
  if (pathString.startsWith("^")) {
    pathString = pathString.slice(1);
  }

  // Ensure pathString starts with a single leading slash
  const cleanPath = pathString.startsWith("/") ? pathString : `/${pathString}`;

  // Combine base and path
  let fullRoute = `${cleanBase}${cleanPath}`;

  // Handle trailing slash normalization
  if (fullRoute.length > 1 && fullRoute.endsWith("/")) {
    fullRoute = fullRoute.slice(0, -1);
  }

  return fullRoute;
}
