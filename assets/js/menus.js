// Menu editor: each item has a label and a "Goes to" list of the blog's pages and categories (or any
// web address). Items can be moved, removed and given drop-down items. Saved as JSON in hidden fields.
(() => {
  const form = document.getElementById("menus-form");
  if (!form) return;
  const data = JSON.parse(document.getElementById("menu-data").textContent || "{}");
  const rowTpl = document.getElementById("mb-row");
  const colTpl = document.getElementById("mb-col");
  const CUSTOM = "__custom";
  const known = new Map();
  for (const g of data.targets || []) for (const i of g.items) if (!known.has(i.url)) known.set(i.url, i.label);

  function fillSelect(select, url) {
    select.textContent = "";
    select.add(new Option("Choose where it goes…", ""));
    for (const g of data.targets || []) {
      const group = document.createElement("optgroup");
      group.label = g.group;
      for (const i of g.items) group.append(new Option(i.label, i.url));
      select.add(group);
    }
    const other = document.createElement("optgroup");
    other.label = "Somewhere else";
    other.append(new Option("Another web address…", CUSTOM));
    select.add(other);
    select.value = !url ? "" : known.has(url) ? url : CUSTOM;
  }

  // One menu item (or one footer link when `child` is true: no drop-down of its own).
  function makeRow(item = {}, child = false) {
    const li = rowTpl.content.firstElementChild.cloneNode(true);
    const label = li.querySelector('[data-k="label"]');
    const select = li.querySelector('[data-k="target"]');
    const urlBox = li.querySelector(".mb-url");
    const url = li.querySelector('[data-k="url"]');
    label.value = item.label || "";
    fillSelect(select, item.url);
    url.value = item.url && !known.has(item.url) ? item.url : "";
    urlBox.hidden = select.value !== CUSTOM;
    label.dataset.auto = item.label ? "" : "1";
    select.addEventListener("change", () => {
      urlBox.hidden = select.value !== CUSTOM;
      if (select.value === CUSTOM) url.focus();
      else if (select.value && label.dataset.auto === "1") label.value = known.get(select.value) || "";
    });
    label.addEventListener("input", () => (label.dataset.auto = label.value.trim() ? "" : "1"));
    li.querySelector("[data-up]").addEventListener("click", () => li.previousElementSibling && li.parentNode.insertBefore(li, li.previousElementSibling));
    li.querySelector("[data-down]").addEventListener("click", () => li.nextElementSibling && li.parentNode.insertBefore(li.nextElementSibling, li));
    li.querySelector("[data-del]").addEventListener("click", () => li.remove());
    const sub = li.querySelector("[data-sub]");
    const kids = li.querySelector(".mb-children");
    if (child) {
      sub.remove();
      kids.remove();
      li.classList.add("mb-child");
    } else {
      sub.addEventListener("click", () => {
        const r = makeRow({}, true);
        kids.append(r);
        r.querySelector("select").focus();
      });
      for (const k of item.children || []) kids.append(makeRow(k, true));
    }
    return li;
  }
  const readRow = (li) => {
    const select = li.querySelector(':scope > .mb-row [data-k="target"]');
    return {
      label: li.querySelector(':scope > .mb-row [data-k="label"]').value.trim(),
      url: select.value === CUSTOM ? li.querySelector(':scope > .mb-row [data-k="url"]').value.trim() : select.value,
    };
  };

  // Menu bar
  const navList = document.getElementById("nav-list");
  const fillNav = (items) => {
    navList.textContent = "";
    for (const i of items || []) navList.append(makeRow(i));
  };
  fillNav(data.nav);
  form.querySelector("[data-add-item]").addEventListener("click", () => {
    const r = makeRow();
    navList.append(r);
    r.querySelector("input").focus();
  });
  form.querySelector("[data-reset-nav]").addEventListener("click", () => {
    if (confirm("Replace the menu items with your categories?")) fillNav(data.autoNav);
  });

  // Footer columns
  const cols = document.getElementById("footer-cols");
  function makeCol(col = { title: "", links: [] }) {
    const el = colTpl.content.firstElementChild.cloneNode(true);
    el.querySelector('[data-k="title"]').value = col.title || "";
    const links = el.querySelector(".mb-links");
    for (const l of col.links || []) links.append(makeRow(l, true));
    el.querySelector("[data-add-link]").addEventListener("click", () => {
      const r = makeRow({}, true);
      links.append(r);
      r.querySelector("input").focus();
    });
    el.querySelector("[data-left]").addEventListener("click", () => el.previousElementSibling && cols.insertBefore(el, el.previousElementSibling));
    el.querySelector("[data-del-col]").addEventListener("click", () => el.remove());
    return el;
  }
  const fillFooter = (list) => {
    cols.textContent = "";
    for (const c of list || []) cols.append(makeCol(c));
  };
  fillFooter(data.footer);
  form.querySelector("[data-add-col]").addEventListener("click", () => {
    const c = makeCol({ title: "", links: [{}] });
    cols.append(c);
    c.querySelector("input").focus();
  });
  form.querySelector("[data-reset-footer]").addEventListener("click", () => {
    if (confirm("Replace the footer columns with the automatic ones?")) fillFooter(data.autoFooter);
  });

  // Show each editor only when "choose myself" is picked.
  const sync = () => {
    document.getElementById("nav-builder").hidden = form.nav_mode.value !== "custom";
    document.getElementById("footer-builder").hidden = form.footer_mode.value !== "custom";
  };
  form.addEventListener("change", (e) => e.target.name?.endsWith("_mode") && sync());
  sync();

  // Save: check every row has a label and a destination, then send JSON.
  form.addEventListener("submit", (e) => {
    form.querySelector(".mb-problem")?.remove();
    let bad = null;
    const check = (li) => {
      const r = readRow(li);
      const ok = (r.label && r.url) || (!r.label && !r.url);
      li.classList.toggle("mb-bad", !ok);
      if (!ok && !bad) bad = li;
      return r;
    };
    const nav = [...navList.children].map((li) => ({ ...check(li), children: [...li.querySelectorAll(".mb-children > li")].map(check).filter((k) => k.label && k.url) })).filter((i) => i.label && i.url);
    const footer = [...cols.children].map((c) => ({ title: c.querySelector('[data-k="title"]').value.trim(), links: [...c.querySelectorAll(".mb-links > li")].map(check).filter((l) => l.label && l.url) }));
    const checkNav = form.nav_mode.value === "custom";
    const checkFooter = form.footer_mode.value === "custom";
    if (bad && ((checkNav && navList.contains(bad)) || (checkFooter && cols.contains(bad)))) {
      e.preventDefault();
      const p = document.createElement("p");
      p.className = "form-error mb-problem";
      p.setAttribute("role", "alert");
      p.textContent = "Each item needs both a label and a place it goes to. Fill in or remove the highlighted item.";
      form.prepend(p);
      bad.querySelector("input, select").focus();
      return;
    }
    document.getElementById("nav-json").value = JSON.stringify(nav);
    document.getElementById("footer-json").value = JSON.stringify(footer.filter((c) => c.title && c.links.length));
  });
})();
