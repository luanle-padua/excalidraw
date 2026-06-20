/* ============================================================
   Canvas M Handbook — shell builder + interactions.
   Vanilla JS, no build step. Loaded on every page after toc.js.
   Each page sets <body data-page="home|chapter" data-slug="..." data-base=".">.
   ============================================================ */
(function () {
  "use strict";
  const body = document.body;
  const BASE = body.dataset.base || ".";
  const CUR = body.dataset.slug || "";
  const TOC = window.MCM_TOC || [];

  /* ---- tiny svg icon set ---- */
  const I = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };

  /* ---- topbar ---- */
  function buildTopbar() {
    const bar = document.createElement("header");
    bar.className = "topbar";
    bar.innerHTML = `
      <button class="icon-btn menu-toggle" aria-label="Open chapters">${I.menu}</button>
      <a class="brand" href="${BASE}/index.html" aria-label="Canvas M handbook home">
        <img src="${BASE}/assets/icon.svg" alt="">
        <img class="wm" src="${BASE}/assets/wordmark.svg" alt="Canvas M">
        <span class="tag">Participant Guide</span>
      </a>
      <div class="spacer"></div>
      <label class="searchbox">
        ${I.search}
        <input type="search" id="q" placeholder="Search chapters…" autocomplete="off" aria-label="Search">
        <kbd>/</kbd>
      </label>
      <button class="icon-btn" id="themeBtn" aria-label="Toggle light/dark">${I.moon}</button>`;
    body.prepend(bar);
  }

  /* ---- sidebar ---- */
  function buildSidebar() {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    const aside = document.createElement("nav");
    aside.className = "sidebar";
    aside.setAttribute("aria-label", "Chapters");
    let html = "";
    TOC.forEach((part) => {
      html += `<div class="nav-part">
        <div class="part-label"><span class="pn">PART ${part.part}</span> ${part.label}</div>`;
      part.chapters.forEach((c) => {
        const href = `${BASE}/chapters/${c.slug}.html`;
        const active = c.slug === CUR ? " active" : "";
        const stub = c.ready ? "" : " stub";
        html += `<a class="nav-link${active}${stub}" href="${href}" data-search="${(c.title + " " + c.desc).toLowerCase()}">
            <span class="num">${String(c.n).padStart(2, "0")}</span>
            <span class="lbl">${c.title}</span>
          </a>`;
      });
      html += `</div>`;
    });
    html += `<div class="nav-empty">No chapters match your search.</div>`;
    aside.innerHTML = html;
    body.appendChild(scrim);
    // Sidebar must be the FIRST grid child of .shell (before .content).
    const shell = document.querySelector(".shell");
    if (shell) { shell.insertBefore(aside, shell.firstChild); }
    else { body.appendChild(aside); }
    return { aside, scrim };
  }

  /* ---- theme ---- */
  function initTheme() {
    const root = document.documentElement;
    const saved = localStorage.getItem("mcm-theme");
    if (saved) root.setAttribute("data-theme", saved);
    const btn = document.getElementById("themeBtn");
    const sync = () => { btn.innerHTML = root.getAttribute("data-theme") === "light" ? I.sun : I.moon; };
    sync();
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      localStorage.setItem("mcm-theme", next);
      sync();
    });
  }

  /* ---- search filter ---- */
  function initSearch(aside) {
    const input = document.getElementById("q");
    const links = [...aside.querySelectorAll(".nav-link")];
    const empty = aside.querySelector(".nav-empty");
    const parts = [...aside.querySelectorAll(".nav-part")];
    function run(v) {
      const q = v.trim().toLowerCase();
      let any = false;
      links.forEach((l) => {
        const hit = !q || l.dataset.search.includes(q);
        l.hidden = !hit;
        if (hit) any = true;
      });
      parts.forEach((p) => {
        const visible = [...p.querySelectorAll(".nav-link")].some((l) => !l.hidden);
        p.style.display = visible ? "" : "none";
      });
      empty.style.display = any ? "none" : "block";
    }
    input.addEventListener("input", (e) => run(e.target.value));
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== input) { e.preventDefault(); input.focus(); }
      if (e.key === "Escape" && document.activeElement === input) { input.value = ""; run(""); input.blur(); }
    });
  }

  /* ---- mobile menu ---- */
  function initMobile(aside, scrim) {
    const toggle = document.querySelector(".menu-toggle");
    const close = () => { aside.classList.remove("open"); scrim.classList.remove("show"); };
    toggle.addEventListener("click", () => { aside.classList.toggle("open"); scrim.classList.toggle("show"); });
    scrim.addEventListener("click", close);
    aside.addEventListener("click", (e) => { if (e.target.closest(".nav-link")) close(); });
  }

  /* ---- scroll spy (chapter pages with section[id]) ---- */
  function initScrollSpy() {
    const sections = [...document.querySelectorAll(".content section[id]")];
    if (!sections.length) return;
    // add an in-page mini TOC if present container#onthispage handled separately
  }

  /* ---- copyable shortcuts ---- */
  function initShortcuts() {
    document.querySelectorAll(".shortcut[data-copy]").forEach((el) => {
      el.addEventListener("click", () => {
        navigator.clipboard && navigator.clipboard.writeText(el.dataset.copy);
        el.classList.add("copied");
        const keys = el.querySelector(".keys");
        const old = keys.innerHTML;
        setTimeout(() => { el.classList.remove("copied"); keys.innerHTML = old; }, 1100);
      });
    });
  }

  /* ---- tabs ---- */
  function initTabs() {
    document.querySelectorAll(".tabs").forEach((tabs) => {
      const btns = [...tabs.querySelectorAll(".tablist button")];
      const panels = [...tabs.querySelectorAll(".tabpanel")];
      btns.forEach((b, i) => {
        b.addEventListener("click", () => {
          btns.forEach((x) => x.setAttribute("aria-selected", "false"));
          panels.forEach((p) => (p.hidden = true));
          b.setAttribute("aria-selected", "true");
          panels[i].hidden = false;
        });
      });
    });
  }

  /* ---- boot ---- */
  buildTopbar();
  const { aside, scrim } = buildSidebar();
  initTheme();
  initSearch(aside);
  initMobile(aside, scrim);
  initScrollSpy();
  initShortcuts();
  initTabs();
})();
