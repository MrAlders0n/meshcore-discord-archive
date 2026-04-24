#!/usr/bin/env python3
"""
Parses DiscordChatExporter HTML files and emits JSON data for the static site.

Walks the `MeshCore/` directory, treats each subfolder as a forum/channel
category, and each .html file as a thread. Writes:

  site/data/threads.json   - list of threads (id, title, forum, message_count)
  site/data/users.json     - list of unique users (id, name, avatar)
  site/data/messages.json  - all messages, with thread id + plain text for search
  site/data/content/<thread_id>.json - per-thread HTML snippets for rendering
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "MeshCore"
OUT = ROOT / "site" / "data"
CONTENT_OUT = OUT / "content"


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:80] or "untitled"


class ClassFinder(HTMLParser):
    """Finds the outer-HTML of every top-level element whose class matches
    any of the target classes, given an already-sliced HTML fragment."""

    def __init__(self, targets: set[str]):
        super().__init__(convert_charrefs=False)
        self.targets = targets
        self.depth = 0
        self.capture_depth = 0
        self.buffer: list[str] = []
        self.current_class: str | None = None
        self.results: list[tuple[str, str]] = []  # (class, html)

    def _attr_class(self, attrs):
        for k, v in attrs:
            if k == "class" and v:
                return v
        return ""

    def handle_starttag(self, tag, attrs):
        cls = self._attr_class(attrs)
        # A start tag matches if any target class is in the class list.
        if self.capture_depth == 0 and tag == "div":
            cls_list = cls.split()
            for t in self.targets:
                if t in cls_list:
                    self.current_class = t
                    self.capture_depth = 1
                    self.buffer = [self.get_starttag_text() or ""]
                    return
        if self.capture_depth:
            self.buffer.append(self.get_starttag_text() or "")
            if tag == "div":
                self.capture_depth += 1

    def handle_endtag(self, tag):
        if self.capture_depth:
            self.buffer.append(f"</{tag}>")
            if tag == "div":
                self.capture_depth -= 1
                if self.capture_depth == 0:
                    self.results.append((self.current_class or "", "".join(self.buffer)))
                    self.buffer = []
                    self.current_class = None

    def handle_startendtag(self, tag, attrs):
        if self.capture_depth:
            self.buffer.append(self.get_starttag_text() or "")

    def handle_data(self, data):
        if self.capture_depth:
            self.buffer.append(data)

    def handle_entityref(self, name):
        if self.capture_depth:
            self.buffer.append(f"&{name};")

    def handle_charref(self, name):
        if self.capture_depth:
            self.buffer.append(f"&#{name};")


def extract_top_level(fragment: str, targets: set[str]) -> list[tuple[str, str]]:
    parser = ClassFinder(targets)
    parser.feed(fragment)
    return parser.results


class MessageContainerSplitter(HTMLParser):
    """Walks a chatlog and yields the full HTML of each chatlog__message-container."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.depth = 0
        self.capture_depth = 0
        self.buffer: list[str] = []
        self.current_id: str | None = None
        self.results: list[tuple[str, str]] = []  # (message_id, html)

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if (
            self.capture_depth == 0
            and tag == "div"
            and (d.get("id", "") or "").startswith("chatlog__message-container-")
        ):
            self.current_id = d["id"].removeprefix("chatlog__message-container-")
            self.capture_depth = 1
            self.buffer = [self.get_starttag_text() or ""]
            return
        if self.capture_depth:
            self.buffer.append(self.get_starttag_text() or "")
            if tag == "div":
                self.capture_depth += 1

    def handle_endtag(self, tag):
        if self.capture_depth:
            self.buffer.append(f"</{tag}>")
            if tag == "div":
                self.capture_depth -= 1
                if self.capture_depth == 0:
                    self.results.append((self.current_id or "", "".join(self.buffer)))
                    self.buffer = []
                    self.current_id = None

    def handle_startendtag(self, tag, attrs):
        if self.capture_depth:
            self.buffer.append(self.get_starttag_text() or "")

    def handle_data(self, data):
        if self.capture_depth:
            self.buffer.append(data)

    def handle_entityref(self, name):
        if self.capture_depth:
            self.buffer.append(f"&{name};")

    def handle_charref(self, name):
        if self.capture_depth:
            self.buffer.append(f"&#{name};")


