// Applies the saved theme before the page paints (an external file, so the CSP can forbid inline scripts).
(function () {
  var t = 'auto';
  try { t = (JSON.parse(localStorage.getItem('checkin.settings') || '{}').theme) || 'auto'; } catch (e) {}
  var dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
