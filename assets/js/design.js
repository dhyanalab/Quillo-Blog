// Admin > Design: shows the chosen look in the preview frame straight away. The frame holds a page from this admin (same
// origin). Colours, fonts and the other style choices are switched on its <html> at once; choices that change the page's
// layout (header, home page, article page, share buttons, code box, downloads) reload it. The admin look changes this page.
(() => {
  const form = document.getElementById("design-form");
  const frame = document.getElementById("design-frame");
  if (!form || !frame) return;
  const box = document.getElementById("design-box");
  const unsaved = document.getElementById("design-unsaved");
  const A = document.body.dataset.admin;
  const root = document.documentElement;
  const state = { page: "home", look: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", device: "desktop" };
  const groups = [...form.querySelectorAll("[data-group]")];
  // The groups readers see (the admin's own look and editor aren't part of the preview).
  const publicKeys = groups.filter((g) => g.dataset.page !== "admin").map((g) => g.dataset.group);

  const choices = () => {
    const out = {};
    for (const input of form.querySelectorAll("input[type=radio]:checked")) out[input.name] = input.value;
    return out;
  };
  const saved = JSON.stringify(choices());

  // The frame's page, or null while it is loading.
  const doc = () => {
    try {
      return frame.contentDocument?.documentElement ? frame.contentDocument : null;
    } catch {
      return null;
    }
  };

  function apply() {
    const c = choices();
    root.dataset.dAdmin = c.admin;
    root.dataset.dEditor = c.editor;
    const d = doc();
    if (!d) return;
    const html = d.documentElement;
    for (const k of publicKeys) html.setAttribute(`data-d-${k}`, c[k]);
    html.dataset.theme = c.mode === "light" ? "light" : state.look;
  }

  // The preview is drawn at a real screen width (a computer's 1280 pixels or a phone's 390) and scaled to fit the box.
  function fit() {
    const width = state.device === "phone" ? 390 : 1280;
    const scale = Math.min(1, box.clientWidth / width);
    frame.style.width = `${width}px`;
    frame.style.height = `${Math.round(box.clientHeight / scale)}px`;
    frame.style.transform = scale < 1 ? `scale(${scale})` : "";
    box.classList.toggle("phone", state.device === "phone");
  }

  function press(attr, value) {
    for (const b of document.querySelectorAll(`.dp-bar [data-${attr}]`)) b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
  }

  function sync() {
    const c = choices();
    const lightOnly = c.mode === "light";
    for (const b of document.querySelectorAll(".dp-bar [data-look]")) b.disabled = lightOnly && b.dataset.look === "dark";
    press("look", lightOnly ? "light" : state.look);
    press("page", state.page);
    unsaved.hidden = JSON.stringify(c) === saved;
  }

  function load() {
    const c = choices();
    const q = new URLSearchParams({ page: state.page });
    for (const k of publicKeys) q.set(k, c[k]);
    frame.src = `${A}/design/preview?${q}`;
  }

  frame.addEventListener("load", () => {
    apply();
    fit();
    // Links and forms in the preview stay put: leaving would lose the choices being tried.
    const d = doc();
    if (!d) return;
    d.addEventListener("click", (e) => {
      if (e.target.closest("a[href], button[type=submit]")) e.preventDefault();
    }, true);
    d.addEventListener("submit", (e) => e.preventDefault(), true);
  });

  // A change shows on the page that has it: article parts on the article, home layouts on the home page.
  form.addEventListener("change", (e) => {
    const group = e.target.closest("[data-group]");
    if (!group) return;
    const page = group.dataset.page;
    const reload = group.dataset.markup === "1" || ((page === "home" || page === "post") && page !== state.page);
    if (page === "home" || page === "post") state.page = page;
    sync();
    if (reload) load();
    else apply();
  });

  // Templates fill in the choices they hold; anything they leave out (admin look, editor) stays as it is.
  for (const b of document.querySelectorAll("[data-template]")) {
    b.hidden = false;
    b.addEventListener("click", () => {
      let t;
      try {
        t = JSON.parse(b.dataset.template);
      } catch {
        return;
      }
      for (const [k, v] of Object.entries(t)) {
        const input = form.querySelector(`input[type=radio][name="${CSS.escape(k)}"][value="${CSS.escape(v)}"]`);
        if (input) input.checked = true;
      }
      sync();
      load();
    });
  }

  for (const b of document.querySelectorAll(".dp-bar [data-page]")) {
    b.addEventListener("click", () => {
      state.page = b.dataset.page;
      sync();
      load();
    });
  }
  for (const b of document.querySelectorAll(".dp-bar [data-look]")) {
    b.addEventListener("click", () => {
      state.look = b.dataset.look;
      apply();
      sync();
    });
  }
  for (const b of document.querySelectorAll(".dp-bar [data-device]")) {
    b.addEventListener("click", () => {
      state.device = b.dataset.device;
      press("device", state.device);
      fit();
    });
  }
  document.getElementById("design-original")?.addEventListener("click", () => {
    for (const input of form.querySelectorAll("input[type=radio][data-default=yes]")) input.checked = true;
    sync();
    load();
  });

  let leaving = false;
  form.addEventListener("submit", () => {
    leaving = true;
  });
  addEventListener("beforeunload", (e) => {
    if (!leaving && JSON.stringify(choices()) !== saved) e.preventDefault();
  });
  addEventListener("resize", fit);

  sync();
  fit();
  apply();
})();
