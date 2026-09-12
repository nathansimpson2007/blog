// Four things live here:
//   - private messages, written at /submit and readable only at /admin
//   - a public guestbook, on guestbook.nathansimpson.org, held for approval
//   - a public poker bankroll tracker, on poker.nathansimpson.org
//   - the admin panel at /admin, which also publishes to the blog repo
//
// Private messages and guestbook entries use different tables so a private
// message can never surface publicly.
//
// Bindings this Worker needs:
//   DB              -> D1 database (messages, guestbook, poker_sessions, settings)
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

// How much notice to give before the GitHub token stops working.
const EXPIRY_WARNING_DAYS = 14;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const isPoker = url.hostname.startsWith("poker.") || url.pathname === "/poker";

    // The public tracker is read-only; sessions are only ever changed from /admin.
    if (isPoker) {
      return request.method === "GET" || request.method === "HEAD"
        ? handlePokerPage(env)
        : new Response("Method not allowed", { status: 405 });
    }

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

  const [poker, messages, pending, approved] = await Promise.all([
    loadPoker(env),
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

  const bannerHtml = notice
    ? `<p class="notice">${escapeHtml(notice)}</p>`
    : problem
      ? `<p class="problem">${escapeHtml(problem)}</p>`
      : "";

  // Poker actions land back on their own section, so show the result there
  // rather than at the top of a long page.
  const pokerFocused = url.searchParams.get("at") === "poker";
  const banner = pokerFocused ? "" : bannerHtml;

  // One probe drives both the status line and the now-page prefill, so a dead
  // token is obvious immediately rather than after typing out a whole post.
  const github = await probeGitHub(env);

  const status = github.ok ? renderTokenStatus(github.expires) : "";

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
    renderPokerAdmin(poker, url.searchParams.get("edit-poker"), pokerFocused ? bannerHtml : ""),
    "<h2>guestbook — waiting for approval</h2>",
    renderQueue(pending.results, true),
    "<h2>guestbook — published</h2>",
    renderQueue(approved.results, false),
    "<h2>private messages</h2>",
    renderMessages(messages.results),
  ];

  return page("admin", sections.join("\n"));
}

