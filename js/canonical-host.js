(function redirectToCanonicalHost() {
  var canonicalHost = document.documentElement?.dataset?.canonicalHost || 'sovie.vn';
  var hostname = String(window.location.hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  var localHosts = new Set(['localhost', '127.0.0.1', '::1']);

  if (!hostname || localHosts.has(hostname)) return;
  if (hostname === canonicalHost && window.location.origin === `https://${canonicalHost}`) return;

  var canonicalUrl = new URL(window.location.href);
  canonicalUrl.protocol = 'https:';
  canonicalUrl.hostname = canonicalHost;
  canonicalUrl.port = '';
  window.location.replace(canonicalUrl.toString());
}());
