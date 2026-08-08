// Three things live here:
//   - private messages, written at /submit and readable only at /admin
//   - a public guestbook, on guestbook.nathansimpson.org, held for approval
//   - the admin panel at /admin, which also publishes to the blog repo
//
// Private messages and guestbook entries use different tables so a private
// message can never surface publicly.
//
// Bindings this Worker needs:
//   DB              -> D1 database (holds the messages and guestbook tables)
//   ADMIN_PASSWORD  -> secret, the password for /admin
//   GITHUB_TOKEN    -> secret, a token with contents:write on the blog repo
//   GITHUB_REPO     -> plain var, e.g. "nathansimpson2007/blog"

const MAX_LENGTH = 5000;
const GUESTBOOK_MAX_LENGTH = 1000;
const GUESTBOOK_MAX_NAME = 50;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Anything served out of images/ is a real page on the blog's own domain, so
// only formats browsers render as images are allowed in.
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const isGuestbook =
      url.hostname.startsWith("guestbook.") || url.pathname.startsWith("/guestbook");

    if (isGuestbook) {
      return request.method === "POST"
        ? handleGuestbookSign(request, env)
        : handleGuestbookPage(env);
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(request, env);
    }

    if (url.pathname.startsWith("/admin")) {
      return handleAdmin(request, env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};

/* ---------------------------------------------------------------- guestbook */

async function handleGuestbookPage(env) {
  const { results } = await env.DB.prepare(
    "SELECT name, body, created_at FROM guestbook WHERE approved = 1 ORDER BY id DESC"
  ).all();

  const entries = results.length
    ? results
        .map(
          (entry) =>
            `<p class="date">${escapeHtml(entry.name || "anonymous")} · ${escapeHtml(
              formatDate(entry.created_at)
            )}</p><p>${escapeHtml(entry.body)}</p><hr>`
        )
        .join("\n")
    : "<p>nobody has signed it yet. be the first.</p>";

  const form = `<form method="POST" action="/">
  <p><input type="text" name="name" placeholder="name (optional)" maxlength="${GUESTBOOK_MAX_NAME}"></p>
  <textarea name="message" required maxlength="${GUESTBOOK_MAX_LENGTH}"></textarea>
  <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off">
  <button type="submit">sign</button>
</form>

<hr>`;

  return page("guestbook", `${form}\n${entries}`);
}

async function handleGuestbookSign(request, env) {
  const form = await request.formData();

  if (form.get("website")) {
    return page("guestbook", pendingNotice());
  }

  const body = (form.get("message") || "").trim();
  const name = (form.get("name") || "").trim().slice(0, GUESTBOOK_MAX_NAME);

  if (!body || body.length > GUESTBOOK_MAX_LENGTH) {
    return page("guestbook", "<p>that didn't go through. try again.</p>");
  }

  await env.DB.prepare(
    "INSERT INTO guestbook (name, body, created_at) VALUES (?, ?, ?)"
  )
    .bind(name || null, body, new Date().toISOString())
    .run();

  return page("guestbook", pendingNotice());
}

function pendingNotice() {
  return `<p>signed. it will show up once it has been approved.</p>
<p><a href="/">back to the guestbook</a></p>`;
}

/* --------------------------------------------------------- private messages */

async function handleSubmit(request, env) {
  const form = await request.formData();

  // Honeypot: real people never see this field, so anything in it is a bot.
  // Return the normal thank-you page so the bot doesn't learn it was caught.
  if (form.get("website")) {
    return page("thanks", "<p>message sent. thank you.</p>");
  }

  const body = (form.get("message") || "").trim();
  const image = form.get("image");
  const hasImage = image && typeof image !== "string" && image.size > 0;

  if (!body && !hasImage) {
    return page("empty", "<p>the message was empty. nothing was sent.</p>");
  }

  if (body.length > MAX_LENGTH) {
    return page("too long", `<p>messages are capped at ${MAX_LENGTH} characters.</p>`);
  }

  let imageKey = null;

  if (hasImage) {
    if (image.size > MAX_IMAGE_BYTES) {
      return page(
        "too big",
        `<p>that image is ${(image.size / 1024 / 1024).toFixed(1)}MB — the limit is 5MB.</p>`
      );
    }

    const extension = extensionOf(image.name);

    if (!IMAGE_EXTENSIONS.includes(extension)) {
      return page(
        "wrong type",
        `<p>only ${IMAGE_EXTENSIONS.join(", ")} images can be attached.</p>`
      );
    }

    imageKey = crypto.randomUUID();

    await env.MESSAGE_IMAGES.put(imageKey, await image.arrayBuffer(), {
      metadata: { contentType: contentTypeFor(extension) },
    });
  }

  await env.DB.prepare(
    "INSERT INTO messages (body, created_at, image_key) VALUES (?, ?, ?)"
  )
    .bind(body, new Date().toISOString(), imageKey)
    .run();

  return page("thanks", "<p>message sent. thank you.</p>");
}

/* -------------------------------------------------------------- admin panel */

async function handleAdmin(request, env, url) {
  // Basic auth credentials ride along on cross-site form posts, so anything
  // that changes state has to prove it came from this site.
  if (request.method === "POST" && !sameOrigin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!authorized(request, env.ADMIN_PASSWORD)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="admin"' },
    });
  }

  if (request.method === "POST") {
    return handleAdminAction(request, env);
  }

  // Attachments are private, so they are served from behind this same password
  // rather than from any public URL.
  if (url.pathname.startsWith("/admin/image/")) {
    return serveImage(env, url.pathname.slice("/admin/image/".length));
  }

  const [messages, pending, approved] = await Promise.all([
    env.DB.prepare(
      "SELECT id, body, created_at, image_key FROM messages ORDER BY id DESC"
    ).all(),
    env.DB.prepare(
      "SELECT id, name, body, created_at FROM guestbook WHERE approved = 0 ORDER BY id DESC"
    ).all(),
    env.DB.prepare(
      "SELECT id, name, body, created_at FROM guestbook WHERE approved = 1 ORDER BY id DESC"
    ).all(),
  ]);

  const notice = url.searchParams.get("ok");
  const problem = url.searchParams.get("err");

  const banner = notice
    ? `<p class="notice">${escapeHtml(notice)}</p>`
    : problem
      ? `<p class="problem">${escapeHtml(problem)}</p>`
      : "";

  // One probe drives both the status line and the now-page prefill, so a dead
  // token is obvious immediately rather than after typing out a whole post.
  const github = await probeGitHub(env);

  const status = github.ok
    ? `<p class="date">github: connected${
        github.expires ? ` · token expires ${escapeHtml(github.expires)}` : ""
      }</p>`
    : "";

  const publishing = github.ok
    ? [renderWriteForm(), renderNowForm(github.nowContent), renderPictureForm()].join("\n\n")
    : `<h2>publishing</h2>

<p class="problem">unavailable — ${escapeHtml(github.error)}</p>

<p>the post, now-page and picture forms are hidden until that is fixed, so
nothing gets typed out and lost. everything below still works.</p>`;

  const sections = [
    banner,
    status,
    publishing,
    "<h2>guestbook — waiting for approval</h2>",
    renderQueue(pending.results, true),
    "<h2>guestbook — published</h2>",
    renderQueue(approved.results, false),
    "<h2>private messages</h2>",
    renderMessages(messages.results),
  ];

  return page("admin", sections.join("\n"));
}

