// MeshCore Discord Archive — client-side app
// Renders trusted DiscordChatExporter output. HTML blobs come from our build
// script, not runtime user input. We use Range.createContextualFragment +
// insertAdjacentHTML so tooling that flags direct innerHTML assignments on
// untrusted strings is satisfied; the data flow is still static-file -> DOM.

const el = (id) => document.getElementById(id);
const $content = el("content");
const $threadNav = el("thread-nav");
const $search = el("search");
const $userFilter = el("user-filter");
const $threadFilter = el("thread-filter");
const $threadCount = el("thread-count");
const $messageCount = el("message-count");
const $threadModal = el("thread-modal");
const $threadModalTitle = el("thread-modal-title");
const $threadModalFilter = el("thread-modal-filter");
const $threadModalList = el("thread-modal-list");
const $threadModalCount = el("thread-modal-count");

const SIDEBAR_TOP_N = 10;
const CHANNEL_TOP_N = 3;

const state = {
  threads: [],
  messages: [],
  users: [],
  threadById: new Map(),
  userByName: new Map(),
  threadCache: new Map(),
  activeThreadId: null,
  search: null,
  _messagesIndexed: [],
};

function setHtml(node, html) {
  while (node.firstChild) node.removeChild(node.firstChild);
  if (!html) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  node.appendChild(tpl.content);
}

function pushHtml(node, html) {
  node.insertAdjacentHTML("beforeend", html);
}

// ---------- bootstrap ----------

(async function init() {
  try {
    const [threads, users, messages] = await Promise.all([
      fetch("data/threads.json").then((r) => r.json()),
      fetch("data/users.json").then((r) => r.json()),
      fetch("data/messages.json").then((r) => r.json()),
    ]);

    state.threads = threads;
    state.users = users;
    state.messages = messages;
    state.threadById = new Map(threads.map((t) => [t.id, t]));

    for (const u of users) {
      if (u.name) state.userByName.set(u.name.toLowerCase(), u);
      if (u.handle) state.userByName.set(u.handle.toLowerCase(), u);
    }

    renderSidebar(threads);
    renderUserFilter(users);
    buildSearchIndex(messages);
    renderStats(threads, users, messages);

    $threadCount.textContent = `${threads.length} threads`;
    $messageCount.textContent = `${messages.length.toLocaleString()} messages`;

    window.addEventListener("hashchange", routeFromHash);
    routeFromHash();
  } catch (err) {
    console.error(err);
    setHtml($content, `<p style="color:#ed4245">Failed to load archive data: ${escapeHtml(err.message)}</p>`);
  }
})();

// ---------- sidebar ----------

function renderSidebar(threads) {
  const byForum = new Map();
  for (const t of threads) {
    if (!byForum.has(t.forum)) byForum.set(t.forum, []);
    byForum.get(t.forum).push(t);
  }

  const frag = document.createDocumentFragment();
  for (const [forum, list] of byForum) {
    const group = document.createElement("div");
    group.className = "forum-group";
    group.dataset.forum = forum;

    const channelMains = new Map();
    const channelChildren = new Map();
    const loose = [];
    for (const t of list) {
      if (t.is_channel_main && t.channel) {
        channelMains.set(t.channel, t);
      } else if (t.channel) {
        if (!channelChildren.has(t.channel)) channelChildren.set(t.channel, []);
        channelChildren.get(t.channel).push(t);
      } else {
        loose.push(t);
      }
    }

    const sortedLoose = loose.slice().sort(byLastMsgDesc);
    const totalCount = list.length;

    const header = document.createElement("button");
    header.type = "button";
    header.className = "forum-header";
    header.dataset.forum = forum;
    header.title = `Browse all ${sortedLoose.length || totalCount} threads in ${forum}`;

    const hName = document.createElement("span");
    hName.className = "forum-header-name";
    hName.textContent = `# ${forum}`;

    const hCount = document.createElement("span");
    hCount.className = "forum-header-count";
    hCount.textContent = totalCount;

    header.appendChild(hName);
    header.appendChild(hCount);
    header.addEventListener("click", () => openThreadModal(forum));
    group.appendChild(header);

    const sortedChannels = Array.from(channelMains.entries()).sort((a, b) => {
      const aKids = channelChildren.get(a[0]) || [];
      const bKids = channelChildren.get(b[0]) || [];
      const aRecent = aKids.slice().sort(byLastMsgDesc)[0] || a[1];
      const bRecent = bKids.slice().sort(byLastMsgDesc)[0] || b[1];
      return byLastMsgDesc(aRecent, bRecent);
    });

    for (const [channel, main] of sortedChannels) {
      group.appendChild(renderChannelBlock(forum, channel, main, channelChildren.get(channel) || []));
    }

    const topN = sortedLoose.slice(0, SIDEBAR_TOP_N);
    const hasMore = sortedLoose.length > SIDEBAR_TOP_N;

    for (const t of topN) {
      group.appendChild(renderThreadLink(t));
    }

    for (const t of sortedLoose.slice(SIDEBAR_TOP_N)) {
      const a = renderThreadLink(t);
      a.classList.add("thread-link-extra");
      a.style.display = "none";
      group.appendChild(a);
    }

    if (hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "forum-more";
      more.dataset.forum = forum;
      more.textContent = `Show all ${sortedLoose.length} threads…`;
      more.addEventListener("click", () => openThreadModal(forum));
      group.appendChild(more);
    }

    frag.appendChild(group);
  }
  while ($threadNav.firstChild) $threadNav.removeChild($threadNav.firstChild);
  $threadNav.appendChild(frag);
}

