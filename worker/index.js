// Two separate things live here:
//   - private messages, written at /submit and readable only at /admin
//   - a public guestbook, on guestbook.nathansimpson.org
// They use different tables so private messages can never surface publicly.
//
// Bindings this Worker needs:
//   DB              -> D1 database (holds the messages and guestbook tables)
//   ADMIN_PASSWORD  -> secret, the password for /admin

const MAX_LENGTH = 5000;
const GUESTBOOK_MAX_LENGTH = 1000;
const GUESTBOOK_MAX_NAME = 50;

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

    if (url.pathname === "/admin") {
      return handleAdmin(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

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

async function handleSubmit(request, env) {
  const form = await request.formData();

  // Honeypot: real people never see this field, so anything in it is a bot.
  // Return the normal thank-you page so the bot doesn't learn it was caught.
  if (form.get("website")) {
    return page("thanks", "<p>message sent. thank you.</p>");
  }

  const body = (form.get("message") || "").trim();

  if (!body) {
    return page("empty", "<p>the message was empty. nothing was sent.</p>");
  }

  if (body.length > MAX_LENGTH) {
    return page("too long", `<p>messages are capped at ${MAX_LENGTH} characters.</p>`);
  }

  await env.DB.prepare("INSERT INTO messages (body, created_at) VALUES (?, ?)")
    .bind(body, new Date().toISOString())
    .run();

  return page("thanks", "<p>message sent. thank you.</p>");
}

async function handleAdmin(request, env) {
  if (!authorized(request, env.ADMIN_PASSWORD)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="messages"' },
    });
  }

  if (request.method === "POST") {
    return handleAdminAction(request, env);
  }

  const [messages, pending, approved] = await Promise.all([
    env.DB.prepare("SELECT body, created_at FROM messages ORDER BY id DESC").all(),
    env.DB.prepare(
      "SELECT id, name, body, created_at FROM guestbook WHERE approved = 0 ORDER BY id DESC"
    ).all(),
    env.DB.prepare(
      "SELECT id, name, body, created_at FROM guestbook WHERE approved = 1 ORDER BY id DESC"
    ).all(),
  ]);

  const sections = [
    "<h2>guestbook — waiting for approval</h2>",
    renderQueue(pending.results, true),
    "<h2>guestbook — published</h2>",
    renderQueue(approved.results, false),
    "<h2>private messages</h2>",
    messages.results.length
      ? messages.results
          .map(
            (m) =>
              `<p class="date">${escapeHtml(formatDate(m.created_at))}</p><p>${escapeHtml(m.body)}</p><hr>`
          )
          .join("\n")
      : "<p>no messages yet.</p>",
  ];

  return page("admin", sections.join("\n"));
}

function renderQueue(entries, showApprove) {
  if (!entries.length) {
    return showApprove ? "<p>nothing waiting.</p>" : "<p>nothing published yet.</p>";
  }

  return entries
    .map((entry) => {
      const approve = showApprove
        ? `<form method="POST" action="/admin"><input type="hidden" name="id" value="${entry.id}"><input type="hidden" name="action" value="approve"><button type="submit">approve</button></form>`
        : "";

      const remove = `<form method="POST" action="/admin"><input type="hidden" name="id" value="${entry.id}"><input type="hidden" name="action" value="delete"><button type="submit">delete</button></form>`;

      return `<p class="date">${escapeHtml(entry.name || "anonymous")} · ${escapeHtml(
        formatDate(entry.created_at)
      )}</p><p>${escapeHtml(entry.body)}</p><p class="actions">${approve}${remove}</p><hr>`;
    })
    .join("\n");
}

async function handleAdminAction(request, env) {
  const form = await request.formData();
  const id = Number(form.get("id"));
  const action = form.get("action");

  if (Number.isInteger(id) && id > 0) {
    if (action === "approve") {
      await env.DB.prepare("UPDATE guestbook SET approved = 1 WHERE id = ?").bind(id).run();
    } else if (action === "delete") {
      await env.DB.prepare("DELETE FROM guestbook WHERE id = ?").bind(id).run();
    }
  }

  // Redirect so a refresh doesn't repeat the action.
  return Response.redirect(new URL("/admin", request.url).toString(), 303);
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