// Reads now.html and confirms the token still works. Returns the page's current
// content on success so the editor is never prefilled with an empty box.
async function probeGitHub(env) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/contents/now.html`,
      { headers: ghHeaders(env) }
    );

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `GitHub rejected the token (${response.status}) — it has probably expired.` };
    }

    if (!response.ok) {
      return { ok: false, error: `GitHub returned ${response.status} for now.html.` };
    }

    const file = await response.json();
    const html = fromBase64(file.content);
    const match = html.match(/<!-- now:start -->\n?([\s\S]*?)\n?<!-- now:end -->/);

    if (!match) {
      return { ok: false, error: "now.html no longer has its content markers." };
    }

    return {
      ok: true,
      nowContent: match[1],
      expires: response.headers.get("github-authentication-token-expiration"),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function renderWriteForm() {
  return `<h2>write a post</h2>

<form method="POST" action="/admin">
  <input type="hidden" name="action" value="publish">
  <p><input type="text" name="title" placeholder="title" required maxlength="100"></p>
  <p><input type="text" name="date" value="${escapeHtml(today())}" required></p>
  <textarea name="body" required placeholder="blank line between paragraphs"></textarea>
  <button type="submit">publish</button>
</form>`;
}

function renderNowForm(current) {
  return `<h2>edit the now page</h2>