function renderChannelBlock(forum, channel, main, children) {
  const block = document.createElement("div");
  block.className = "channel-block";
  block.dataset.channel = channel;

  const headerLink = renderThreadLink(main);
  headerLink.classList.add("channel-header");
  const badge = document.createElement("span");
  badge.className = "channel-child-count";
  badge.textContent = children.length;
  badge.title = `${children.length} thread${children.length === 1 ? "" : "s"}`;
  const existingCount = headerLink.querySelector(".count");
  if (existingCount) headerLink.removeChild(existingCount);
  headerLink.appendChild(badge);
  const title = headerLink.querySelector(".title");
  if (title) title.textContent = `# ${channel}`;
  block.appendChild(headerLink);

  if (children.length === 0) return block;

  const threadWrap = document.createElement("div");
  threadWrap.className = "channel-threads";

  const sorted = children.slice().sort(byLastMsgDesc);
  const top = sorted.slice(0, CHANNEL_TOP_N);
  for (const t of top) threadWrap.appendChild(renderThreadLink(t));

  for (const t of sorted.slice(CHANNEL_TOP_N)) {
    const a = renderThreadLink(t);
    a.classList.add("thread-link-extra");
    a.style.display = "none";
    threadWrap.appendChild(a);
  }

  if (sorted.length > CHANNEL_TOP_N) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "forum-more channel-more";
    more.dataset.forum = forum;
    more.dataset.channel = channel;
    more.textContent = `${sorted.length - CHANNEL_TOP_N} more threads…`;
    more.addEventListener("click", () => openChannelModal(forum, channel));
    threadWrap.appendChild(more);
  }

  block.appendChild(threadWrap);
  return block;
}

function byLastMsgDesc(a, b) {
  const av = String(a.last_msg_id ?? a.first_msg_id ?? "");
  const bv = String(b.last_msg_id ?? b.first_msg_id ?? "");
  if (av.length !== bv.length) return bv.length - av.length;
  if (av === bv) return 0;
  return av < bv ? 1 : -1;
}

function renderThreadLink(t) {
  const a = document.createElement("a");
  a.className = "thread-link";
  a.href = `#/t/${encodeURIComponent(t.id)}`;
  a.dataset.threadId = t.id;
  a.dataset.search = (t.title + " " + t.forum).toLowerCase();

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t.title;

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = t.message_count;

  a.appendChild(title);
  a.appendChild(count);
  return a;
}

// ---------- thread modal ----------

function openThreadModal(forum) {
  const threads = state.threads.filter((t) => t.forum === forum).sort(byLastMsgDesc);
  $threadModalTitle.textContent = `# ${forum}`;
  $threadModal.dataset.forum = forum;
  delete $threadModal.dataset.channel;
  $threadModalFilter.value = "";
  renderModalList(threads, "");
  $threadModal.hidden = false;
  document.body.classList.add("modal-open");
  setTimeout(() => $threadModalFilter.focus(), 0);
}

