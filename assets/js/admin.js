// Shared admin behaviour. No framework; every page works without it, this only makes it nicer.
(() => {
  const root = document.documentElement;
  const body = document.body;
  const A = body.dataset.admin;
  const csrf = body.dataset.csrf;

  async function api(path, opts = {}) {
    const res = await fetch(A + path, { credentials: "same-origin", ...opts, headers: { "x-csrf-token": csrf, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 422) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
    return Object.assign(data, { status: res.status });
  }
  // neutral: plain file names for sponsor banners (see src/web/slots.js).
  const upload = (file, alt = "", { neutral = false } = {}) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("alt", alt);
    if (neutral) fd.append("neutral", "1");
    return api("/api/media", { method: "POST", body: fd });
  };
  const slugify = (s) =>
    String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  const FILE_EXT = /\.(pdf|stl|3mf|step|stp|zip)$/i;
  const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/avif,image/gif,image/svg+xml";
  const FILE_ACCEPT = ".pdf,.stl,.3mf,.step,.stp,.zip";
  window.Admin = { A, csrf, api, upload, slugify, FILE_EXT };

  // Theme toggle (shared with the site).
  const toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : media.matches);
    const sync = () => toggle.setAttribute("aria-pressed", String(isDark()));
    toggle.hidden = false;
    sync();
    toggle.addEventListener("click", () => {
      root.dataset.theme = isDark() ? "light" : "dark";
      try {
        localStorage.setItem("theme", root.dataset.theme);
      } catch {}
      sync();
    });
  }

  // Sidebar on phones.
  const menu = document.querySelector(".adm-menu");
  const side = document.getElementById("adm-side");
  menu?.addEventListener("click", () => menu.setAttribute("aria-expanded", String(side.classList.toggle("open"))));

  // Filters that apply as soon as they change.
  document.addEventListener("change", (e) => {
    if (e.target.matches("select[data-autosubmit]")) e.target.form.submit();
  });

  // Show or hide a password while it is typed (button[data-reveal] names the input).
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-reveal]");
    const input = b && document.getElementById(b.dataset.reveal);
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    b.textContent = show ? "Hide" : "Show";
    b.setAttribute("aria-pressed", String(show));
  });

  // Confirm destructive forms, or a single button in a form (e.g. "Send to everyone").
  document.addEventListener("submit", (e) => {
    const msg = e.submitter?.dataset.confirm || e.target.closest("form[data-confirm]")?.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // Parts of a form shown only for some choices: data-when="field=value|other".
  const whens = [...document.querySelectorAll("[data-when]")];
  const syncWhens = () => {
    for (const el of whens) {
      const [name, values] = el.dataset.when.split("=");
      const form = el.closest("form");
      const current = form?.querySelector(`[name="${name}"]:checked`)?.value ?? form?.elements[name]?.value;
      el.hidden = !values.split("|").includes(current);
    }
  };
  if (whens.length) {
    document.addEventListener("change", syncWhens);
    syncWhens();
  }

  // Email service picker: a known service fills in and hides the server details.
  for (const sel of document.querySelectorAll("[data-smtp-preset]")) {
    const box = sel.closest("[data-smtp]");
    const form = sel.form;
    const sync = (fill) => {
      const o = sel.selectedOptions[0];
      const known = Boolean(sel.value) && sel.value !== "other";
      box.querySelector("[data-smtp-server]").hidden = known;
      if (!sel.value) return;
      if (fill && known) {
        form.elements.smtp_host.value = o.dataset.host;
        form.elements.smtp_port.value = o.dataset.port;
        form.elements.smtp_secure.value = o.dataset.secure;
      }
      box.querySelector("[data-smtp-user-help]").textContent = o.dataset.user;
      box.querySelector("[data-smtp-pass-help]").textContent = o.dataset.pass;
    };
    sel.addEventListener("change", () => sync(true));
    sync(false);
  }

  // Character counters: <small class="count" data-for="id" data-max="155">
  for (const el of document.querySelectorAll(".count[data-for]")) {
    const input = document.getElementById(el.dataset.for);
    if (!input) continue;
    const max = Number(el.dataset.max);
    const update = () => {
      const n = input.value.length;
      el.textContent = `${n}/${max}`;
      el.classList.toggle("over", n > max);
      el.classList.toggle("good", n > 0 && n <= max);
    };
    input.addEventListener("input", update);
    update();
  }

  // Slug follows the name until edited by hand.
  for (const form of document.querySelectorAll("[data-autoslug]")) {
    const src = form.querySelector("[data-slug-source]");
    const target = form.querySelector("[data-slug-target]");
    const echo = form.querySelector("[data-slug-echo]");
    if (!src || !target) continue;
    const show = () => echo && (echo.textContent = target.value || "…");
    target.addEventListener("input", () => {
      target.dataset.touched = "true";
      show();
    });
    src.addEventListener("input", () => {
      if (target.dataset.touched !== "true") target.value = slugify(src.value);
      show();
    });
  }

  // Copy buttons.
  document.addEventListener("click", async (e) => {
    // Only our own buttons copy: draft HTML shown in the editor or a preview can carry data-copy, and
    // clicking styled text there must never put someone else's text on the clipboard.
    const b = e.target.closest("button[data-copy]");
    if (!b || b.closest(".toastui-editor-defaultUI, .toastui-editor-contents, .post-body, [contenteditable]")) return;
    const label = b.textContent;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Copy failed";
    }
    setTimeout(() => (b.textContent = label), 1500);
  });

  // Media picker dialog: images, or downloadable files (PDF, STL...) with { kind: "file" }.
  const dialog = document.getElementById("media-dialog");
  let onPick = null;
  let pageNo = 1;
  let kind = "image";
  let neutral = false;
  if (dialog) {
    const grid = dialog.querySelector(".md-grid");
    const more = dialog.querySelector("[data-more]");
    const status = dialog.querySelector(".md-status");
    const search = dialog.querySelector("#md-search");
    const fileInput = dialog.querySelector(".md-upload input");
    const render = (items, append) => {
      if (!append) grid.textContent = "";
      for (const item of items) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        const name = document.createElement("span");
        name.className = "sr-only";
        name.textContent = item.name;
        if (item.kind === "file") {
          const f = document.createElement("span");
          f.className = "md-file";
          f.textContent = `${item.ext.toUpperCase()} · ${item.name}`;
          btn.append(f);
        } else {
          const img = document.createElement("img");
          img.src = item.thumb;
          img.alt = "";
          img.loading = "lazy";
          btn.append(img, name);
        }
        btn.title = item.name;
        btn.addEventListener("click", () => choose(item));
        li.append(btn);
        grid.append(li);
      }
      if (!grid.children.length) grid.innerHTML = `<li class="meta">No ${kind === "file" ? "files" : "images"} yet. Upload one.</li>`;
    };
    const load = async (append = false) => {
      status.textContent = "Loading…";
      try {
        const data = await api(`/api/media?page=${pageNo}&kind=${kind}&q=${encodeURIComponent(search.value)}`);
        render(data.items, append);
        more.hidden = !data.more;
        status.textContent = "";
      } catch (err) {
        status.textContent = err.message;
      }
    };
    const choose = (item) => {
      dialog.close();
      onPick?.(item);
    };
    let t;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        pageNo = 1;
        load();
      }, 250);
    });
    more.addEventListener("click", () => {
      pageNo++;
      load(true);
    });
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      status.textContent = "Uploading…";
      try {
        const data = await upload(file, "", { neutral });
        if (data.error) throw new Error(data.error);
        choose(data.item);
      } catch (err) {
        status.textContent = err.message;
      }
      fileInput.value = "";
    });
    window.Admin.pickMedia = (cb, opts = {}) => {
      onPick = cb;
      pageNo = 1;
      kind = opts.kind === "file" ? "file" : "image";
      neutral = Boolean(opts.neutral);
      dialog.querySelector("#media-dialog-title").textContent = kind === "file" ? "Choose a file" : "Choose an image";
      fileInput.accept = kind === "file" ? FILE_ACCEPT : IMAGE_ACCEPT;
      search.value = "";
      dialog.showModal();
      load();
    };
  }

  // [data-picker]: hidden id input + preview + Choose/Remove.
  for (const p of document.querySelectorAll("[data-picker]")) {
    const input = p.querySelector("input[type=hidden]");
    const img = p.querySelector(".picker-img");
    const clear = p.querySelector("[data-clear]");
    p.querySelector("[data-pick]")?.addEventListener("click", () =>
      window.Admin.pickMedia?.((item) => {
        input.value = item.id;
        img.src = item.thumb;
        img.hidden = false;
        clear.hidden = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, { neutral: p.hasAttribute("data-neutral") }),
    );
    clear?.addEventListener("click", () => {
      input.value = "";
      img.hidden = true;
      img.removeAttribute("src");
      clear.hidden = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  // Social links editor: the logo follows the chosen network, and pasting a link picks the network.
  for (const box of document.querySelectorAll("[data-links]")) {
    const list = box.querySelector(".lk-list");
    const tpl = box.querySelector("template");
    const icons = Object.fromEntries([...box.querySelectorAll(".lk-icons [data-n]")].map((el) => [el.dataset.n, el.innerHTML]));
    const wire = (row) => {
      const select = row.querySelector("select");
      const input = row.querySelector("input");
      const sync = () => {
        row.querySelector(".lk-logo").innerHTML = icons[select.value] || "";
        input.placeholder = select.selectedOptions[0]?.dataset.placeholder || "";
      };
      select.addEventListener("change", sync);
      input.addEventListener("input", () => {
        let host = "";
        try {
          host = new URL(input.value.trim()).hostname.toLowerCase().replace(/^(www|m|mobile)./, "");
        } catch {
          return;
        }
        const match = [...select.options].find((o) => (o.dataset.hosts || "").split(" ").some((h) => h && (host === h || host.endsWith(`.${h}`))));
        select.value = match ? match.value : "website";
        sync();
      });
      row.querySelector("[data-remove-link]").addEventListener("click", () => {
        if (list.children.length > 1) row.remove();
        else {
          input.value = "";
          select.value = "website";
          sync();
        }
      });
    };
    [...list.children].forEach(wire);
    box.querySelector("[data-add-link]").addEventListener("click", () => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      list.append(row);
      wire(row);
      row.querySelector("select").focus();
    });
  }

  // Media page: upload on choose, and drag-and-drop.
  for (const zone of document.querySelectorAll("[data-dropzone]")) {
    const input = zone.querySelector("[data-autosubmit]");
    const progress = zone.querySelector("[data-progress]");
    input?.addEventListener("change", () => {
      progress.textContent = "Uploading…";
      zone.submit();
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/") || FILE_EXT.test(f.name));
      let done = 0;
      for (const f of files) {
        progress.textContent = `Uploading ${done + 1} of ${files.length}…`;
        try {
          const data = await upload(f);
          if (data.error) throw new Error(data.error);
        } catch (err) {
          progress.textContent = `${f.name}: ${err.message}`;
          return;
        }
        done++;
      }
      location.href = `${A}/media?ok=uploaded`;
    });
  }
})();