<form method="POST" action="/admin">
  <input type="hidden" name="action" value="now">
  <textarea name="content" required>${escapeHtml(current)}</textarea>
  <button type="submit">save</button>
</form>

<p class="date">raw html — headings and paragraphs, as on the page itself.</p>`;
}

function renderPictureForm() {
  return `<h2>add a picture</h2>

<form method="POST" action="/admin" enctype="multipart/form-data">
  <input type="hidden" name="action" value="picture">
  <p><input type="file" name="image" accept="image/*" required></p>
  <button type="submit">upload</button>
</form>`;
}

function renderMessages(messages) {
  if (!messages.length) return "<p>no messages yet.</p>";

  return messages
    .map((m) => {
      const text = m.body ? `<p>${escapeHtml(m.body)}</p>` : "";
      const picture = m.image_key
        ? `<p><img src="/admin/image/${encodeURIComponent(m.image_key)}" alt=""></p>`
        : "";

      return `<p class="date">${escapeHtml(
        formatDate(m.created_at)
      )}</p>${text}${picture}<p class="actions">${actionButton(
        m.id,
        "delete-message",
        "delete"
      )}</p><hr>`;
    })
    .join("\n");
}

async function serveImage(env, key) {
  const stored = await env.MESSAGE_IMAGES.getWithMetadata(key, { type: "arrayBuffer" });

  if (!stored || !stored.value) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(stored.value, {
    headers: {
      "Content-Type": (stored.metadata && stored.metadata.contentType) || "image/jpeg",
      // Private content: never let a shared cache hold on to it.
      "Cache-Control": "private, no-store",
    },
  });
}

function renderQueue(entries, showApprove) {
  if (!entries.length) {
    return showApprove ? "<p>nothing waiting.</p>" : "<p>nothing published yet.</p>";
  }

  return entries
    .map((entry) => {
      const approve = showApprove ? actionButton(entry.id, "approve", "approve") : "";
      const remove = actionButton(entry.id, "delete", "delete");

      return `<p class="date">${escapeHtml(entry.name || "anonymous")} · ${escapeHtml(
        formatDate(entry.created_at)
      )}</p><p>${escapeHtml(entry.body)}</p><p class="actions">${approve}${remove}</p><hr>`;
    })
    .join("\n");
}

function actionButton(id, action, label) {
  return `<form method="POST" action="/admin"><input type="hidden" name="id" value="${id}"><input type="hidden" name="action" value="${action}"><button type="submit">${label}</button></form>`;
}

async function handleAdminAction(request, env) {
  const form = await request.formData();
  const action = form.get("action");
  const id = Number(form.get("id"));

  try {
    if (action === "approve" && validId(id)) {
      await env.DB.prepare("UPDATE guestbook SET approved = 1 WHERE id = ?").bind(id).run();
      return backToAdmin(request, "approved.");
    }

    if (action === "delete" && validId(id)) {
      await env.DB.prepare("DELETE FROM guestbook WHERE id = ?").bind(id).run();
      return backToAdmin(request, "entry deleted.");
    }

    if (action === "delete-message" && validId(id)) {
      // Drop the attachment too, so deleting a message really removes it.
      const row = await env.DB.prepare("SELECT image_key FROM messages WHERE id = ?")
        .bind(id)
        .first();

      if (row && row.image_key) {
        await env.MESSAGE_IMAGES.delete(row.image_key);
      }

      await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
      return backToAdmin(request, "message deleted.");
    }

    if (action === "publish") {
      const title = (form.get("title") || "").trim();
      const date = (form.get("date") || "").trim();
      const body = (form.get("body") || "").trim();

      if (!title || !date || !body) {
        return backToAdmin(request, null, "title, date and body are all required.");
      }

      await publishPost(env, title, date, body);
      return backToAdmin(request, `published "${title}". live in a minute or two.`);
    }

    if (action === "now") {
      const content = (form.get("content") || "").trim();

      if (!content) {
        return backToAdmin(request, null, "the now page can't be empty.");
      }

      await updateNowPage(env, content);
      return backToAdmin(request, "now page saved.");
    }

    if (action === "picture") {
      const image = form.get("image");

      if (!image || typeof image === "string" || !image.size) {
        return backToAdmin(request, null, "no image was attached.");
      }

      if (image.size > MAX_IMAGE_BYTES) {
        return backToAdmin(
          request,
          null,
          `that image is ${(image.size / 1024 / 1024).toFixed(1)}MB — the limit is 5MB.`
        );
      }

      const name = await uploadPicture(env, image);
      return backToAdmin(request, `uploaded ${name}.`);
    }
  } catch (error) {
    return backToAdmin(request, null, error.message);
  }

  return backToAdmin(request, null, "that action wasn't understood.");
}

function validId(id) {
  return Number.isInteger(id) && id > 0;
}

// Redirect after acting so a refresh doesn't repeat it.
function backToAdmin(request, notice, problem) {
  const target = new URL("/admin", request.url);

  if (notice) target.searchParams.set("ok", notice);
  if (problem) target.searchParams.set("err", problem);

  return Response.redirect(target.toString(), 303);
}

/* --------------------------------------------------------- publishing to git */

async function publishPost(env, title, date, body) {
  const slug = slugify(title);

  if (!slug) throw new Error("that title doesn't make a usable filename.");

  const path = `posts/${slug}.html`;

  if (await ghGetFile(env, path)) {
    throw new Error(`${path} already exists — pick a different title.`);
  }

  await ghPutFile(env, path, toBase64(renderPost(title, date, body)), `Add ${title} post`);

  const index = await ghGetFile(env, "index.html");
  const html = fromBase64(index.content);

  const entry = `  <li><a href="posts/${slug}.html">${escapeHtml(
    title
  )}</a> <span class="date">${escapeHtml(date)}</span></li>`;

  if (!html.includes("</ul>")) {
    throw new Error("couldn't find the post list in index.html.");
  }

  await ghPutFile(
    env,
    "index.html",
    toBase64(html.replace("</ul>", `${entry}\n</ul>`)),
    `Link ${title} from the index`,
    index.sha
  );
}

function renderPost(title, date, body) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => `<p>\n${escapeHtml(chunk)}\n</p>`)
    .join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — nathan simpson</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>

<nav><a href="../index.html">&larr; back to index</a></nav>

<h1>${escapeHtml(title)}</h1>
<p class="date">${escapeHtml(date)}</p>

${paragraphs}

</body>
</html>
`;
}