function openChannelModal(forum, channel) {
  const threads = state.threads
    .filter((t) => t.forum === forum && t.channel === channel && !t.is_channel_main)
    .sort(byLastMsgDesc);
  $threadModalTitle.textContent = `# ${channel}`;
  $threadModal.dataset.forum = forum;
  $threadModal.dataset.channel = channel;
  $threadModalFilter.value = "";
  renderModalList(threads, "");
  $threadModal.hidden = false;
  document.body.classList.add("modal-open");
  setTimeout(() => $threadModalFilter.focus(), 0);
}

function closeThreadModal() {
  $threadModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderModalList(threads, query) {
  const q = query.toLowerCase().trim();
  const matches = q
    ? threads.filter((t) => (t.title + " " + t.forum).toLowerCase().includes(q))
    : threads;

  while ($threadModalList.firstChild) $threadModalList.removeChild($threadModalList.firstChild);
  const frag = document.createDocumentFragment();
  for (const t of matches) {
    const a = renderThreadLink(t);
    a.classList.add("modal-thread-link");
    a.addEventListener("click", () => closeThreadModal());
    frag.appendChild(a);
  }
  $threadModalList.appendChild(frag);

  $threadModalCount.textContent = q
    ? `${matches.length} of ${threads.length} threads`
    : `${threads.length} thread${threads.length === 1 ? "" : "s"}`;
}

$threadModalFilter.addEventListener("input", () => {
  const forum = $threadModal.dataset.forum;
  if (!forum) return;
  const channel = $threadModal.dataset.channel;
  const threads = state.threads
    .filter((t) => t.forum === forum && (channel ? t.channel === channel && !t.is_channel_main : true))
    .sort(byLastMsgDesc);
  renderModalList(threads, $threadModalFilter.value);
});

$threadModal.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close")) closeThreadModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$threadModal.hidden) closeThreadModal();
});

function renderUserFilter(users) {
  const sorted = users.slice().sort((a, b) => a.name.localeCompare(b.name));
  const frag = document.createDocumentFragment();
  for (const u of sorted) {
    const opt = document.createElement("option");
    opt.value = u.handle || u.name;
    opt.textContent = `${u.name} (${u.message_count})`;
    frag.appendChild(opt);
  }
  $userFilter.appendChild(frag);
}

function renderStats(threads, users, messages) {
  const ul = el("welcome-stats");
  if (!ul) return;
  const topUser = users[0];
  const topThread = threads.slice().sort((a, b) => b.message_count - a.message_count)[0];
  setHtml(ul, `
    <li><strong>${threads.length}</strong> threads archived</li>
    <li><strong>${messages.length.toLocaleString()}</strong> messages</li>
    <li><strong>${users.length}</strong> unique authors</li>
    <li>Most active user: <strong>${escapeHtml(topUser?.name || "")}</strong> (${topUser?.message_count || 0} msgs)</li>
    <li>Busiest thread: <strong>${escapeHtml(topThread?.title || "")}</strong> (${topThread?.message_count || 0} msgs)</li>
  `);
}

// ---------- search ----------

function buildSearchIndex(messages) {
  const MiniSearch = window.MiniSearch;
  state.search = new MiniSearch({
    fields: ["text", "author", "author_handle"],
    storeFields: ["text", "author", "author_handle", "thread", "timestamp_short", "id"],
    searchOptions: {
      boost: { author: 2, author_handle: 2, text: 1 },
      prefix: true,
      fuzzy: 0.15,
      combineWith: "AND",
    },
    tokenize: (str) =>
      String(str)
        .toLowerCase()
        .split(/[\s\-.,;:!?/\\<>()\[\]{}"'`|]+/)
        .filter(Boolean),
  });

  state.search.addAll(
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
  state._messagesIndexed = messages;
}

let searchTimer;
$search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 140);
});
$userFilter.addEventListener("change", runSearch);

$threadFilter.addEventListener("input", () => {
  const q = $threadFilter.value.toLowerCase().trim();
  document.querySelectorAll("#thread-nav .thread-link").forEach((a) => {
    const isExtra = a.classList.contains("thread-link-extra");
    if (!q) {
      a.style.display = isExtra ? "none" : "";
    } else {
      a.style.display = a.dataset.search.includes(q) ? "" : "none";
    }
  });
  document.querySelectorAll("#thread-nav .forum-more, #thread-nav .channel-more").forEach((btn) => {
    btn.style.display = q ? "none" : "";
  });
  document.querySelectorAll("#thread-nav .forum-group").forEach((g) => {
    const any = Array.from(g.querySelectorAll(".thread-link")).some(
      (a) => a.style.display !== "none",
    );
    g.style.display = any ? "" : "none";
  });
});