// Publishing dies silently on the day the token expires, so warn while there is
// still time to replace it.
function renderTokenStatus(expires) {
  if (!expires) return `<p class="date">github: connected</p>`;

  // GitHub sends "2027-09-11 15:30:00 UTC", which isn't ISO 8601.
  const parsed = new Date(String(expires).trim().replace(" UTC", "Z").replace(" ", "T"));
  const daysLeft = Math.floor((parsed - Date.now()) / 86400000);

  if (isNaN(daysLeft)) {
    return `<p class="date">github: connected · token expires ${escapeHtml(expires)}</p>`;
  }

  if (daysLeft <= EXPIRY_WARNING_DAYS) {
    const when =
      daysLeft <= 0
        ? "today"
        : daysLeft === 1
          ? "tomorrow"
          : `in ${daysLeft} days`;

    return `<p class="problem">the github token expires ${when} (${escapeHtml(
      expires.slice(0, 10)
    )}). replace it with: wrangler secret put GITHUB_TOKEN</p>`;
  }

  return `<p class="date">github: connected · token expires ${escapeHtml(
    expires.slice(0, 10)
  )} (${daysLeft} days)</p>`;
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
  <p><input type="file" name="image" accept="image/jpeg,image/png,image/gif,image/webp" required></p>
  <p><input type="text" name="date" value="${escapeHtml(today())}" required></p>
  <p><input type="text" name="caption" placeholder="caption (optional)" maxlength="200"></p>
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

      const name = await uploadPicture(
        env,
        image,
        (form.get("date") || "").trim(),
        (form.get("caption") || "").trim()
      );

      return backToAdmin(request, `uploaded ${name}. the page rebuilds in a moment.`);
    }
    if (action === "add-poker" || action === "update-poker") {
      const session = parsePokerForm(form);

      if (session.error) {
        return backToAdmin(request, null, session.error, "poker");
      }

      const values = [
        session.playedOn,
        session.game,
        session.stakes,
        session.location,
        session.hours,
        session.buyIn,
        session.cashOut,
        session.notes,
      ];

      if (action === "update-poker") {
        if (!validId(id)) {
          return backToAdmin(request, null, "that session wasn't found.", "poker");
        }

        await env.DB.prepare(
          `UPDATE poker_sessions
           SET played_on = ?, game = ?, stakes = ?, location = ?, hours = ?,
               buy_in_cents = ?, cash_out_cents = ?, notes = ?
           WHERE id = ?`
        )
          .bind(...values, id)
          .run();

        return backToAdmin(request, "session updated.", null, "poker");
      }

      await env.DB.prepare(
        `INSERT INTO poker_sessions
         (played_on, game, stakes, location, hours, buy_in_cents, cash_out_cents, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(...values, new Date().toISOString())
        .run();

      return backToAdmin(request, "session added.", null, "poker");
    }

    if (action === "delete-poker" && validId(id)) {
      await env.DB.prepare("DELETE FROM poker_sessions WHERE id = ?").bind(id).run();
      return backToAdmin(request, "session deleted.", null, "poker");
    }

    if (action === "poker-start") {
      const cents = parseCents(form.get("amount"));

      if (cents === null) {
        return backToAdmin(
          request,
          null,
          "the starting bankroll needs to be a dollar amount, like 500 or 500.00.",
          "poker"
        );
      }

      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('poker_starting_bankroll_cents', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
        .bind(String(cents))
        .run();

      return backToAdmin(request, "starting bankroll saved.", null, "poker");
    }
  } catch (error) {
    return backToAdmin(request, null, error.message);
  }

  return backToAdmin(request, null, "that action wasn't understood.");
}

function validId(id) {
  return Number.isInteger(id) && id > 0;
}

// Redirect after acting so a refresh doesn't repeat it. A section name jumps the
// page back to that section and shows the result there.
function backToAdmin(request, notice, problem, section) {
  const target = new URL("/admin", request.url);

  if (notice) target.searchParams.set("ok", notice);
  if (problem) target.searchParams.set("err", problem);

  if (section) {
    target.searchParams.set("at", section);
    target.hash = section;
  }

  return Response.redirect(target.toString(), 303);
}

/* -------------------------------------------------------------------- poker */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function money(cents) {
  return usd.format(cents / 100);
}

function signedMoney(cents) {
  return cents > 0 ? `+${money(cents)}` : money(cents);
}

function formatHours(hours) {
  return String(Math.round(hours * 100) / 100);
}

// Accepts "200", "200.50", "$1,200". Returns whole cents, or null if unusable.
function parseCents(value) {
  const clean = String(value || "").trim().replace(/[$,\s]/g, "");

  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;

  return Math.round(Number(clean) * 100);
}

// Loads every session oldest first and walks forward through them, so each row
// knows the bankroll it left behind.
async function loadPoker(env) {
  const [sessions, start] = await Promise.all([
    env.DB.prepare("SELECT * FROM poker_sessions ORDER BY played_on ASC, id ASC").all(),
    env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'poker_starting_bankroll_cents'"
    ).first(),
  ]);

  const startingCents = start ? Number(start.value) || 0 : 0;

  let running = startingCents;

  const rows = sessions.results.map((session) => {
    const profit = session.cash_out_cents - session.buy_in_cents;
    running += profit;
    return { ...session, profit, bankrollAfter: running };
  });

  // The hourly rate only counts sessions that recorded hours, so a session
  // logged without them doesn't inflate it.
  const timed = rows.filter((row) => row.hours > 0);
  const hours = timed.reduce((sum, row) => sum + row.hours, 0);
  const timedProfit = timed.reduce((sum, row) => sum + row.profit, 0);

  return {
    startingCents,
    bankroll: running,
    totalProfit: running - startingCents,
    count: rows.length,
    hours,
    hourly: hours > 0 ? timedProfit / hours : null,
    rows,
  };
}

function parsePokerForm(form) {
  const text = (name, max) => (form.get(name) || "").trim().slice(0, max);

  const playedOn = text("date", 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(playedOn) || isNaN(new Date(playedOn))) {
    return { error: "the date needs to look like 2026-09-12." };
  }

  const buyIn = parseCents(form.get("buy_in"));
  const cashOut = parseCents(form.get("cash_out"));

  if (buyIn === null) {
    return { error: "the buy-in needs to be a dollar amount, like 200 or 200.50." };
  }

  if (cashOut === null) {
    return { error: "the cash-out needs to be a dollar amount, like 0 or 350." };
  }

  const hoursText = text("hours", 10);
  let hours = null;

  if (hoursText) {
    hours = Number(hoursText);

    if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
      return { error: "hours needs to be a number above 0 and no more than 72." };
    }
  }

  return {
    playedOn,
    game: text("game", 60) || null,
    stakes: text("stakes", 60) || null,
    location: text("location", 100) || null,
    hours,
    buyIn,
    cashOut,
    notes: text("notes", 1000) || null,
  };
}

async function handlePokerPage(env) {
  const poker = await loadPoker(env);

  const summaryRows = [
    ["bankroll", money(poker.bankroll)],
    ["profit", signedMoney(poker.totalProfit)],
    ["sessions", String(poker.count)],
    ["hours", formatHours(poker.hours)],
  ];

  if (poker.hourly !== null) {
    summaryRows.push(["per hour", signedMoney(Math.round(poker.hourly))]);
  }

  const summary = `<table>
${summaryRows.map(([label, value]) => `<tr><th>${label}</th><td class="num">${value}</td></tr>`).join("\n")}
</table>`;

  const columns = [
    ["date", false],
    ["game", false],
    ["stakes", false],
    ["location", false],
    ["hours", true],
    ["buy-in", true],
    ["cash-out", true],
    ["profit", true],
    ["bankroll", true],
    ["notes", false],
  ];

  const header = columns
    .map(([label, numeric]) => `<th${numeric ? ' class="num"' : ""}>${label}</th>`)
    .join("");

  const body = [...poker.rows]
    .reverse()
    .map(
      (row) => `<tr>
<td class="num">${escapeHtml(row.played_on)}</td>
<td>${escapeHtml(row.game || "")}</td>
<td>${escapeHtml(row.stakes || "")}</td>
<td>${escapeHtml(row.location || "")}</td>
<td class="num">${row.hours > 0 ? formatHours(row.hours) : ""}</td>
<td class="num">${money(row.buy_in_cents)}</td>
<td class="num">${money(row.cash_out_cents)}</td>
<td class="num">${signedMoney(row.profit)}</td>
<td class="num">${money(row.bankrollAfter)}</td>
<td>${escapeHtml(row.notes || "")}</td>
</tr>`
    )
    .join("\n");

  const sessions = `<div class="table-wrap"><table>
<tr>${header}</tr>
${body}
</table></div>`;

  return page("poker", `${summary}\n\n${sessions}`);
}

function renderPokerAdmin(poker, editId, banner) {
  const editing = editId ? poker.rows.find((row) => String(row.id) === String(editId)) : null;
  const value = (field) => escapeHtml(editing && editing[field] != null ? editing[field] : "");
  const dollars = (cents) => (cents / 100).toFixed(2);

  const form = `<form method="POST" action="/admin">
  <input type="hidden" name="action" value="${editing ? "update-poker" : "add-poker"}">
  ${editing ? `<input type="hidden" name="id" value="${editing.id}">` : ""}
  <p><input type="text" name="date" value="${escapeHtml(editing ? editing.played_on : today())}" required></p>
  <p><input type="text" name="game" value="${value("game")}" placeholder="game" maxlength="60"></p>
  <p><input type="text" name="stakes" value="${value("stakes")}" placeholder="stakes" maxlength="60"></p>
  <p><input type="text" name="location" value="${value("location")}" placeholder="location" maxlength="100"></p>
  <p><input type="text" name="hours" value="${value("hours")}" placeholder="hours" inputmode="decimal"></p>
  <p><input type="text" name="buy_in" value="${editing ? dollars(editing.buy_in_cents) : ""}" placeholder="buy-in" inputmode="decimal" required></p>
  <p><input type="text" name="cash_out" value="${editing ? dollars(editing.cash_out_cents) : ""}" placeholder="cash-out" inputmode="decimal" required></p>
  <textarea name="notes" placeholder="notes" maxlength="1000">${value("notes")}</textarea>
  <button type="submit">${editing ? "save session" : "add session"}</button>
  ${editing ? `<a href="/admin#poker">cancel</a>` : ""}
</form>`;

  const start = `<form method="POST" action="/admin">
  <input type="hidden" name="action" value="poker-start">
  <p><input type="text" name="amount" value="${dollars(poker.startingCents)}" inputmode="decimal" required>
  <button type="submit">set starting bankroll</button></p>
</form>`;

  const list = [...poker.rows]
    .reverse()
    .map((row) => {
      const detail = [row.game, row.stakes, row.location]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ");

      return `<p class="date">${escapeHtml(row.played_on)}${detail ? ` · ${detail}` : ""}</p><p>${signedMoney(
        row.profit
      )}</p><p class="actions"><a href="/admin?edit-poker=${row.id}#poker">edit</a> ${actionButton(
        row.id,
        "delete-poker",
        "delete"
      )}</p><hr>`;
    })
    .join("\n");

  return `<h2 id="poker">poker</h2>
${banner}
<p class="date">bankroll ${money(poker.bankroll)} · ${poker.count} sessions · <a href="https://poker.nathansimpson.org/">public page</a></p>
${form}
${start}
${list}`;
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

async function uploadPicture(env, image, date, caption) {
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

  // pictures.json is the source of truth; a workflow renders the page from it.
  const manifestFile = await ghGetFile(env, "pictures.json");

  if (!manifestFile) throw new Error("pictures.json is missing from the repo.");

  let manifest;

  try {
    manifest = JSON.parse(fromBase64(manifestFile.content));
  } catch {
    throw new Error("pictures.json isn't valid JSON — fix it before uploading.");
  }

  manifest.unshift({ file: name, date: date || today(), caption: caption || "" });

  await ghPutFile(
    env,
    "pictures.json",
    toBase64(`${JSON.stringify(manifest, null, 2)}\n`),
    `List ${name} in the pictures manifest`,
    manifestFile.sha
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
