// One error type for the whole server. Handlers throw it; the router turns it into
// `{ error, code }` JSON with the right status. A `code` (machine-readable) rides
// alongside the human message so the frontend can react without matching strings.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code || CODE_BY_STATUS[status] || "error";
  }
}

const CODE_BY_STATUS = {
  400: "bad_request",
  403: "forbidden",
  404: "not_found",
  408: "timeout",
  413: "too_large",
  422: "unresolvable",
  424: "upstream_unavailable",
  429: "rate_limited",
  502: "upstream_failed",
  504: "upstream_timeout",
  508: "too_many_redirects",
};

export const httpErr = (status, message, code) => new HttpError(status, message, code);

export const badRequest = (m) => httpErr(400, m, "bad_request");
export const notFound = (m = "not found") => httpErr(404, m, "not_found");
export const forbidden = (m) => httpErr(403, m, "forbidden");

// 424 Failed Dependency is used deliberately at the public edge for "the upstream site
// is blocking/unavailable right now": Cloudflare rewrites origin 502/503 bodies, but it
// passes 424 through, so the user still sees our explanation instead of a CF error page.
export const upstreamUnavailable = (m) => httpErr(424, m, "upstream_unavailable");

export default HttpError;
