/* Rundown discovery concept — vanilla JS, no network, localStorage only. */
(function () {
  "use strict";

  const STORIES = window.RUNDOWN_STORIES;
  const KEY = "rundown.discovery.concept.v1";
  const TOPICS = ["film", "design", "tech", "sport"];
  const SOURCES = ["article", "youtube", "tiktok", "reddit"];
  const LABEL = { film: "Film", design: "Design", tech: "Tech", sport: "Sport", article: "Article", youtube: "YouTube", tiktok: "TikTok", reddit: "Reddit" };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- state ----------
  const defaults = () => ({
    mode: "focus", topic: "all", saved: [], notes: {}, signals: [], rankedIds: null
  });
  let state = load();
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      return Object.assign(defaults(), JSON.parse(raw));
    } catch (e) { return defaults(); }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ }
  }

  // ---------- ranking (deterministic, local) ----------
  function weights() {
    const w = { topic: {}, source: {} };
    TOPICS.forEach(t => (w.topic[t] = 0));
    SOURCES.forEach(s => (w.source[s] = 0));
    state.signals.forEach(sig => {
      const d = sig.type === "more" ? 1 : -1;
      w.topic[sig.topic] += d;
      w.source[sig.source] += d * 0.5;
    });
    state.saved.forEach(id => {
      const s = byId(id); if (s) w.topic[s.topic] += 0.5;
    });
    return w;
  }
  function score(story, w) { return w.topic[story.topic] + w.source[story.source]; }
  function rank() {
    const w = weights();
    const ordered = STORIES.map((s, i) => ({ s, i, sc: score(s, w) }))
      .sort((a, b) => (b.sc - a.sc) || (a.i - b.i))
      .map(x => x.s.id);
    state.rankedIds = ordered;
    persist();
    return ordered;
  }
  function visibleStories() {
    const ids = state.rankedIds && state.rankedIds.length === STORIES.length ? state.rankedIds : rank();
    return ids.map(byId).filter(s => s && (state.topic === "all" || s.topic === state.topic));
  }
  function pendingReorder() {
    // true when the persisted ranking differs from what current weights would produce
    const w = weights();
    const fresh = STORIES.map((s, i) => ({ s, i, sc: score(s, w) })).sort((a, b) => (b.sc - a.sc) || (a.i - b.i)).map(x => x.s.id);
    return JSON.stringify(fresh) !== JSON.stringify(state.rankedIds);
  }
  function byId(id) { return STORIES.find(s => s.id === id); }

  // ---------- svg art ----------
  const PALETTES = [
    { bg: "#e9e1cf", a: "#1b3fd4", b: "#16140f", c: "#f5f1e8" },
    { bg: "#16140f", a: "#f5f1e8", b: "#c9f24d", c: "#1b3fd4" },
    { bg: "#d9cbb3", a: "#b8432f", b: "#16140f", c: "#f5f1e8" },
    { bg: "#1b3fd4", a: "#f5f1e8", b: "#c9f24d", c: "#16140f" },
    { bg: "#f0ebdf", a: "#16140f", b: "#b8432f", c: "#1b3fd4" },
    { bg: "#2b2a25", a: "#e9e1cf", b: "#c9f24d", c: "#b8432f" }
  ];
  let artSeq = 0;
  function art(story, w, h) {
    const p = PALETTES[story.art.palette % PALETTES.length];
    const id = "g" + (artSeq++);
    const W = w || 400, H = h || 300;
    let shapes = "";
    switch (story.art.kind) {
      case "arc":
        shapes = `<path d="M-20 ${H*0.95} A ${W*0.62} ${W*0.62} 0 0 1 ${W*1.1} ${H*0.95} Z" fill="${p.a}"/>
          <circle cx="${W*0.72}" cy="${H*0.3}" r="${H*0.14}" fill="${p.b}"/>
          <line x1="${W*0.08}" y1="${H*0.22}" x2="${W*0.5}" y2="${H*0.22}" stroke="${p.b}" stroke-width="2"/>
          <line x1="${W*0.08}" y1="${H*0.3}" x2="${W*0.42}" y2="${H*0.3}" stroke="${p.b}" stroke-width="2"/>
          <circle cx="${W*0.28}" cy="${H*0.62}" r="${H*0.06}" fill="${p.c}"/>`;
        break;
      case "grid": {
        let g = "";
        for (let i = 1; i < 8; i++) g += `<line x1="${W*i/8}" y1="0" x2="${W*i/8}" y2="${H}" stroke="${p.a}" stroke-opacity=".35" stroke-width="1"/>`;
        for (let j = 1; j < 6; j++) g += `<line x1="0" y1="${H*j/6}" x2="${W}" y2="${H*j/6}" stroke="${p.a}" stroke-opacity=".35" stroke-width="1"/>`;
        shapes = g + `<rect x="${W/8}" y="${H/6}" width="${W/4}" height="${H/3}" fill="${p.a}"/>
          <rect x="${W*5/8}" y="${H*3/6}" width="${W/8}" height="${H/3}" fill="${p.b}"/>
          <rect x="${W*4/8}" y="${H*1/6}" width="${W/8}" height="${H/6}" fill="${p.c}"/>
          <circle cx="${W*6/8}" cy="${H*2/6}" r="${H/12}" fill="${p.a}"/>`;
        break;
      }
      case "orbit":
        shapes = `<circle cx="${W*0.5}" cy="${H*0.55}" r="${H*0.42}" fill="none" stroke="${p.a}" stroke-width="2"/>
          <circle cx="${W*0.5}" cy="${H*0.55}" r="${H*0.28}" fill="none" stroke="${p.a}" stroke-width="2" stroke-dasharray="6 8"/>
          <circle cx="${W*0.5}" cy="${H*0.55}" r="${H*0.12}" fill="${p.b}"/>
          <circle cx="${W*0.5 + H*0.42*0.71}" cy="${H*0.55 - H*0.42*0.71}" r="${H*0.05}" fill="${p.c}"/>
          <circle cx="${W*0.5 - H*0.28}" cy="${H*0.55}" r="${H*0.035}" fill="${p.a}"/>`;
        break;
      case "stripes": {
        let s = "";
        for (let i = -4; i < 14; i++) s += `<line x1="${W*i/10}" y1="${H}" x2="${W*i/10 + H*0.6}" y2="0" stroke="${p.a}" stroke-opacity=".5" stroke-width="3"/>`;
        shapes = s + `<rect x="${W*0.18}" y="${H*0.22}" width="${W*0.36}" height="${H*0.56}" fill="${p.b}"/>
          <rect x="${W*0.6}" y="${H*0.5}" width="${W*0.22}" height="${H*0.28}" fill="${p.c}"/>`;
        break;
      }
      case "blob":
        shapes = `<path d="M${W*0.2} ${H*0.5} C ${W*0.15} ${H*0.15}, ${W*0.6} ${H*0.05}, ${W*0.75} ${H*0.3} C ${W*0.92} ${H*0.55}, ${W*0.75} ${H*0.95}, ${W*0.45} ${H*0.9} C ${W*0.22} ${H*0.86}, ${W*0.24} ${H*0.75}, ${W*0.2} ${H*0.5} Z" fill="${p.a}"/>
          <rect x="${W*0.55}" y="${H*0.55}" width="${W*0.32}" height="${H*0.32}" fill="${p.b}"/>
          <circle cx="${W*0.3}" cy="${H*0.32}" r="${H*0.07}" fill="${p.c}"/>`;
        break;
      default: // diagonal
        shapes = `<polygon points="0,${H} ${W},0 ${W},${H}" fill="${p.a}"/>
          <circle cx="${W*0.3}" cy="${H*0.32}" r="${H*0.2}" fill="${p.b}"/>
          <rect x="${W*0.62}" y="${H*0.58}" width="${W*0.2}" height="${W*0.2}" fill="${p.c}" transform="rotate(12 ${W*0.72} ${H*0.68})"/>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustration">
      <defs><filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .07 0"/></filter></defs>
      <rect width="${W}" height="${H}" fill="${p.bg}"/>${shapes}
      <rect width="${W}" height="${H}" filter="url(#${id})"/>
    </svg>`;
  }
  const ICON = {
    book: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4z"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>',
    bookmark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 2.5h9v11l-4.5-3-4.5 3z"/></svg>',
    bookmarkFill: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2.5h9v11l-4.5-3-4.5 3z"/></svg>',
    pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2-8 8H3.5v-2z"/></svg>',
    up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
    down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
    minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h10"/></svg>',
    x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11l6-6M6 5h5v5"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3"/></svg>',
    tune: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6"/><circle cx="10.5" cy="4.5" r="1.8"/><circle cx="5.5" cy="11.5" r="1.8"/></svg>',
    left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>',
    right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>'
  };

  // ---------- rendering helpers ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function metaLine(s) {
    const m = s.meta;
    if (s.source === "article") return `${m.outlet} · ${m.minutes} min read`;
    if (s.source === "youtube") return `${m.channel} · ${m.duration}`;
    if (s.source === "tiktok") return `${m.creator} · ${m.duration}`;
    return `${m.sub} · ${m.upvotes} upvotes`;
  }
  function kicker(s) {
    return `<div class="kicker"><span class="src">${LABEL[s.source]}</span><span class="dot"></span><span>${LABEL[s.topic]}</span><span class="dot"></span><span>${esc(metaLine(s))}</span></div>`;
  }
  function figure(s, opts) {
    const vertical = s.source === "tiktok";
    let tag = "";
    if (s.source === "youtube") tag = `<figcaption class="media-tag">${ICON.play}<span>Sample frame · ${esc(s.meta.duration)} · no playback</span></figcaption>`;
    if (s.source === "tiktok") tag = `<figcaption class="media-tag">${ICON.play}<span>Sample clip · ${esc(s.meta.duration)} · no playback</span></figcaption>`;
    if (s.source === "article") tag = `<figcaption class="media-tag"><span>${s.meta.minutes} min · sample story</span></figcaption>`;
    if (s.source === "reddit") tag = `<figcaption class="media-tag"><span>${esc(s.meta.sub)} · sample thread</span></figcaption>`;
    if (vertical) {
      return `<figure class="art vertical">${art(s, 400, 300)}<div class="phone">${art(s, 180, 320)}</div>${tag}</figure>`;
    }
    return `<figure class="art">${art(s, 400, 300)}${tag}</figure>`;
  }
  function thread(s) {
    if (s.source !== "reddit") return "";
    return `<div class="thread"><span class="up">${ICON.up}<b>${esc(s.meta.upvotes)}</b></span><span>${esc(s.meta.comments)} comments</span><span>posted by <b>${esc(s.meta.op)}</b></span></div>`;
  }
  function actions(s, brief) {
    const saved = state.saved.includes(s.id);
    const hasNote = !!(state.notes[s.id] && state.notes[s.id].trim());
    return `<div class="actions">
      ${brief ? `<button class="act read" data-act="read" aria-label="Read more">${ICON.book}<span>Read more</span></button>` : ""}
      <button class="act save" data-act="save" aria-pressed="${saved}" aria-label="${saved ? "Unsave" : "Save"} story">${saved ? ICON.bookmarkFill : ICON.bookmark}<span>${saved ? "Saved" : "Save"}</span></button>
      <button class="act note" data-act="note" aria-expanded="${hasNote}" aria-label="Add a note">${ICON.pen}<span>Note</span></button>
      <button class="act more" data-act="more" aria-label="More like this">${ICON.plus}<span>More<span class="txt-long"> like this</span></span></button>
      <button class="act less" data-act="less" aria-label="Less like this">${ICON.minus}<span>Less</span></button>
      <button class="act open" data-act="open" aria-label="Open source">${ICON.arrow}<span>Open source</span></button>
    </div>
    <div class="note-wrap" ${hasNote ? "" : "hidden"}>
      <textarea rows="2" placeholder="A line for future you…" aria-label="Your note">${esc(state.notes[s.id] || "")}</textarea>
      <span class="note-status">${hasNote ? "Saved on this device" : ""}</span>
    </div>`;
  }
  function body(s, brief) {
    if (brief) {
      return `<div class="card-body">
        ${kicker(s)}
        <h2 class="title">${esc(s.title)}</h2>
        <p class="dek">${esc(s.dek)}</p>
        <ul class="takeaways one"><li>${esc(s.takeaways[0])}</li></ul>
        ${actions(s, true)}
      </div>`;
    }
    return `<div class="card-body">
      ${kicker(s)}
      <h2 class="title">${esc(s.title)}</h2>
      <p class="dek">${esc(s.dek)}</p>
      ${thread(s)}
      <div class="section-label small">The rundown</div>
      <ul class="takeaways">${s.takeaways.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
      <p class="para">${esc(s.body[0])}</p>
      <p class="para second">${esc(s.body[1])}</p>
      ${actions(s, false)}
    </div>`;
  }

  // ---------- DOM refs ----------
  const $ = sel => document.querySelector(sel);
  const stage = $("#stage");
  const chipsEl = $("#chips");
  const progress = $("#progress");
  const tray = $("#tray");
  const reader = $("#reader");
  const scrim = $("#scrim");
  const tune = $("#tune");
  const toastEl = $("#toast");
  const savedBtn = $("#savedBtn");
  const tuneBtn = $("#tuneBtn");
  let current = 0;            // index into visibleStories() for focus mode / explore keyboard
  let readerId = null;
  let observer = null;
  let toastTimer = null;
  let lastFocus = null;

  // ---------- render ----------
  function renderChips() {
    const items = [["all", "All"], ...TOPICS.map(t => [t, LABEL[t]])];
    chipsEl.innerHTML = items.map(([v, l]) => `<button class="chip" data-topic="${v}" aria-pressed="${state.topic === v}">${l}</button>`).join("")
      + `<span class="spacer"></span><button class="chip ghost" id="refreshBtn" title="Re-rank with your signals">${ICON.refresh}Refresh feed${pendingReorder() ? ' <span class="pending">· new order ready</span>' : ""}</button>`;
    tuneBtn.classList.toggle("pending", pendingReorder());
  }
  function renderModes() {
    document.querySelectorAll(".modes button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === state.mode)));
    stage.dataset.mode = state.mode;
    progress.hidden = state.mode !== "focus";
  }
  function renderStage() {
    if (observer) observer.disconnect();
    const list = visibleStories();
    if (state.mode === "focus") {
      stage.innerHTML = `<div class="feed">${list.map(s => `<article class="card" data-id="${s.id}" tabindex="-1">
        <div class="card-inner">${figure(s)}${body(s, true)}</div></article>`).join("")}</div>`;
      renderProgress(list.length);
      observer = new IntersectionObserver(entries => {
        entries.forEach(en => {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            const idx = [...stage.querySelectorAll(".card")].indexOf(en.target);
            if (idx >= 0 && en.intersectionRatio >= 0.5) { current = idx; markProgress(); }
          }
        });
      }, { root: stage, threshold: [0.5] });
      stage.querySelectorAll(".card").forEach(c => observer.observe(c));
    } else {
      stage.innerHTML = `<div class="grid">
        <div class="section-label">${state.topic === "all" ? "Today's rundown" : LABEL[state.topic]} · ${list.length} stories</div>
        ${list.map((s, i) => `<article class="tile${i === 0 ? " lead" : ""}" data-id="${s.id}" tabindex="0" role="button" aria-label="Open: ${esc(s.title)}">
          ${figure(s)}
          <div class="tile-side">${kicker(s)}<h3 class="title">${esc(s.title)}</h3><p class="dek">${esc(s.dek)}</p>
          <div class="tile-foot"><button class="mini" data-act="save" aria-pressed="${state.saved.includes(s.id)}" aria-label="${state.saved.includes(s.id) ? "Unsave" : "Save"} story">${state.saved.includes(s.id) ? ICON.bookmarkFill : ICON.bookmark}<span>${state.saved.includes(s.id) ? "Saved" : "Save"}</span></button>
          ${state.notes[s.id] && state.notes[s.id].trim() ? '<span class="notemark">Has note</span>' : ""}</div></div>
        </article>`).join("")}
      </div>`;
      observer = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) en.target.classList.add("in"); }), { root: stage, threshold: 0.08 });
      stage.querySelectorAll(".tile").forEach(t => observer.observe(t));
    }
    stage.scrollTop = 0;
    current = 0; markProgress();
  }
  function renderProgress(n) {
    progress.innerHTML = `<span class="n">${n} stories</span>` + Array.from({ length: n }, (_, i) => `<i data-i="${i}"></i>`).join("");
  }
  function markProgress() {
    progress.querySelectorAll("i").forEach((el, i) => el.classList.toggle("on", i === current));
    if (state.mode === "focus") {
      const cards = stage.querySelectorAll(".card");
      const n = progress.querySelector(".n"); if (n) n.textContent = `${current + 1} / ${cards.length}`;
    }
  }
  function renderSavedBadge() {
    savedBtn.querySelector(".count").textContent = state.saved.length;
  }
  function renderTray() {
    const listEl = tray.querySelector(".panel-body");
    if (!state.saved.length) {
      listEl.innerHTML = `<div class="tray-empty"><b>Nothing saved yet</b>Tap Save on any story. Notes ride along.</div>`;
      return;
    }
    listEl.innerHTML = `<div class="tray-list">${state.saved.map((id, i) => {
      const s = byId(id); if (!s) return "";
      const note = (state.notes[id] || "").trim();
      return `<div class="tray-item" data-id="${id}">
        <figure class="art">${art(s, 120, 120)}</figure>
        <button class="open-link" data-act="jump" aria-label="Open ${esc(s.title)}"><div class="k">${LABEL[s.source]} · ${LABEL[s.topic]}</div><div class="t">${esc(s.title)}</div>${note ? `<div class="note-preview">${esc(note)}</div>` : ""}</button>
        <div class="ctl">
          <button data-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>${ICON.up}</button>
          <button data-act="down" aria-label="Move down" ${i === state.saved.length - 1 ? "disabled" : ""}>${ICON.down}</button>
          <button data-act="remove" aria-label="Remove from saved">${ICON.x}</button>
        </div></div>`;
    }).join("")}</div>`;
  }
  function renderTune() {
    const w = weights();
    const row = (k, v) => {
      const cls = v > 0 ? "pos" : v < 0 ? "neg" : "";
      const pct = Math.min(50, Math.abs(v) * 12.5);
      return `<div class="row"><span>${LABEL[k]}</span><span class="bar"><i class="${v < 0 ? "neg" : ""}" style="width:${pct}%"></i></span><span class="w ${cls}">${v > 0 ? "+" : ""}${v.toFixed(1)}</span></div>`;
    };
    const saves = state.saved.length, sigs = state.signals.length;
    tune.innerHTML = `<h4>Your feed, tuned locally</h4>
      <div class="hint">Order = base order + these weights. More/Less counts ±1 on a topic and ±0.5 on a source. Each save adds +0.5 to its topic. Nothing leaves this browser.</div>
      <div class="rows"><div class="group">Topics</div>${TOPICS.map(t => row(t, w.topic[t])).join("")}
      <div class="group">Sources</div>${SOURCES.map(s => row(s, w.source[s])).join("")}</div>
      <div class="hint">${sigs} signal${sigs === 1 ? "" : "s"} · ${saves} save${saves === 1 ? "" : "s"}${pendingReorder() ? " · <b>new order ready on refresh</b>" : ""}</div>
      <div class="btns"><button class="act primary" data-act="refresh">${ICON.refresh}Refresh feed</button><button class="act" data-act="undo" ${sigs ? "" : "disabled"}>Undo last</button><button class="act" data-act="reset" ${sigs ? "" : "disabled"}>Reset</button></div>`;
  }
  function renderAll() { renderChips(); renderModes(); renderStage(); renderSavedBadge(); renderTray(); renderTune(); }

  // ---------- toast ----------
  function toast(html, action) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span class="msg">${html}</span>${action ? `<button data-act="toast-action">${action.label}</button>` : ""}<button class="quiet" data-act="toast-close" aria-label="Dismiss">Close</button>`;
    toastEl._action = action ? action.fn : null;
    toastEl.classList.add("on");
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), action ? 6000 : 3200);
  }
  toastEl.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.act === "toast-action" && toastEl._action) toastEl._action();
    toastEl.classList.remove("on");
  });

  // ---------- actions ----------
  function toggleSave(id) {
    const on = state.saved.includes(id);
    state.saved = on ? state.saved.filter(x => x !== id) : [...state.saved, id];
    persist();
    // update every visible control for this story in place; the card does not move
    document.querySelectorAll(`[data-id="${id}"] [data-act="save"]`).forEach(b => {
      b.setAttribute("aria-pressed", String(!on));
      b.setAttribute("aria-label", (!on ? "Unsave" : "Save") + " story");
      b.innerHTML = (!on ? ICON.bookmarkFill : ICON.bookmark) + `<span>${!on ? "Saved" : "Save"}</span>`;
    });
    renderSavedBadge(); renderTray(); renderTune(); renderChips();
    toast(on ? "Removed from saved" : `Saved · <b>${LABEL[byId(id).topic]}</b> gets a small boost on refresh`);
  }
  function toggleNote(root) {
    const wrap = root.querySelector(".note-wrap");
    const btn = root.querySelector('[data-act="note"]');
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) wrap.querySelector("textarea").focus();
  }
  const noteTimers = {};
  function noteInput(id, ta, statusEl) {
    statusEl.textContent = "Saving…"; statusEl.classList.remove("ok");
    clearTimeout(noteTimers[id]);
    noteTimers[id] = setTimeout(() => {
      const v = ta.value;
      if (v.trim()) state.notes[id] = v; else delete state.notes[id];
      persist();
      statusEl.textContent = v.trim() ? "Saved on this device" : "";
      statusEl.classList.add("ok");
      renderTray();
    }, 180);
  }
  function signal(type, id, btn) {
    const s = byId(id);
    state.signals.push({ type, topic: s.topic, source: s.source });
    persist();
    btn.classList.add("flash"); setTimeout(() => btn.classList.remove("flash"), 900);
    renderTune(); renderChips();
    toast(`${type === "more" ? "More" : "Less"} <b>${LABEL[s.topic]}</b> · ${LABEL[s.source]} — reorders on refresh`, { label: "Undo", fn: undo });
  }
  function undo() {
    if (!state.signals.length) return;
    state.signals.pop(); persist(); renderTune(); renderChips();
    toast("Signal undone");
  }
  function reset() {
    state.signals = []; persist(); renderTune(); renderChips();
    toast("Signals reset · saves still count", { label: "Refresh now", fn: refresh });
  }
  function refresh() {
    closePanels();
    rank(); renderChips(); renderTune(); renderStage();
    toast("Feed refreshed with your signals");
  }
  function openSource(id) {
    const s = byId(id);
    toast(`Sample story · would open <b>${esc(s.meta.url)}</b> · nothing here calls the network`);
  }
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode; persist();
    closePanels(); renderModes(); renderStage();
  }
  function setTopic(t) {
    if (state.topic === t) return;
    state.topic = t; rank(); persist(); renderChips(); renderStage(); renderTune();
  }

  // ---------- navigation ----------
  function goTo(idx) {
    const list = visibleStories();
    if (!list.length) return;
    idx = Math.max(0, Math.min(list.length - 1, idx));
    if (reader.classList.contains("on")) { openReader(list[idx].id); return; }
    if (state.mode === "focus") {
      const cards = stage.querySelectorAll(".card");
      cards[idx].scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
      current = idx; markProgress();
    } else {
      const tiles = stage.querySelectorAll(".tile");
      tiles.forEach(t => t.classList.remove("active"));
      tiles[idx].classList.add("active");
      tiles[idx].focus({ preventScroll: true });
      tiles[idx].scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "nearest" });
      current = idx;
    }
  }
  function isTyping(el) {
    return el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
  }
  document.addEventListener("keydown", e => {
    if (e.key === "Tab" && openDialog) {
      const f = focusables(openDialog); if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (e.key === "Escape") { if (isTyping(e.target) && !openDialog) { e.target.blur(); return; } closePanels(); return; }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const next = e.key === "ArrowDown" || e.key === "j" || (e.key === "ArrowRight" && state.mode !== "focus");
    const prev = e.key === "ArrowUp" || e.key === "k" || (e.key === "ArrowLeft" && state.mode !== "focus");
    if (next || prev) { e.preventDefault(); goTo(current + (next ? 1 : -1)); return; }
    if (e.key === "Enter" && state.mode === "explore" && e.target.classList && e.target.classList.contains("tile")) { e.preventDefault(); openReader(e.target.dataset.id); }
  });

  // ---------- panels (modal: background inert + focus trap) ----------
  const REGIONS = () => [document.querySelector(".top"), chipsEl, stage, progress, tray, reader, tune];
  let openDialog = null;
  function setModal(active) {
    openDialog = active;
    REGIONS().forEach(el => { if (el !== active) { if (active) el.setAttribute("inert", ""); else el.removeAttribute("inert"); } });
  }
  function focusables(root) {
    return [...root.querySelectorAll('button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
  }
  function openPanel(p) {
    lastFocus = document.activeElement;
    scrim.classList.add("on"); p.classList.add("on"); p.removeAttribute("aria-hidden");
    setModal(p);
    const first = p.querySelector("button"); if (first) first.focus();
  }
  function closePanels() {
    let was = false;
    const wasReader = reader.classList.contains("on");
    [tray, reader].forEach(p => { if (p.classList.contains("on")) { was = true; p.classList.remove("on"); p.setAttribute("aria-hidden", "true"); } });
    scrim.classList.remove("on", "light");
    if (tune.classList.contains("on")) was = true;
    tune.classList.remove("on"); tuneBtn.setAttribute("aria-expanded", "false");
    savedBtn.setAttribute("aria-expanded", "false");
    setModal(null);
    if (wasReader && readerId) { syncCard(readerId); if (state.mode === "focus") { const c = stage.querySelector(`.card[data-id="${readerId}"]`); if (c) { c.scrollIntoView({ behavior: "auto", block: "start" }); } } }
    if (was && lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    readerId = null;
  }
  // keep the feed card's note control in step with edits made in the reader
  function syncCard(id) {
    const host = stage.querySelector(`[data-id="${id}"]`); if (!host) return;
    const ta = host.querySelector("textarea"); const wrap = host.querySelector(".note-wrap"); const btn = host.querySelector('[data-act="note"]');
    const v = state.notes[id] || "";
    if (ta) ta.value = v;
    if (wrap && btn) { wrap.hidden = !v.trim(); btn.setAttribute("aria-expanded", String(!!v.trim())); const st = host.querySelector(".note-status"); if (st) st.textContent = v.trim() ? "Saved on this device" : ""; }
    const mark = host.querySelector(".notemark"); if (mark && !v.trim()) mark.remove();
  }
  function openReader(id) {
    const s = byId(id); if (!s) return;
    const list = visibleStories();
    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) current = idx;
    readerId = id;
    reader.querySelector(".panel-body").innerHTML = `<div data-id="${id}" class="reader-story">${figure(s)}${body(s)}</div>`;
    reader.querySelector(".label").textContent = `${idx + 1} / ${list.length}`;
    if (!reader.classList.contains("on")) openPanel(reader);
    reader.querySelector(".panel-body").scrollTop = 0;
    stage.querySelectorAll(".tile").forEach(t => t.classList.toggle("active", t.dataset.id === id));
  }
  function toggleTray() {
    if (tray.classList.contains("on")) { closePanels(); return; }
    closePanels(); renderTray(); openPanel(tray); savedBtn.setAttribute("aria-expanded", "true");
  }
  function toggleTune() {
    const on = tune.classList.contains("on");
    closePanels();
    if (on) return;
    renderTune();
    const r = tuneBtn.getBoundingClientRect();
    tune.style.top = (r.bottom + 8) + "px";
    tune.style.left = Math.max(16, Math.min(window.innerWidth - 16 - 340, r.right - 340)) + "px";
    tune.classList.add("on"); tuneBtn.setAttribute("aria-expanded", "true");
    scrim.classList.add("on", "light");
    lastFocus = tuneBtn; setModal(tune);
    const first = tune.querySelector("button"); if (first) first.focus();
  }

  // ---------- events (delegated) ----------
  document.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn) {
      const tile = e.target.closest(".tile");
      if (tile) openReader(tile.dataset.id);
      return;
    }
    const act = btn.dataset.act;
    const host = btn.closest("[data-id]");
    const id = host ? host.dataset.id : null;
    if (btn.dataset.mode) return setMode(btn.dataset.mode);
    if (btn.dataset.topic) return setTopic(btn.dataset.topic);
    if (btn.id === "refreshBtn") return refresh();
    if (btn.id === "savedBtn") return toggleTray();
    if (btn.id === "tuneBtn") return toggleTune();
    if (btn.classList.contains("close")) return closePanels();
    if (btn.classList.contains("reader-prev")) return goTo(current - 1);
    if (btn.classList.contains("reader-next")) return goTo(current + 1);
    switch (act) {
      case "save": e.stopPropagation(); return toggleSave(id);
      case "note": return toggleNote(host);
      case "read": return openReader(id);
      case "more": case "less": return signal(act, id, btn);
      case "open": return openSource(id);
      case "refresh": return refresh();
      case "undo": return undo();
      case "reset": return reset();
      case "jump": {
        closePanels();
        const list = visibleStories();
        let idx = list.findIndex(s => s.id === id);
        if (idx < 0) { state.topic = "all"; rank(); renderChips(); renderStage(); idx = visibleStories().findIndex(s => s.id === id); }
        if (state.mode === "focus") setTimeout(() => goTo(idx), 60); else openReader(id);
        return;
      }
      case "up": case "down": {
        const i = state.saved.indexOf(id); const j = act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= state.saved.length) return;
        [state.saved[i], state.saved[j]] = [state.saved[j], state.saved[i]];
        persist(); renderTray(); return;
      }
      case "remove": return toggleSave(id);
    }
  });
  document.addEventListener("input", e => {
    const ta = e.target;
    if (ta.tagName !== "TEXTAREA") return;
    const host = ta.closest("[data-id]"); if (!host) return;
    noteInput(host.dataset.id, ta, host.querySelector(".note-status"));
  });
  // Tile activation via keyboard handled in keydown; prevent tile click when clicking inner buttons (handled above via stopPropagation for save).
  scrim.addEventListener("click", closePanels);
  window.addEventListener("resize", () => { if (tune.classList.contains("on")) closePanels(); });

  // ---------- boot ----------
  if (!state.rankedIds) rank();
  renderAll();
  window.__rundown = { get state() { return state; }, visible: () => visibleStories().map(s => s.id), weights, KEY };
})();
