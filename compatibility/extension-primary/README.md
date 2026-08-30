# Extension-primary compatibility reference

This directory quarantines the retained browser-extension execution, player,
subtitle, license, collection, and file-writing implementation. It is kept only
as behavior-tested compatibility/reference source; the shipped extension is the
exact import closure declared by `scripts/store-runtime-files.json`.

Files in this directory may import a small shared source set that remains at the
repository root because the shipped connector also imports it. Shipped source
must never import this directory, and no file here may enter staging or a store
package. `runtime-graph.test.mjs` and `source-hygiene.test.mjs` enforce those
directions.

The direct shared imports are `candidate.js`, `download.js`,
`download-policy.js`, `downloaders/ids.js`, `edition.js`, `i18n.js`,
`level5-key-error.js`, `popup.css`, and `popup.js`. Their transitive imports
also stay shared. Every one is part of the manifest-reachable 58-file runtime
graph, so compatibility consumes the same implementations instead of
duplicating them. `node scripts/report-compatibility-closure.mjs` reports the
exact current transitive intersection and any missing or outside-runtime edge.

Run `npm run test:legacy` for this reference suite and `npm run test:shipped`
for all other Node tests. `npm test` remains the broad automatic discovery run.
