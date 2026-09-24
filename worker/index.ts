/**
 * Worker for the blog. Static assets are served directly by Cloudflare;
 * only `/api/*` requests reach this code (see `run_worker_first` in
 * wrangler.jsonc).
 *
 * Endpoints (slug is the post path under /posts/, e.g. `esp32-box3b-to-sonos`):
 *   POST   /api/view/:slug  record a view, returns { views, likes, liked }
 *   POST   /api/like/:slug  like the post,  returns { views, likes, liked }
 *   DELETE /api/like/:slug  undo the like,  returns { views, likes, liked }
 *
 * "views" counts unique visitors per post per day. Visitors are identified by
 * a salted SHA-256 of IP + User-Agent; raw IPs are never stored.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS post_views (
     slug TEXT NOT NULL,
     visitor TEXT NOT NULL,
     day TEXT NOT NULL,
     PRIMARY KEY (slug, visitor, day)
   )`,
  `CREATE TABLE IF NOT EXISTS post_likes (
     slug TEXT NOT NULL,
     visitor TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (slug, visitor)
   )`,
];

const BOT_UA = /bot|crawl|spider|slurp|headless|preview|fetch|curl|wget/i;

let schemaReady: Promise<unknown> | null = null;

function ensureSchema(db: D1Database) {
  schemaReady ??= db
    .batch(SCHEMA.map(sql => db.prepare(sql)))
    .catch(err => {
      schemaReady = null;
      throw err;
    });
  return schemaReady;
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function visitorId(request: Request, salt: string) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const ua = request.headers.get("User-Agent") ?? "";
  const bytes = new TextEncoder().encode(`${salt}|${ip}|${ua}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash).slice(0, 16)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseSlug(raw: string): string | null {
  let slug: string;
  try {
    slug = decodeURIComponent(raw).replace(/^\/+|\/+$/g, "");
  } catch {
    return null;
  }
  if (!slug || slug.length > 200) return null;
  if (slug.split("/").some(s => s === "" || s === "." || s === "..")) {
    return null;
  }
  return slug;
}

/** Only accept slugs that correspond to a real, built post page. */
async function postExists(env: Env, request: Request, slug: string) {
  const path = slug.split("/").map(encodeURIComponent).join("/");
  const res = await env.ASSETS.fetch(
    new URL(`/posts/${path}/`, request.url)
  );
  return res.ok;
}

async function stats(db: D1Database, slug: string, visitor: string) {
  const [views, likes, liked] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM post_views WHERE slug = ?").bind(slug),
    db.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE slug = ?").bind(slug),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM post_likes WHERE slug = ? AND visitor = ?"
      )
      .bind(slug, visitor),
  ]);
  return {
    views: views.results[0]?.n ?? 0,
    likes: likes.results[0]?.n ?? 0,
    liked: (liked.results[0]?.n ?? 0) > 0,
  };
}

async function handleApi(request: Request, env: Env, url: URL) {
  const match = url.pathname.match(/^\/api\/(view|like)\/(.+)$/);
  if (!match) return json({ error: "not_found" }, 404);

  const [, action, rawSlug] = match;
  const slug = parseSlug(rawSlug);
  if (!slug) return json({ error: "bad_slug" }, 400);

  const allowed = action === "view" ? ["POST"] : ["POST", "DELETE"];
  if (!allowed.includes(request.method)) {
    return json({ error: "method_not_allowed" }, 405);
  }

  if (!(await postExists(env, request, slug))) {
    return json({ error: "not_found" }, 404);
  }

  await ensureSchema(env.DB);
  const visitor = await visitorId(request, env.VISITOR_SALT ?? "yuulee-blog");
  const db = env.DB;

  if (action === "view") {
    const ua = request.headers.get("User-Agent") ?? "";
    if (!BOT_UA.test(ua)) {
      const day = new Date().toISOString().slice(0, 10);
      await db
        .prepare(
          "INSERT OR IGNORE INTO post_views (slug, visitor, day) VALUES (?, ?, ?)"
        )
        .bind(slug, visitor, day)
        .run();
    }
  } else if (request.method === "POST") {
    await db
      .prepare(
        "INSERT OR IGNORE INTO post_likes (slug, visitor, created_at) VALUES (?, ?, ?)"
      )
      .bind(slug, visitor, Date.now())
      .run();
  } else {
    await db
      .prepare("DELETE FROM post_likes WHERE slug = ? AND visitor = ?")
      .bind(slug, visitor)
      .run();
  }

  return json(await stats(db, slug, visitor));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
        return json({ error: "internal_error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
