// ids.js
//
// Stable identity for everything the secretary tracks.
//
// The whole memory model depends on this: the same real-world thing must
// always produce the same id, across runs, forever. A Gmail thread id, a
// Calendar event id, a vault note path — hashed with its source namespace.
//
// contentHash is separate: it changes when the *content* changes, which is
// how we detect "this moved" vs "this is new".

import { createHash } from "node:crypto";

function sha(input) {
  return createHash("sha1").update(String(input)).digest("hex").slice(0, 12);
}

/** Stable id for an item. Same (source, naturalKey) => same id, always. */
export function itemId(source, naturalKey) {
  return `${source}_${sha(`${source}::${naturalKey}`)}`;
}

/** Hash of the fields that, if they change, mean the item changed. */
export function contentHash(fields) {
  return sha(JSON.stringify(fields));
}

/** Cache key for an AI classification, so we never pay to classify twice. */
export function cacheKey(kind, payload) {
  return `${kind}_${sha(JSON.stringify(payload))}`;
}
