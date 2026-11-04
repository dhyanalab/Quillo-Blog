(() => {
  const root = document.documentElement;
  const live = document.getElementById("live");
  const announce = (msg) => {
    if (!live) return;
    live.textContent = "";
    setTimeout(() => (live.textContent = msg), 50);
  };

  // Light/dark toggle. A saved choice overrides the OS setting; the head script applies it before paint.
  const toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : media.matches);
    const sync = () => toggle.setAttribute("aria-pressed", String(isDark()));
    toggle.hidden = false;
    sync();
    media.addEventListener("change", sync);
    toggle.addEventListener("click", () => {
      root.dataset.theme = isDark() ? "light" : "dark";
      try {
        localStorage.setItem("theme", root.dataset.theme);
      } catch {}
      sync();
    });
  }

  // Mobile menu button.
  const menuBtn = document.querySelector(".menu-toggle");
  const nav = document.getElementById("main-nav");
  if (menuBtn && nav) {
    menuBtn.hidden = false;
    menuBtn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
  }

  // Dropdowns: one open at a time; close on outside click or Escape.
  const dropdowns = [...document.querySelectorAll(".dd")];
  for (const dd of dropdowns) {
    dd.addEventListener("toggle", () => {
      if (dd.open) for (const other of dropdowns) if (other !== dd) other.open = false;
    });
  }
  document.addEventListener("click", (e) => {
    for (const dd of dropdowns) if (dd.open && !dd.contains(e.target)) dd.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const dd of dropdowns) {
      if (!dd.open) continue;
      dd.open = false;
      dd.querySelector("summary")?.focus();
    }
  });

  // "Print or save as PDF" buttons on legal pages.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-print]")) window.print();
  });

  // Search button opens the search bar under the header.
  const searchBtn = document.querySelector(".search-toggle");
  const searchBar = document.getElementById("search-bar");
  if (searchBtn && searchBar) {
    searchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const open = searchBar.hidden;
      searchBar.hidden = !open;
      searchBtn.setAttribute("aria-expanded", String(open));
      if (open) searchBar.querySelector("input")?.focus();
    });
  }

  // Copy-link share button.
  for (const btn of document.querySelectorAll(".copy-link")) {
    if (!navigator.clipboard) continue;
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.url);
        btn.classList.add("done");
        announce("Link copied");
      } catch {
        announce("Couldn't copy the link");
      }
      setTimeout(() => btn.classList.remove("done"), 2000);
    });
  }

  // Copy buttons on code blocks and source files.
  if (navigator.clipboard) {
    for (const btn of document.querySelectorAll(".code-copy")) {
      const code = btn.dataset.copy ? document.getElementById(btn.dataset.copy) : btn.closest(".code")?.querySelector("code");
      const label = btn.querySelector("span");
      if (!code || !label) continue;
      btn.hidden = false;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(code.textContent);
          label.textContent = "Copied";
          announce("Code copied");
        } catch {
          label.textContent = "Copy failed";
        }
        setTimeout(() => (label.textContent = "Copy"), 2000);
      });
    }
  }

  // Source code as tabs (Admin > Design "Tabbed panel" and "Dark editor"): one file shows at a time; long files show their
  // first lines with a "Show all" button. Without this script every file shows in full, one under another.
  for (const box of document.querySelectorAll(".src-tabs")) {
    const tabs = [...box.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
    if (!tabs.length || panels.some((p) => !p)) continue;
    const select = (i, focus) => {
      tabs.forEach((t, j) => {
        t.setAttribute("aria-selected", String(i === j));
        t.tabIndex = i === j ? 0 : -1;
        panels[j].hidden = i !== j;
      });
      if (focus) tabs[i].focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(i, false));
      t.addEventListener("keydown", (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (step) select((i + step + tabs.length) % tabs.length, true);
        else if (e.key === "Home") select(0, true);
        else if (e.key === "End") select(tabs.length - 1, true);
        else return;
        e.preventDefault();
      });
    });
    box.querySelector(".src-tabbar").hidden = false;
    box.classList.add("tabbed");
    select(0, false);
    for (const pre of box.querySelectorAll("pre")) {
      const lines = (pre.textContent.match(/\n/g) || []).length + 1;
      if (lines <= 24) continue;
      pre.classList.add("clip");
      const more = document.createElement("button");
      more.type = "button";
      more.className = "src-more";
      more.textContent = `Show all ${lines} lines`;
      more.addEventListener("click", () => {
        pre.classList.remove("clip");
        more.remove();
        pre.focus();
      });
      pre.after(more);
    }
  }

  // Confirm before deleting a comment or an account.
  for (const form of document.querySelectorAll("form.confirm-form")) {
    form.addEventListener("submit", (e) => {
      if (!confirm(form.dataset.confirm || "Are you sure?")) e.preventDefault();
    });
  }

  // Reply: the comment box moves under the comment being answered.
  // Every part is looked up first and the whole block is skipped if one is missing (an element with the same id in an article must not break the page).
  const compose = document.getElementById("compose");
  const parent = compose?.querySelector("[name=parent_id]");
  const replyTo = compose?.querySelector(".reply-to");
  const cancel = compose?.querySelector(".cancel-reply");
  if (compose && parent && replyTo && cancel) {
    const home = compose.parentNode;
    const homeNext = compose.nextSibling;
    const reset = () => {
      parent.value = "";
      replyTo.hidden = true;
      cancel.hidden = true;
      compose.classList.remove("reply-form");
      home.insertBefore(compose, homeNext);
    };
    for (const btn of document.querySelectorAll(".reply-btn")) {
      btn.hidden = false;
      btn.addEventListener("click", () => {
        parent.value = btn.dataset.reply;
        replyTo.textContent = `Replying to ${btn.dataset.name}`;
        replyTo.hidden = false;
        cancel.hidden = false;
        compose.classList.add("reply-form");
        btn.closest(".cmt")?.querySelector(":scope > div")?.appendChild(compose);
        compose.querySelector("textarea")?.focus();
      });
    }
    cancel.addEventListener("click", reset);
  }

  // Contents: highlight the section being read.
  const tocLinks = [...document.querySelectorAll(".toc a")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const decode = (h) => {
      try {
        return decodeURIComponent(h);
      } catch {
        return h;
      }
    };
    const byId = new Map(tocLinks.map((a) => [decode(a.hash.slice(1)), a]));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of tocLinks) a.removeAttribute("aria-current");
        byId.get(e.target.id)?.setAttribute("aria-current", "true");
      }
    }, { rootMargin: "-90px 0px -70% 0px" });
    for (const id of byId.keys()) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
  }

  // Sponsor banners: when a place has several, show one at random; count views (half visible) and clicks.
  const places = [...document.querySelectorAll(".kx[data-k]")];
  if (places.length) {
    const url = `${root.dataset.base || ""}/k`;
    const send = (kind, ids) => {
      if (!ids.length) return;
      const body = `${kind}:${ids.join(",")}`;
      try {
        if (!navigator.sendBeacon?.(url, body)) fetch(url, { method: "POST", body, keepalive: true, credentials: "same-origin" });
      } catch {}
    };
    const seen = new Set();
    let pending = [];
    let timer = 0;
    const flush = () => {
      send("v", pending);
      pending = [];
    };
    const io = "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            const id = e.target.dataset.i;
            if (seen.has(id)) continue;
            seen.add(id);
            pending.push(id);
            clearTimeout(timer);
            timer = setTimeout(flush, 1500);
          }
        }, { threshold: 0.5 })
      : null;
    for (const place of places) {
      const items = [...place.querySelectorAll(".kx-i")];
      if (!items.length) continue;
      const pick = items[Math.floor(Math.random() * items.length)];
      for (const item of items) item.hidden = item !== pick;
      io?.observe(pick);
      pick.addEventListener("click", () => send("c", [pick.dataset.i]));
    }
    addEventListener("pagehide", flush);
  }

  // Wide tables and code scroll inside their box; make those boxes reachable by keyboard.
  for (const el of document.querySelectorAll(".prose .tbl-wrap, .prose pre")) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    el.tabIndex = 0;
    if (el.matches(".tbl-wrap")) {
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", "Table, scrolls sideways");
    }
  }

  // YouTube facade: no YouTube code until the reader clicks play.
  for (const poster of document.querySelectorAll(".yt-poster")) {
    const img = poster.querySelector("img");
    const useFallback = () => {
      if (img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback;
    };
    // A missing maxresdefault comes back as a 120x90 placeholder rather than an error.
    if (img.complete && img.naturalWidth <= 120) useFallback();
    img.addEventListener("load", () => img.naturalWidth <= 120 && useFallback());
    img.addEventListener("error", useFallback);

    poster.addEventListener("click", (event) => {
      event.preventDefault();
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube-nocookie.com/embed/${poster.dataset.id}?autoplay=1&rel=0`;
      iframe.title = poster.dataset.title || "YouTube video";
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      poster.replaceWith(iframe);
      iframe.focus();
    });
  }
})();