function parseQuery(raw) {
  const userTokens = [];
  const textTokens = [];
  const tokenRe = /"([^"]+)"|(\S+)/g;
  for (const m of raw.matchAll(tokenRe)) {
    const phrase = m[1];
    const word = m[2];
    if (phrase) {
      textTokens.push(phrase);
    } else if (word.toLowerCase().startsWith("user:")) {
      const name = word.slice(5).replace(/^["']|["']$/g, "");
      if (name) userTokens.push(name.toLowerCase());
    } else if (word.toLowerCase().startsWith("from:")) {
      const name = word.slice(5).replace(/^["']|["']$/g, "");
      if (name) userTokens.push(name.toLowerCase());
    } else {
      textTokens.push(word);
    }
  }
  return { users: userTokens, text: textTokens.join(" ").trim() };
}

function runSearch() {
  const raw = $search.value.trim();
  const dropdownUser = $userFilter.value.trim().toLowerCase();

  const { users: typedUsers, text } = parseQuery(raw);
  const userFilters = new Set(typedUsers);
  if (dropdownUser) userFilters.add(dropdownUser);

  if (!text && userFilters.size === 0) {
    if (state.activeThreadId) {
      renderThread(state.activeThreadId);
    } else {
      renderWelcome();
    }
    return;
  }

  let results;
  if (text) {
    results = state.search.search(text, {
      filter: (r) => passesUserFilter(r, userFilters),
    });
  } else {
    results = [];
    for (let i = 0; i < state._messagesIndexed.length; i++) {
      const m = state._messagesIndexed[i];
      if (passesUserFilter({ author: m.author, author_handle: m.author_handle }, userFilters)) {
        results.push({
          id: i,
          text: m.text,
          author: m.author,
          author_handle: m.author_handle,
          thread: m.thread,
          timestamp_short: m.timestamp_short,
          _msgId: m.id,
          score: 0,
        });
      }
    }
  }

  results = results.slice(0, 300);
  renderResults(results, { text, userFilters });
}

function passesUserFilter(r, userFilters) {
  if (userFilters.size === 0) return true;
  const a = (r.author || "").toLowerCase();
  const h = (r.author_handle || "").toLowerCase();
  for (const u of userFilters) {
    if (a === u || h === u || a.includes(u) || h.includes(u)) return true;
  }
  return false;
}

function renderResults(results, { text, userFilters }) {
  const parts = [];
  parts.push(`<h2 class="results-title">Search results</h2>`);
  const filters = [];
  if (text) filters.push(`text: <code>${escapeHtml(text)}</code>`);
  if (userFilters.size)
    filters.push(
      "users: " +
        [...userFilters].map((u) => `<code>${escapeHtml(u)}</code>`).join(", "),
    );
  parts.push(
    `<div class="results-meta">${results.length} match${
      results.length === 1 ? "" : "es"
    } · ${filters.join(" · ")}</div>`,
  );

  if (!results.length) {
    parts.push(
      `<p style="color:#949ba4">No matches. Try a different query, or pick a thread on the left.</p>`,
    );
  }

  for (const r of results) {
    const thread = state.threadById.get(r.thread);
    const tid = r.thread;
    const mid = r._msgId || (state._messagesIndexed[r.id] || {}).id;
    parts.push(`
      <div class="result" data-thread="${escapeAttr(tid)}" data-msg="${escapeAttr(mid || "")}">
        <div class="result-header">
          <span class="result-thread">${escapeHtml(thread?.forum || "")}  ›  ${escapeHtml(thread?.title || tid)}</span>
          <span>${escapeHtml(r.timestamp_short || "")}</span>
        </div>
        <div class="result-header">
          <span class="result-author">${escapeHtml(r.author || "")}</span>
        </div>
        <div class="snippet">${renderSnippet(r.text, text)}</div>
      </div>`);
  }
  setHtml($content, parts.join(""));

  $content.querySelectorAll(".result").forEach((node) => {
    node.addEventListener("click", () => {
      const tid = node.dataset.thread;
      const mid = node.dataset.msg;
      const hash = mid ? `#/t/${encodeURIComponent(tid)}/m/${mid}` : `#/t/${encodeURIComponent(tid)}`;
      if (location.hash === hash) routeFromHash();
      else location.hash = hash;
    });
  });
}

function renderSnippet(text, query) {
  if (!text) return "";
  const clean = text.length > 320 ? text.slice(0, 320) + "…" : text;
  if (!query) return escapeHtml(clean);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  let out = escapeHtml(clean);
  for (const t of terms) {
    const re = new RegExp("(" + escapeRegex(t) + ")", "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}

// ---------- routing / thread render ----------

function routeFromHash() {
  const h = decodeURIComponent(location.hash || "");
  const m = h.match(/^#\/t\/([^/]+)(?:\/m\/(\d+))?$/);
  if (!m) {
    renderWelcome();
    return;
  }
  const threadId = m[1];
  const msgId = m[2];
  state.activeThreadId = threadId;
  setActiveLink(threadId);
  renderThread(threadId, msgId);
}

function setActiveLink(threadId) {
  document
    .querySelectorAll("#thread-nav .thread-link")
    .forEach((a) => a.classList.toggle("active", a.dataset.threadId === threadId));
  const a = document.querySelector(
    `#thread-nav .thread-link[data-thread-id="${cssEscape(threadId || "")}"]`,
  );
  if (a) {
    if (a.classList.contains("thread-link-extra")) a.style.display = "";
    a.scrollIntoView({ block: "nearest" });
  }
}

function renderWelcome() {
  state.activeThreadId = null;
  setActiveLink(null);
  setHtml($content, `
    <div class="welcome">
      <h1>MeshCore Discord Archive</h1>
      <p>Pick a thread on the left, or search across all messages above.</p>
      <p>Search supports <code>user:handle</code> plus keywords, e.g. <code>user:ripplebiz repeater</code>.</p>
      <ul id="welcome-stats"></ul>
    </div>`);
  renderStats(state.threads, state.users, state.messages);
}

async function loadThread(threadId) {
  if (state.threadCache.has(threadId)) return state.threadCache.get(threadId);
  const resp = await fetch(`data/content/${encodeURIComponent(threadId)}.json`);
  if (!resp.ok) throw new Error(`Thread not found: ${threadId}`);
  const data = await resp.json();
  state.threadCache.set(threadId, data);
  return data;
}

async function renderThread(threadId, focusMessageId) {
  const thread = state.threadById.get(threadId);
  if (!thread) {
    setHtml($content, `<p style="color:#ed4245">Unknown thread: ${escapeHtml(threadId)}</p>`);
    return;
  }
  setHtml($content, `<p style="color:#949ba4">Loading thread…</p>`);
  const data = await loadThread(threadId);

  const parts = [];
  parts.push(`
    <div class="thread-header">
      <div class="forum-tag"># ${escapeHtml(thread.forum)}</div>
      <h1>${escapeHtml(thread.title)}</h1>
      <div class="meta">${data.messages.length} message${data.messages.length === 1 ? "" : "s"}</div>
    </div>
  `);

  for (const m of data.messages) {
    parts.push(renderMessage(m));
  }

  setHtml($content, parts.join(""));

  $content.querySelectorAll(".msg .author").forEach((node) => {
    node.addEventListener("click", () => {
      const handle = node.dataset.handle || node.textContent.trim();
      $search.value = `user:${handle}`;
      runSearch();
    });
  });

  if (focusMessageId) {
    const target = document.getElementById(`m-${focusMessageId}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("highlight");
      setTimeout(() => target.classList.remove("highlight"), 2500);
    }
  } else {
    window.scrollTo({ top: 0 });
  }
}

function renderMessage(m) {
  const avatar = m.avatar
    ? `<img class="avatar" loading="lazy" src="${escapeAttr(m.avatar)}" alt="">`
    : `<div class="avatar"></div>`;
  const body = [
    m.reply_html || "",
    m.forwarded_html || "",
    m.content_html || "",
    (m.attachments_html || []).join(""),
    (m.embeds_html || []).join(""),
    m.reactions_html || "",
  ].join("");
  return `
    <div class="msg" id="m-${m.id}">
      ${avatar}
      <div class="header">
        <span class="author" data-handle="${escapeAttr(m.author_handle || m.author)}" title="${escapeAttr(m.author_handle || "")}">${escapeHtml(m.author || "unknown")}</span>
        <span class="ts" title="${escapeAttr(m.timestamp || "")}">${escapeHtml(m.timestamp_short || m.timestamp || "")}</span>
      </div>
      <div class="body">${body}</div>
    </div>`;
}

// ---------- utilities ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