def strip_tags(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


_AUTHOR_RE = re.compile(
    r'<span class=chatlog__author\s+title=(?:"([^"]+)"|(\S+?))\s+data-user-id=(\S+?)>([^<]*)</span>'
)
_AVATAR_RE = re.compile(r'<img class=chatlog__avatar src="([^"]+)"')
_TS_FULL_RE = re.compile(r'<span class=chatlog__timestamp title="([^"]+)">')
_TS_SHORT_RE = re.compile(r'<a href=#chatlog__message-container-\d+>([^<]+)</a>')


def parse_message_container(mid: str, frag: str) -> dict | None:
    """Parse a single chatlog__message-container's HTML into a structured dict."""
    author_m = _AUTHOR_RE.search(frag)
    if not author_m:
        # skipped / deleted / system notification
        return None
    title_name = author_m.group(1) or author_m.group(2) or ""
    user_id = author_m.group(3)
    display = html.unescape(author_m.group(4)).strip()

    avatar_m = _AVATAR_RE.search(frag)
    avatar = avatar_m.group(1) if avatar_m else ""

    ts_full_m = _TS_FULL_RE.search(frag)
    ts_full = html.unescape(ts_full_m.group(1)) if ts_full_m else ""

    ts_short_m = _TS_SHORT_RE.search(frag)
    ts_short = html.unescape(ts_short_m.group(1)) if ts_short_m else ""

    # Top-level message-primary children: reply, header, content, embed(s),
    # attachment(s), reactions, forwarded.
    parts = extract_top_level(
        frag,
        {
            "chatlog__reply",
            "chatlog__forwarded",
            "chatlog__content",
            "chatlog__embed",
            "chatlog__attachment",
            "chatlog__reactions",
        },
    )

    content_html = ""
    embeds_html: list[str] = []
    attachments_html: list[str] = []
    reactions_html = ""
    reply_html = ""
    forwarded_html = ""

    for cls, part in parts:
        if cls == "chatlog__content":
            content_html = part
        elif cls == "chatlog__embed":
            embeds_html.append(part)
        elif cls == "chatlog__attachment":
            attachments_html.append(part)
        elif cls == "chatlog__reactions":
            reactions_html = part
        elif cls == "chatlog__reply":
            reply_html = part
        elif cls == "chatlog__forwarded":
            forwarded_html = part

    text = strip_tags(content_html)

    return {
        "id": mid,
        "author": display or title_name,
        "author_handle": title_name,
        "user_id": user_id,
        "avatar": avatar,
        "timestamp": ts_full,
        "timestamp_short": ts_short,
        "text": text,
        "content_html": content_html,
        "embeds_html": embeds_html,
        "attachments_html": attachments_html,
        "reactions_html": reactions_html,
        "reply_html": reply_html,
        "forwarded_html": forwarded_html,
    }


_PREAMBLE_ENTRIES_RE = re.compile(
    r'<div class=preamble__entry[^>]*>([^<]+)</div>', re.DOTALL
)


def parse_thread(file_path: Path, forum_hint: str, channel_hint: str | None = None) -> dict:
    raw = file_path.read_text(encoding="utf-8", errors="replace")
    entries = _PREAMBLE_ENTRIES_RE.findall(raw)
    guild = html.unescape(entries[0]).strip() if entries else ""
    crumb = html.unescape(entries[1]).strip() if len(entries) > 1 else ""
    # crumb looks like "📚 Forums / <forum> / <title>" or, for a sub-thread of a
    # channel, "💬 <forum> / <channel> / <title>". Titles can contain " / ", so
    # anchor on the known folder name(s) and take the remainder as the title.
    forum = forum_hint
    title = ""
    marker = f" / {forum} / {channel_hint} / " if channel_hint else f" / {forum} / "
    idx = crumb.find(marker)
    if idx >= 0:
        title = crumb[idx + len(marker):].strip()
    else:
        # fallbacks: trailing segment of the crumb, else filename stem
        parts = [p.strip() for p in crumb.split(" / ")]
        title = parts[-1] if parts else file_path.stem
    if not title:
        title = file_path.stem

    # Slice from <div class="chatlog"> onward to only parse messages, not the header
    chat_start = raw.find('<div class="chatlog">')
    if chat_start < 0:
        chat_start = raw.find('<div class=chatlog>')
    chat_fragment = raw[chat_start:] if chat_start >= 0 else raw

    splitter = MessageContainerSplitter()
    splitter.feed(chat_fragment)

    messages = []
    for mid, frag in splitter.results:
        msg = parse_message_container(mid, frag)
        if msg is not None:
            messages.append(msg)

    # Derive sort key from first message id (Discord snowflake id increases with time)
    first_id = int(messages[0]["id"]) if messages else 0
    last_id = int(messages[-1]["id"]) if messages else 0

    return {
        "guild": guild,
        "forum": forum,
        "title": title,
        "first_msg_id": first_id,
        "last_msg_id": last_id,
        "messages": messages,
    }


def main() -> int:
    if not SOURCE.exists():
        print(f"source dir not found: {SOURCE}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    CONTENT_OUT.mkdir(parents=True, exist_ok=True)

    # clear old per-thread content files
    for f in CONTENT_OUT.glob("*.json"):
        f.unlink()

    threads: list[dict] = []
    users: dict[str, dict] = {}
    flat_messages: list[dict] = []

    # Layout: MeshCore/<forum>/<thread>.html — MeshCore is the guild.
    # When a top-level <name>.html has a sibling <name>/ folder, the HTML is
    # the channel's main chat and the folder's files are its sub-threads.
    guild_dir = SOURCE

    def emit(f: Path, forum_name: str, channel: str | None, is_channel_main: bool):
        data = parse_thread(f, forum_name, channel_hint=channel if not is_channel_main else None)
        slug = f"{slugify(data['forum'])}--{slugify(data['title'])}"
        if channel and not is_channel_main:
            slug = f"{slugify(data['forum'])}--{slugify(channel)}--{slugify(data['title'])}"
        base = slug
        n = 1
        while any(t["id"] == slug for t in threads):
            n += 1
            slug = f"{base}-{n}"

        thread_entry = {
            "id": slug,
            "title": data["title"],
            "forum": data["forum"],
            "channel": channel,
            "is_channel_main": is_channel_main,
            "guild": data["guild"] or guild_dir.name,
            "guild_folder": guild_dir.name,
            "message_count": len(data["messages"]),
            "first_msg_id": data["first_msg_id"],
            "last_msg_id": data["last_msg_id"],
            "source_file": str(f.relative_to(ROOT)),
        }
        threads.append(thread_entry)

        per_thread = {
            "id": slug,
            "title": data["title"],
            "forum": data["forum"],
            "messages": data["messages"],
        }
        (CONTENT_OUT / f"{slug}.json").write_text(
            json.dumps(per_thread, ensure_ascii=False),
            encoding="utf-8",
        )

        for m in data["messages"]:
            flat_messages.append(
                {
                    "id": m["id"],
                    "thread": slug,
                    "author": m["author"],
                    "author_handle": m["author_handle"],
                    "user_id": m["user_id"],
                    "timestamp": m["timestamp"],
                    "timestamp_short": m["timestamp_short"],
                    "text": m["text"],
                }
            )

            uid = m["user_id"]
            if uid and uid not in users:
                users[uid] = {
                    "id": uid,
                    "name": m["author"],
                    "handle": m["author_handle"],
                    "avatar": m["avatar"],
                    "message_count": 0,
                }
            if uid:
                users[uid]["message_count"] += 1

    for forum_dir in sorted(p for p in guild_dir.iterdir() if p.is_dir()):
        subfolder_stems = {p.name for p in forum_dir.iterdir() if p.is_dir()}
        for f in sorted(forum_dir.glob("*.html")):
            is_main = f.stem in subfolder_stems
            emit(f, forum_dir.name, f.stem if is_main else None, is_main)

        for sub in sorted(p for p in forum_dir.iterdir() if p.is_dir() and p.name in subfolder_stems):
            for f in sorted(sub.glob("*.html")):
                emit(f, forum_dir.name, sub.name, is_channel_main=False)

    # Order threads chronologically by first message
    threads.sort(key=lambda t: (t["forum"], t["first_msg_id"]))

    (OUT / "threads.json").write_text(
        json.dumps(threads, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT / "users.json").write_text(
        json.dumps(
            sorted(users.values(), key=lambda u: -u["message_count"]),
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (OUT / "messages.json").write_text(
        json.dumps(flat_messages, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"threads: {len(threads)}")
    print(f"users:   {len(users)}")
    print(f"msgs:    {len(flat_messages)}")
    print(f"wrote:   {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
