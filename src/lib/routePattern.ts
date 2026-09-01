import { Request } from "express";

export default function fixRoutePattern(req: Request): string {
  // Handle unmatched requests / 404s
  if (!req.route || req.route.path === undefined) {
    // A check to make sure whether its served by a middleware like use static
    if (req.baseUrl) {
      // Theres a chance that someone might put a placeholder for static path and might explode the data
      // This isnt addressed right now since this is an mvp
      // I might change this later when i am done with other parts of my code
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
