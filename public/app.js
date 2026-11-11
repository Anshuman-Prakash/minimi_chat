// Chat client: posts a message, reads the SSE reply, renders markdown with
// clickable [n] citations, a source list, and status badges in then/now tables.

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = document.querySelector("#composer button");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const SUGGESTIONS = [
  ["Check a past answer", "What did I ask you on 3 November? Is your answer still correct today?"],
  ["What changed since", "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"],
  ["Search the web", "What's the latest stable release of Node.js, and when did it come out?"],
  ["Test my memory", "What did I ask you on 1 January?"],
];

let conversationId = null;
let busy = false;

const formatTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const scrollDown = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };

function showEmpty() {
  messagesEl.innerHTML = `
    <div class="empty">
      <h1>Ask now. Ask again <em>later</em>.</h1>
      <p>I search the web when a question needs it, and I remember what we discussed and when, so you can ask whether it is still true.</p>
      <div class="suggestions"></div>
    </div>`;
  messagesEl.querySelector(".suggestions").append(
    ...SUGGESTIONS.map(([label, text]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = "<b></b>";
      b.firstChild.textContent = label;
      b.append(text);
      b.onclick = () => { if (!busy) send(text); };
      return b;
    }),
  );
}

/** Renders an assistant answer: sanitized markdown, [n] turned into links, cited sources listed below. */
function renderAnswer(el, text, sources) {
  const body = el.querySelector(".body");
  body.innerHTML = DOMPurify.sanitize(marked.parse(text));

  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const cited = new Map();
  // Only touch text nodes outside code and links, so nothing else in the HTML is rewritten.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest("code, pre, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    if (!/\[\d/.test(node.data)) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.data.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      frag.append(node.data.slice(last, m.index));
      for (const n of m[1].split(",").map(Number)) {
        const s = byNumber.get(n);
        if (!s) { frag.append(`[${n}]`); continue; } // unknown number: leave as plain text
        cited.set(n, s);
        const a = document.createElement("a");
        a.className = "cite";
        a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.title = `${s.title}${s.publishedDate ? ` (${s.publishedDate})` : ""}`;
        a.textContent = n;
        frag.append(a);
      }
      last = m.index + m[0].length;
    }
    frag.append(node.data.slice(last));
    node.replaceWith(frag);
  }

  // In a then-vs-now table, turn the status words into coloured badges.
  for (const td of body.querySelectorAll("td")) {
    const word = td.textContent.trim().toLowerCase().replace(/[’`]/g, "'");
    const kind = word === "changed" ? "changed" : word === "unchanged" ? "unchanged" : word === "couldn't verify" ? "unverified" : null;
    if (!kind) continue;
    const badge = document.createElement("span");
    badge.className = `badge ${kind}`;
    badge.textContent = td.textContent.trim();
    td.replaceChildren(badge);
  }

  el.querySelector(".sources").replaceChildren(
    ...[...cited.values()].sort((a, b) => a.n - b.n).map((s) => {
      const a = document.createElement("a");
      a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.title = s.title;
      a.textContent = `${s.n} · ${hostOf(s.url)}${s.publishedDate ? ` · ${s.publishedDate}` : ""}`;
      return a;
    }),
  );
}

function addMessage(role, text, createdAt, sources = []) {
  messagesEl.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="body"></div><div class="sources"></div><div class="time"></div>`;
  if (role === "user") el.querySelector(".body").textContent = text;
  else renderAnswer(el, text, sources);
  if (createdAt) el.querySelector(".time").textContent = formatTime(createdAt);
  messagesEl.append(el);
  scrollDown();
  return el;
}

async function loadConversations() {
  const list = await (await fetch("/api/conversations")).json();
  const nav = $("conversations");
  if (!list.length) { nav.innerHTML = `<div class="none">Nothing yet. Your chats will be listed here.</div>`; return; }
  nav.replaceChildren(
    ...list.map((c) => {
      const a = document.createElement("a");
      a.href = "#";
      a.className = c.id === conversationId ? "active" : "";
      a.innerHTML = `<span class="title"></span><small></small>`;
      a.firstChild.textContent = c.title;
      a.lastChild.textContent = formatTime(c.created_at);
      a.onclick = (e) => { e.preventDefault(); openConversation(c.id); };
      return a;
    }),
  );
}

async function openConversation(id) {
  if (busy) return;
  document.body.classList.remove("menu-open");
  const res = await fetch(`/api/conversations/${id}/messages`);
  if (!res.ok) return newChat(); // e.g. a stale link to a conversation that no longer exists
  setConversation(id);
  messagesEl.replaceChildren();
  for (const m of await res.json()) addMessage(m.role, m.content, m.created_at, m.sources);
  loadConversations();
}

/** The open conversation is kept in the address bar, so a reload returns to it. */
function setConversation(id) {
  conversationId = id;
  history.replaceState(null, "", id ? `#c${id}` : location.pathname);
}

function newChat() {
  if (busy) return;
  document.body.classList.remove("menu-open");
  setConversation(null);
  showEmpty();
  loadConversations();
  inputEl.focus();
}

async function send(text) {
  busy = true;
  sendBtn.disabled = true;
  addMessage("user", text, new Date().toISOString());
  const el = addMessage("assistant", "");
  el.classList.add("working");
  const body = el.querySelector(".body");
  const showStatus = (s) => {
    body.innerHTML = `<span class="status"><i class="dot"></i><span></span></span>`;
    body.querySelector(".status span").textContent = s;
    scrollDown();
  };
  showStatus("Thinking…");

  let answer = "";
  let status = "Thinking…";
  let sources = [];
  let renderQueued = false;
  const render = () => {
    renderQueued = false;
    if (answer) renderAnswer(el, answer, sources);
    scrollDown();
  };
  const queueRender = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } }; // at most one render per frame

  const handle = (event, data) => {
    if (event === "status") { status = data.text; if (!answer) showStatus(status); }
    if (event === "sources") { sources = data.sources; queueRender(); }
    if (event === "delta") { answer += data.text; queueRender(); }
    if (event === "reset") { answer = ""; showStatus(status); }
    if (event === "done") {
      setConversation(data.conversationId);
      const t = data.timings;
      const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
      const parts = [formatTime(new Date().toISOString())];
      if (t.recalled) parts.push(`${t.recalled} past exchange${t.recalled > 1 ? "s" : ""} recalled`);
      if (t.searches) parts.push(`${t.searches} search${t.searches > 1 ? "es" : ""}`);
      if (t.ttftMs != null) parts.push(`first word ${seconds(t.ttftMs)}`);
      parts.push(`total ${seconds(t.totalMs)}`);
      el.querySelector(".time").textContent = parts.join(" · ");
    }
    if (event === "error") {
      setConversation(data.conversationId);
      answer = "";
      body.innerHTML = `<span class="error"></span>`;
      body.firstChild.textContent = data.message;
    }
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, tz, ...(conversationId ? { conversationId } : {}) }),
    });
    if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

    // SSE frames are separated by a blank line: "event: x\ndata: {json}\n\n".
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data) handle(event, JSON.parse(data));
      }
    }
  } catch (err) {
    handle("error", { message: `Connection problem: ${err.message}`, conversationId });
  } finally {
    el.classList.remove("working");
    busy = false;
    sendBtn.disabled = false;
    loadConversations();
    inputEl.focus();
  }
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  send(text);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${inputEl.scrollHeight}px`;
});
$("new-chat").addEventListener("click", newChat);
$("menu").addEventListener("click", () => document.body.classList.toggle("menu-open"));
messagesEl.addEventListener("click", () => document.body.classList.remove("menu-open"));

const linked = Number(/^#c(\d+)$/.exec(location.hash)?.[1]);
if (linked) openConversation(linked);
else { showEmpty(); loadConversations(); }