async function updateNowPage(env, content) {
  const file = await ghGetFile(env, "now.html");

  if (!file) throw new Error("now.html is missing from the repo.");

  const html = fromBase64(file.content);
  const pattern = /(<!-- now:start -->)[\s\S]*?(<!-- now:end -->)/;

  if (!pattern.test(html)) {
    throw new Error("now.html no longer has its content markers.");
  }

  const updated = html.replace(pattern, `$1\n${content}\n$2`);

  await ghPutFile(env, "now.html", toBase64(updated), "Update the now page", file.sha);
}

async function uploadPicture(env, image) {
  const name = safeFilename(image.name);

  if (!name) throw new Error("that filename can't be used.");

  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";

  if (!IMAGE_EXTENSIONS.includes(extension)) {
    throw new Error(`only ${IMAGE_EXTENSIONS.join(", ")} files can be uploaded.`);
  }

  if (await ghGetFile(env, `images/${name}`)) {
    throw new Error(`images/${name} already exists — rename the file first.`);
  }

  const bytes = await image.arrayBuffer();
  await ghPutFile(env, `images/${name}`, bufferToBase64(bytes), `Add ${name}`);

  const pictures = await ghGetFile(env, "pictures.html");
  const html = fromBase64(pictures.content);

  await ghPutFile(
    env,
    "pictures.html",
    toBase64(html.replace("</body>", `<img src="images/${name}" alt="">\n\n</body>`)),
    `Show ${name} on the pictures page`,
    pictures.sha
  );

  return name;
}

