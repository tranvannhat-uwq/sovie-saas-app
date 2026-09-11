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
  'style.css',
  'landing.css',
  'landing-premium.css',
  'landing-reference.css',
  'ui-system.css',
  'navigation-reference.css',
  'luminous-engine.css',
  'sovie-favicon.png',
  'sovie-logo.png',
  'absjapan.png',
  'festiva.png',
  'hatacco.png',
  'warehouse-operations.jpg'
]);
