// Pre-build the MiniSearch index and a snippets file so the client can
// `loadJSON` instead of indexing 190k+ messages on page load.
//
// Ships two files:
//   search-index.json  ~77 MB raw / ~16 MB gzipped — the inverted index
//                       plus nav-only stored fields (no text).
//   snippets.json      ~20 MB raw /  ~8 MB gzipped — { "<discord_msg_id>":
//                       "first 180 chars of text" } for rendering search
//                       result previews.
//
// Keep `fields`, `storeFields`, and `tokenize` in sync with
// site/assets/app.js.

import { readFileSync, writeFileSync } from "node:fs";
import MiniSearch from "minisearch";

const messages = JSON.parse(readFileSync("site/data/messages.json", "utf8"));

const tokenize = (str) =>
  String(str)
    .toLowerCase()
    .split(/[\s\-.,;:!?/\\<>()\[\]{}"'`|]+/)
    .filter(Boolean);

const search = new MiniSearch({
  fields: ["text", "author", "author_handle"],
  storeFields: ["author", "author_handle", "thread", "timestamp_short", "_msgId"],
  tokenize,
});

search.addAll(
  messages.map((m, idx) => ({
    id: idx,
    text: m.text,
    author: m.author,
    author_handle: m.author_handle,
    thread: m.thread,
    timestamp_short: m.timestamp_short,
    _msgId: m.id,
  })),
);

writeFileSync("site/data/search-index.json", JSON.stringify(search));

const snippets = {};
for (const m of messages) {
  snippets[m.id] = (m.text || "").slice(0, 180);
}
writeFileSync("site/data/snippets.json", JSON.stringify(snippets));

console.log(`search-index.json + snippets.json written (${messages.length} messages)`);
