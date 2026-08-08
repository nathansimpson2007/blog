// Adds previous/next links to the bottom of every post.
//
// The index is the source of truth for ordering, so posts appear in the same
// sequence readers see there. Re-run after adding a post:
//   node scripts/build-nav.js

import { readFileSync, writeFileSync } from "node:fs";

const index = readFileSync("index.html", "utf8");

// Each entry looks like: <li><a href="posts/name.html">Title</a> ...
const pattern = /<li><a href="posts\/([^"]+)">([^<]+)<\/a>/g;
const posts = [...index.matchAll(pattern)].map((match) => ({
  file: match[1],
  title: match[2],
}));

if (!posts.length) {
  console.error("No posts found in index.html — is the markup still the same?");
  process.exit(1);
}

function link(post, arrow, trailing) {
  const label = trailing ? `${post.title} ${arrow}` : `${arrow} ${post.title}`;
  return `<a href="${post.file}">${label}</a>`;
}

posts.forEach((post, i) => {
  const path = `posts/${post.file}`;
  let html = readFileSync(path, "utf8");

  const previous = posts[i - 1];
  const next = posts[i + 1];

  const parts = [];
  if (previous) parts.push(link(previous, "&larr;", false));
  if (next) parts.push(link(next, "&rarr;", true));

  // Strip any block from a previous run so this stays idempotent.
  html = html.replace(/\n*<nav class="postnav">[\s\S]*?<\/nav>\n*/, "\n\n");

  if (parts.length) {
    const block = `<nav class="postnav">\n${parts.join("\n·\n")}\n</nav>\n\n`;
    html = html.replace("</body>", `${block}</body>`);
  }

  writeFileSync(path, html);
});

console.log(`Linked ${posts.length} posts.`);
