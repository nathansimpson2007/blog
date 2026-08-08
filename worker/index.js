// Receives anonymous messages from the blog and stores them in D1.
// Only /admin can read them back, behind a password.
//
// Bindings this Worker needs:
//   DB              -> D1 database (the one holding the messages table)
//   ADMIN_PASSWORD  -> secret, the password for /admin

const MAX_LENGTH = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/admin") {
      return handleAdmin(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

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

  const { results } = await env.DB.prepare(
    "SELECT body, created_at FROM messages ORDER BY id DESC"
  ).all();

  if (!results.length) {
    return page("messages", "<p>no messages yet.</p>");
  }

  const list = results
    .map(
      (m) =>
        `<p class="date">${escapeHtml(formatDate(m.created_at))}</p><p>${escapeHtml(m.body)}</p><hr>`
    )
    .join("\n");

  return page("messages", list);
}

// Timestamps are stored as UTC; central time is only for display.
function formatDate(iso) {
  const date = new Date(iso);

  if (isNaN(date)) return iso;

  const formatted = date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `${formatted} CST`;
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
