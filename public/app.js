// Minimal chat client: posts a message, reads the SSE reply, renders markdown
// with clickable [n] citations and a source list under each answer.

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = document.querySelector("#composer button");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const EMPTY = `<p class="empty">Ask anything. I can search the web, and I remember our past conversations by date.</p>`;

let conversationId = null;
let busy = false;

const formatTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

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

  const list = el.querySelector(".sources");
  list.replaceChildren(
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

async function loadConversations() {
  const list = await (await fetch("/api/conversations")).json();
  $("conversations").replaceChildren(
    ...list.map((c) => {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = c.title;
      a.className = c.id === conversationId ? "active" : "";
      const when = document.createElement("small");
      when.textContent = formatTime(c.created_at);
      a.append(when);
      a.onclick = (e) => { e.preventDefault(); openConversation(c.id); };
      return a;
    }),
  );
}

async function openConversation(id) {
  if (busy) return;
  conversationId = id;
  messagesEl.replaceChildren();
  const rows = await (await fetch(`/api/conversations/${id}/messages`)).json();
  for (const m of rows) addMessage(m.role, m.content, m.created_at, m.sources);
  loadConversations();
}

function newChat() {
  if (busy) return;
  conversationId = null;
  messagesEl.innerHTML = EMPTY;
  loadConversations();
  inputEl.focus();
}

async function send(text) {
  busy = true;
  sendBtn.disabled = true;
  addMessage("user", text, new Date().toISOString());
  const el = addMessage("assistant", "");
  const body = el.querySelector(".body");
  const showStatus = (s) => { body.innerHTML = `<span class="status"></span>`; body.firstChild.textContent = s; };
  showStatus("Thinking…");

  let answer = "";
  let status = "Thinking…";
  let sources = [];
  let renderQueued = false;
  const render = () => {
    renderQueued = false;
    if (answer) renderAnswer(el, answer, sources);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  const queueRender = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } }; // at most one render per frame

  const handle = (event, data) => {
    if (event === "status") { status = data.text; if (!answer) showStatus(status); }
    if (event === "sources") { sources = data.sources; queueRender(); }
    if (event === "delta") { answer += data.text; queueRender(); }
    if (event === "reset") { answer = ""; showStatus(status); }
    if (event === "done") {
      conversationId = data.conversationId;
      const t = data.timings;
      const search = t.searches ? ` · ${t.searches} search${t.searches > 1 ? "es" : ""}` : "";
      el.querySelector(".time").textContent = `${formatTime(new Date().toISOString())} · first token ${t.ttftMs ?? "–"} ms · total ${t.totalMs} ms${search}`;
    }
    if (event === "error") {
      conversationId = data.conversationId;
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

loadConversations();
