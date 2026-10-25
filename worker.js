// Cloudflare Worker: keeps your Astrometry.net API key secret.
// Secrets/vars (set in Cloudflare, never in code):
//   ASTROMETRY_KEY  (secret)  your nova.astrometry.net API key
//   ALLOWED_ORIGIN  (var)     e.g. https://yourname.github.io  (no trailing slash)

const NOVA = "https://nova.astrometry.net";
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/tiff", "image/webp"];

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });

async function login(env) {
  const r = await fetch(`${NOVA}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "request-json=" + encodeURIComponent(JSON.stringify({ apikey: env.ASTROMETRY_KEY })),
  });
  const j = await r.json();
  if (j.status !== "success") throw new Error("upstream login failed");
  return j.session;
}

const getJson = async (path) => (await fetch(NOVA + path)).json();

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.headers.get("Origin") !== env.ALLOWED_ORIGIN) return json({ error: "Forbidden" }, 403, cors);

    const url = new URL(req.url);
    try {
      // POST /solve  (multipart: file)  ->  { subid }
      if (req.method === "POST" && url.pathname === "/solve") {
        const file = (await req.formData()).get("file");
        if (!file || typeof file === "string") return json({ error: "No file received." }, 400, cors);
        if (file.size > MAX_BYTES) return json({ error: "File is larger than 25 MB." }, 413, cors);
        if (!ALLOWED_TYPES.includes(file.type)) return json({ error: "Use a JPG, PNG, TIFF or WebP image." }, 415, cors);

        const session = await login(env);
        const fd = new FormData();
        fd.append("request-json", JSON.stringify({
          session, publicly_visible: "n", allow_modifications: "n", allow_commercial_use: "n",
        }));
        fd.append("file", file, "upload");
        const up = await (await fetch(`${NOVA}/api/upload`, { method: "POST", body: fd })).json();
        if (up.status !== "success") return json({ error: "Upload to solver failed." }, 502, cors);
        return json({ subid: up.subid }, 200, cors);
      }

      // GET /status/:subid  ->  { state: "queued"|"solving"|"success"|"failure", jobId }
      let m = url.pathname.match(/^\/status\/(\d+)$/);
      if (req.method === "GET" && m) {
        const sub = await getJson(`/api/submissions/${m[1]}`);
        const jobId = (sub.jobs || []).find(Boolean);
        if (!jobId) return json({ state: "queued" }, 200, cors);
        const job = await getJson(`/api/jobs/${jobId}`);
        return json({ state: job.status || "solving", jobId }, 200, cors);
      }

      // GET /result/:jobId  ->  calibration + objects in field
      m = url.pathname.match(/^\/result\/(\d+)$/);
      if (req.method === "GET" && m) {
        const [cal, obj] = await Promise.all([
          getJson(`/api/jobs/${m[1]}/calibration/`),
          getJson(`/api/jobs/${m[1]}/objects_in_field/`),
        ]);
        return json({ calibration: cal, objects: obj.objects_in_field || [], jobId: m[1] }, 200, cors);
      }

      // GET /image/:jobId  ->  annotated image bytes (lets the browser save it)
      m = url.pathname.match(/^\/image\/(\d+)$/);
      if (req.method === "GET" && m) {
        const r = await fetch(`${NOVA}/annotated_full/${m[1]}`);
        if (!r.ok) return json({ error: "Annotated image is not available." }, 502, cors);
        return new Response(r.body, {
          status: 200,
          headers: { "Content-Type": r.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=600", ...cors },
        });
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: "Solver service unavailable. Try again shortly." }, 502, cors);
    }
  },
};
