// Regenerates pictures.html from pictures.json, newest first.
//
// pictures.json is the source of truth: edit it (or let the admin panel add to
// it) and this rewrites the page. Run by .github/workflows/pictures.yml.

import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("pictures.json", "utf8"));

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Newest first. Ties keep the order they appear in the manifest, so the most
// recently added of two same-day pictures stays on top.
const pictures = [...manifest].sort((a, b) => String(b.date).localeCompare(String(a.date)));

const body = pictures.length
  ? pictures
      .map((picture) => {
        const caption = picture.caption
          ? `\n<p>${escapeHtml(picture.caption)}</p>`
          : "";

        return `<figure>
<img src="images/${escapeHtml(picture.file)}" alt="${escapeHtml(picture.caption)}">
<p class="date">${escapeHtml(picture.date)}</p>${caption}
</figure>`;
      })
      .join("\n\n")
  : "<p>no pictures yet.</p>";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>pictures — nathan simpson</title>
<link rel="stylesheet" href="style.css">
</head>
<body>

<nav><a href="index.html">&larr; back to index</a></nav>

<h1>pictures</h1>

${body}

</body>
</html>
`;

writeFileSync("pictures.html", html);
console.log(`Wrote pictures.html — ${pictures.length} pictures.`);
