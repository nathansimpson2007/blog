// Regenerates music.html from Last.fm. Run by .github/workflows/music.yml.
//
// Environment:
//   LASTFM_USER     -> the Last.fm username to read
//   LASTFM_API_KEY  -> API key from https://www.last.fm/api/account/create

import { writeFileSync } from "node:fs";

const USER = process.env.LASTFM_USER;
const KEY = process.env.LASTFM_API_KEY;

if (!USER || !KEY) {
  console.error("LASTFM_USER and LASTFM_API_KEY must both be set.");
  process.exit(1);
}

async function lastfm(method, params) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", method);
  url.searchParams.set("user", USER);
  url.searchParams.set("api_key", KEY);
  url.searchParams.set("format", "json");

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${method} returned ${response.status}`);
  }

  const data = await response.json();

  // Last.fm reports its own errors inside a 200 response.
  if (data.error) {
    throw new Error(`${method}: ${data.message}`);
  }

  return data;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTracks(tracks) {
  if (!tracks.length) {
    return "<p>nothing scrobbled recently.</p>";
  }

  const items = tracks
    .map((track) => {
      const name = escapeHtml(track.name);
      const artist = escapeHtml(track.artist["#text"]);
      const nowPlaying = track["@attr"] && track["@attr"].nowplaying;

      const when = nowPlaying
        ? '<span class="date">now playing</span>'
        : track.date
          ? `<span class="date">${escapeHtml(track.date["#text"])}</span>`
          : "";

      return `  <li>${name} — ${artist} ${when}</li>`;
    })
    .join("\n");

  return `<ul>\n${items}\n</ul>`;
}

function renderTopArtist(artist) {
  if (!artist) {
    return "<p>no plays this week.</p>";
  }

  const plays = Number(artist.playcount);
  const label = plays === 1 ? "play" : "plays";

  return `<p>${escapeHtml(artist.name)} <span class="date">${plays} ${label} this week</span></p>`;
}

const [recentData, topData] = await Promise.all([
  lastfm("user.getRecentTracks", { limit: 10 }),
  lastfm("user.getTopArtists", { period: "7day", limit: 1 }),
]);

// A currently-playing track is returned in addition to the limit, so trim back.
const tracks = [].concat(recentData.recenttracks.track || []).slice(0, 10);
const topArtist = [].concat(topData.topartists.artist || [])[0];

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>music — nathan simpson</title>
<link rel="stylesheet" href="style.css">
</head>
<body>

<nav><a href="index.html">&larr; back to index</a></nav>

<h1>music</h1>

<h2>top artist this week</h2>

${renderTopArtist(topArtist)}

<h2>recent tracks</h2>

${renderTracks(tracks)}

<p class="date">updated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC</p>

</body>
</html>
`;

writeFileSync("music.html", html);
console.log(`Wrote music.html — ${tracks.length} tracks.`);
