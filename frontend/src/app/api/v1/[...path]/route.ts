// Reverse proxy: the browser only talks to Next.js, which forwards /api/v1/*
// to the backend over the internal network. The backend is never published.
//
// Node's http client is used instead of fetch() on purpose: it pipes request and
// response bodies with real backpressure, so a 1 GB upload or download passes
// through with a constant, small memory footprint (fetch() buffered the upload).

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_HEADERS = [
  "content-type",
  "content-length",
  "accept",
  "if-none-match",
  "range",
  "cookie",
  // So the backend knows the original scheme (Secure cookies) and client.
  "x-forwarded-proto",
  "x-forwarded-for",
];
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "etag",
  "cache-control",
  "accept-ranges",
  "content-range",
  "x-content-type-options",
];

function unreachable(): Response {
  return Response.json({ detail: "Backend is unreachable" }, { status: 502 });
}

async function proxy(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const backend = process.env.BACKEND_URL ?? "http://backend:8000";
  const incoming = new URL(request.url);
  const target = new URL(`${backend}/api/v1/${path.map(encodeURIComponent).join("/")}${incoming.search}`);

  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  // A body of unknown length is sent chunked; the backend (uvicorn) accepts that.
  if (hasBody && !headers["content-length"]) delete headers["content-length"];

  return new Promise<Response>((resolve) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, { method: request.method, headers }, (res) => {
      const out = new Headers();
      for (const name of RESPONSE_HEADERS) {
        const value = (res.headers as IncomingHttpHeaders)[name];
        if (typeof value === "string") out.set(name, value);
      }
      // Session cookies set (or cleared) by the backend's login endpoints.
      for (const cookie of res.headers["set-cookie"] ?? []) out.append("set-cookie", cookie);
      const status = res.statusCode ?? 502;
      if (status === 204 || status === 304 || request.method === "HEAD") {
        res.resume();
        resolve(new Response(null, { status, headers: out }));
        return;
      }
      // Stop reading from the backend if the browser goes away.
      request.signal.addEventListener("abort", () => res.destroy(), { once: true });
      resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, headers: out }));
    });
    upstream.on("error", () => resolve(unreachable()));
    request.signal.addEventListener("abort", () => upstream.destroy(), { once: true });

    if (hasBody) {
      const body = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream);
      body.on("error", () => upstream.destroy());
      body.pipe(upstream);
    } else {
      upstream.end();
    }
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD };
