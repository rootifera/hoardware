// Reverse proxy: the browser only talks to Next.js, which forwards /api/v1/*
// to the backend over the internal network. The backend is never published.

export const dynamic = "force-dynamic";

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
];

async function proxy(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const backend = process.env.BACKEND_URL ?? "http://backend:8000";
  const incoming = new URL(request.url);
  const target = `${backend}/api/v1/${path.map(encodeURIComponent).join("/")}${incoming.search}`;

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      // Stream uploads straight through instead of buffering them.
      body: hasBody ? request.body : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
    } as RequestInit);
  } catch {
    return Response.json({ detail: "Backend is unreachable" }, { status: 502 });
  }

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // Session cookies set (or cleared) by the backend's login endpoints.
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD };
