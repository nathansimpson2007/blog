// Counts a page view for the stats section of the admin panel.
//
// Sends only the page's path and, if the visitor followed a link from another
// site, that site's name. No cookies, nothing stored in the browser, and the
// Worker keeps daily totals rather than individual visits.
//
// Deliberately left off messages.html, which promises nothing is recorded.
(function () {
  if (!navigator.sendBeacon) return;

  var from = "";

  try {
    from = document.referrer ? new URL(document.referrer).hostname : "";
  } catch (error) {}

  navigator.sendBeacon(
    "https://messages.nathansimpson.org/hit",
    JSON.stringify({ path: location.pathname, from: from })
  );
})();