/* ------------------------------------------------------------- github client */

function ghHeaders(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set on the Worker.");
  if (!env.GITHUB_REPO) throw new Error("GITHUB_REPO is not set on the Worker.");

  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "nathansimpson-blog-worker",
    "Content-Type": "application/json",
  };
}

async function ghGetFile(env, path) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    { headers: ghHeaders(env) }
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(`GitHub wouldn't read ${path} (${response.status}).`);
  }

  return response.json();
}

async function ghPutFile(env, path, base64, message, sha) {
  const body = { message, content: base64, branch: "main" };
  if (sha) body.sha = sha;

  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    { method: "PUT", headers: ghHeaders(env), body: JSON.stringify(body) }
  );

  if (!response.ok) {
    throw new Error(`GitHub wouldn't write ${path} (${response.status}).`);
  }

  return response.json();
}

/* ------------------------------------------------------------------- helpers */

// Browsers send Origin on every POST. Sec-Fetch-Site is the fallback for the
// rare client that omits it; with neither header present the request is refused.
function sameOrigin(request) {
  const origin = request.headers.get("Origin");

  if (origin) {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }

  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

function authorized(request, password) {
  const header = request.headers.get("Authorization") || "";

  if (!header.startsWith("Basic ")) return false;
  if (!password) return false;

  // Basic auth sends "user:password"; the username is ignored here.
  const decoded = atob(header.slice(6));
  const supplied = decoded.slice(decoded.indexOf(":") + 1);

  return timingSafeEqual(supplied, password);
}

// Compares without leaking length-independent timing information.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function extensionOf(name) {
  const clean = String(name || "").toLowerCase();
  return clean.includes(".") ? clean.split(".").pop() : "";
}

function contentTypeFor(extension) {
  return extension === "png"
    ? "image/png"
    : extension === "gif"
      ? "image/gif"
      : extension === "webp"
        ? "image/webp"
        : "image/jpeg";
}

function safeFilename(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 80);
}

function today() {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// Timestamps are stored as UTC; central time is only for display.
function formatDate(iso) {
  const date = new Date(iso);

  if (isNaN(date)) return iso;

  // timeZoneName gives CST or CDT depending on the date.
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function toBase64(text) {
  return bufferToBase64(new TextEncoder().encode(text).buffer);
}

function fromBase64(base64) {
  const binary = atob(String(base64).replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Chunked so large images don't blow the argument limit on fromCharCode.
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

// Messages are attacker-controlled text, so they must never be trusted as markup.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title, contents) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — nathan simpson</title>
<link rel="stylesheet" href="https://nathansimpson.org/style.css">
</head>
<body>

<nav><a href="https://nathansimpson.org/">&larr; back to index</a></nav>

<h1>${escapeHtml(title)}</h1>

${contents}

</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
