/**
 * Files copied verbatim into the static Cloudflare bundle.
 *
 * Keep this list deliberately small and explicit: JavaScript is copied from
 * `js/` as a module tree, while every root-level asset must be declared here.
 * `verify-project-structure.mjs` checks that the HTML cannot reference an
 * undeployed local asset.
 */
export const publicFiles = Object.freeze([
  'CNAME',
  'index.html',
  'styles/base.css',
  'styles/app.css',
  'styles/landing.css',
  'styles/print.css',
  'sovie-favicon.png',
  'sovie-logo.png',
  'absjapan.png',
  'festiva.png',
  'hatacco.png',
  'warehouse-operations.jpg'
]);

// These assets are referenced with explicit ?v= cache-busting keys in the
// HTML, so the deployed edge may safely cache each exact URL for one year.
export const immutablePublicFiles = Object.freeze([
  'styles/base.css',
  'styles/app.css',
  'styles/landing.css',
  'styles/print.css',
  'sovie-favicon.png',
  'sovie-logo.png',
  'warehouse-operations.jpg'
]);
