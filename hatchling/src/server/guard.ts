// The largest request body the server reads; a stored page value may not exceed it either.
export const MAX_BODY_BYTES = 64 * 1024;

export type GuardRequest = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  port: number;
};

export type GuardRefusal = { status: number; error: string };

// Refuses what a web page on another site could send: a rebound Host, a cross-site Origin, a non-JSON body.
export function checkRequest(req: GuardRequest): GuardRefusal | null {
  const host = req.headers.host;
  const allowed = [`localhost:${req.port}`, `127.0.0.1:${req.port}`];
  if (typeof host !== "string" || !allowed.includes(host.toLowerCase())) {
    return { status: 403, error: "forbidden host" };
  }
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const contentType = req.headers["content-type"];
  const mediaType = typeof contentType === "string" ? (contentType.split(";")[0] as string).trim().toLowerCase() : "";
  if (mediaType !== "application/json") return { status: 415, error: "content type must be application/json" };
  const origin = req.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || origin.toLowerCase() !== `http://${host.toLowerCase()}`)) {
    return { status: 403, error: "forbidden origin" };
  }
  if (method !== "POST") return { status: 405, error: "method not allowed" };
  return null;
}
