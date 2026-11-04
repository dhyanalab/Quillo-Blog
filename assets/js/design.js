// Admin > Design: shows the chosen look in the preview frame straight away. The frame holds a page from this admin
// (same origin), so palette, fonts and light/dark are switched on its <html> without reloading; picking Home or Article
// loads that page with the current choices.
(() => {
  const form = document.getElementById("design-form");
  const frame = document.getElementById("design-frame");
  if (!form || !frame) return;
  const box = document.getElementById("design-box");
  const unsaved = document.getElementById("design-unsaved");
  const A = document.body.dataset.admin;
  const state = { page: "home", look: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", device: "desktop" };

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
    const d = doc();
    if (!d) return;
    const c = choices();
    const html = d.documentElement;
    html.dataset.dPalette = c.palette;
    html.dataset.dFonts = c.fonts;
    html.dataset.dMode = c.mode;
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
    for (const b of document.querySelectorAll(`[data-${attr}]`)) b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
  }

  function sync() {
    const c = choices();
    const lightOnly = c.mode === "light";
    for (const b of document.querySelectorAll("[data-look]")) b.disabled = lightOnly && b.dataset.look === "dark";
    press("look", lightOnly ? "light" : state.look);
    unsaved.hidden = JSON.stringify(c) === saved;
  }

  function load() {
    frame.src = `${A}/design/preview?${new URLSearchParams({ page: state.page, ...choices() })}`;
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

  form.addEventListener("change", () => {
    apply();
    sync();
  });
  for (const b of document.querySelectorAll("[data-page]")) {
    b.addEventListener("click", () => {
      state.page = b.dataset.page;
      press("page", state.page);
      load();
    });
  }
  for (const b of document.querySelectorAll("[data-look]")) {
    b.addEventListener("click", () => {
      state.look = b.dataset.look;
      apply();
      sync();
    });
  }
  for (const b of document.querySelectorAll("[data-device]")) {
    b.addEventListener("click", () => {
      state.device = b.dataset.device;
      press("device", state.device);
      fit();
    });
  }
  document.getElementById("design-original")?.addEventListener("click", () => {
    for (const input of form.querySelectorAll("input[type=radio][data-default=yes]")) input.checked = true;
    apply();
    sync();
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
