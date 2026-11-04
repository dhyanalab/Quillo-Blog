// Post editor: Toast UI (visual, with a Markdown switch), settings drawer, source files, downloads,
// publishing checks, autosave for drafts, preview, history and delete. Saves through the JSON API.
(() => {
  const root = document.getElementById("editor");
  if (!root || !window.ToastEditor || !window.Admin) return;
  const { api, upload, slugify, A } = window.Admin;
  const data = JSON.parse(document.getElementById("ed-data").textContent || "{}");
  // Grab the page's own elements before the editor exists. What a writer puts in the text (ids, names, classes) can never stand in for
  // them afterwards: lookups skip everything inside the editing area, and ids and field names are remembered from before it was built.
  const editArea = document.getElementById("ed-editor");
  const ids = new Map();
  for (const e of document.querySelectorAll("[id]")) if (!ids.has(e.id)) ids.set(e.id, e);
  const fields = new Map();
  for (const e of root.querySelectorAll("[name]")) if (!fields.has(e.name)) fields.set(e.name, e);
  const byId = (name) => ids.get(name) || null;
  const $ = (s, r = root) => {
    for (const n of r.querySelectorAll(s)) if (!editArea.contains(n)) return n;
    return null;
  };
  const $$ = (s, r = root) => [...r.querySelectorAll(s)].filter((n) => !editArea.contains(n));
  const field = (name) => fields.get(name) || null;
  const type = root.dataset.type;
  let id = Number(root.dataset.id) || 0;
  let state = root.dataset.state;

  const statusEl = $("#ed-status");
  const stateEl = $("#ed-state");
  const setStatus = (text, err = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle("err", err);
  };
  let dirty = false;
  let saving = false;
  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    setStatus("Unsaved changes");
  };

  // ---------- The writing area ----------
  const dark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  // Admin > Design: "switch" (Visual with a Markdown switch, remembering each person's last choice), "visual" (Visual only)
  // or "markdown" (Markdown with the finished post beside it).
  const style = document.documentElement.dataset.dEditor || "switch";
  let mode = style === "markdown" ? "markdown" : "wysiwyg";
  try {
    if (style === "switch" && ["wysiwyg", "markdown"].includes(localStorage.getItem("ed-mode"))) mode = localStorage.getItem("ed-mode");
  } catch {}

  async function uploadImage(blob) {
    setStatus("Uploading image…");
    try {
      const res = await upload(blob);
      if (res.error) throw new Error(res.error);
      setStatus("Image uploaded");
      return res.item;
    } catch (err) {
      setStatus(err.message, true);
      return null;
    }
  }

  // HTML in the text goes through DOMPurify (the version pinned in package-lock.json, bundled with the editor) with an explicit allow-list
  // of the tags and attributes the article pages themselves can show. Nothing else survives: no forms, labels, buttons or inputs (a label
  // with a "for" would press the editor's own buttons when its text is clicked), no id, name, class, style, tabindex or accesskey, no frames,
  // and only http(s), mailto, tel and relative addresses. The one data attribute kept is data-nodeid, which the preview needs for
  // scroll sync and the cursor highlight; every other data-* attribute is removed (so draft text can't carry data-copy and the like).
  const SAFE_URL = /^(?:https?:|mailto:|tel:|[^:]*(?:[/?#]|$))/i;
  const ALLOWED_TAGS = ["a", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul"];
  const ALLOWED_ATTR = ["alt", "align", "colspan", "data-nodeid", "dir", "height", "href", "lang", "rowspan", "src", "start", "title", "width"];
  const FORBID_TAGS = ["label", "button", "input", "form", "select", "textarea", "option", "style", "iframe", "frame", "object", "embed", "link", "meta", "base", "script", "svg", "math"];
  const FORBID_ATTR = ["for", "form", "formaction", "accesskey", "tabindex", "id", "name", "style", "class"];
  const sanitize = (html) => {
    const purify = window.EditorPurify;
    if (!purify) return String(html).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
    return purify.sanitize(String(html), { ALLOWED_TAGS, ALLOWED_ATTR, FORBID_TAGS, FORBID_ATTR, ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: SAFE_URL });
  };

  // A picture's default alt text comes from the media library, where any uploader can type it. It becomes part of the Markdown, so the
  // characters that would end or change an image or link are dealt with whenever the editor writes it:
  //  - in Markdown mode the editor writes the Markdown itself, with a backslash before each of \ [ ] ( ) < > * _ and the backtick;
  //  - in Visual mode the editor's own serialiser writes it, and it doesn't treat a backslash safely, so those characters are removed.
  const MD_META = /[\\[\]()<>*_`]/g;
  const altForMarkdown = (alt) => String(alt || "").replace(/\s+/g, " ").trim().replace(MD_META, "\\$&");
  const altForVisual = (alt) => String(alt || "").replace(MD_META, " ").replace(/\s+/g, " ").trim();
  // Puts a picture in at the cursor, in whichever mode is open.
  function putImage(url, alt) {
    const text = alt || "Describe this image";
    if (editor.isMarkdownMode()) editor.replaceSelection(`![${altForMarkdown(text)}](${url})`);
    else editor.exec("addImage", { imageUrl: url, altText: altForVisual(text) || "Describe this image" });
  }

  // A link or image address that isn't http(s), mailto, tel or relative (javascript:, data:, vbscript:...) becomes "#".
  // Spaces, control characters and entity or %-encoding are looked through first. Code blocks are left alone.
  const decoder = document.createElement("textarea");
  function addressOk(raw) {
    let d = String(raw).trim().replace(/^<|>$/g, "");
    decoder.innerHTML = d;
    d = decoder.value;
    try {
      d = decodeURIComponent(d);
    } catch {}
    return SAFE_URL.test(d.replace(/[\u0000- \u007f-\u009f]+/g, ""));
  }
  function cleanLinks(md) {
    let fenced = false;
    return String(md)
      .split("\n")
      .map((line) => {
        if (/^\s{0,3}(```|~~~)/.test(line)) {
          fenced = !fenced;
          return line;
        }
        if (fenced) return line;
        return line
          .replace(/(\]\(\s*)(<[^>]*>|(?:[^\s()]|\([^\s()]*\))*)/g,(m, open, dest) => (addressOk(dest) ? m : `${open}#`))
          .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)/, (m, open, dest) => (addressOk(dest) ? m : `${open}#`));
      })
      .join("\n");
  }

  // Text the Visual editor can't read (an HTML comment, <?...?>, <!DOCTYPE>, CDATA) opens in Markdown mode, so a draft always opens.
  const original = String(field("body_md").value || "").replace(/\r\n?/g, "\n");
  const initialMd = cleanLinks(original);
  const oddHtml = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]/.test(initialMd);
  let startNote = "";
  if (oddHtml && mode === "wysiwyg") {
    mode = "markdown";
    startNote = "This text has HTML comments or similar, so it opened in Markdown mode.";
  }
  if (initialMd !== original) startNote = "Some link addresses weren’t safe, so they were replaced with #. Check the links, then save.";

  let changeTimer = 0;
  let editor = null;
  const onChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (editor.getMarkdown() !== savedMd) markDirty();
      updateCount();
    }, 250);
  };
  const makeEditor = (initialEditType) =>
    new window.ToastEditor({
      el: editArea,
      initialValue: initialMd,
      initialEditType,
      previewStyle: style === "markdown" ? "vertical" : "tab",
      hideModeSwitch: true,
      height: "auto",
      minHeight: "460px",
      usageStatistics: false,
      autofocus: false,
      theme: dark() ? "dark" : "light",
      placeholder: "Start writing…",
      customHTMLSanitizer: sanitize,
      toolbarItems: [["heading", "bold", "italic", "strike"], ["hr", "quote"], ["ul", "ol", "task"], ["table", "link"], ["code", "codeblock"]],
      hooks: {
        addImageBlobHook: (blob) => {
          uploadImage(blob).then((item) => {
            if (!item) return;
            putImage(item.url, item.alt || "");
            markDirty();
          });
        },
      },
      events: {
        // Switching modes also fires change, so compare with the last saved text (debounced: it serialises the document).
        change: onChange,
      },
    });
  // The last resort: a plain text box with the same few methods, so saving and deleting still work.
  function plainEditor() {
    const ta = document.createElement("textarea");
    ta.className = "input mono";
    ta.rows = 26;
    ta.style.width = "100%";
    ta.value = initialMd;
    ta.setAttribute("aria-label", "Text of the article (Markdown)");
    editArea.append(ta);
    ta.addEventListener("input", onChange);
    const noop = () => {};
    const put = (t) => ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, "end");
    return { getMarkdown: () => ta.value, setMarkdown: (v) => (ta.value = v), isMarkdownMode: () => true, changeMode: noop, focus: () => ta.focus(), exec: noop, insertText: put, replaceSelection: put, setSelection: noop, moveCursorToEnd: noop };
  }
  // If the editor won't build (for any reason), try again in Markdown mode, then fall back to a plain box. The page keeps working.
  try {
    editor = makeEditor(mode);
  } catch (err) {
    console.error(err);
    editArea.textContent = "";
    mode = "markdown";
    startNote = "The Visual editor couldn’t open this text, so it opened in Markdown mode.";
    try {
      editor = makeEditor("markdown");
    } catch (err2) {
      console.error(err2);
      editArea.textContent = "";
      editor = plainEditor();
      startNote = "The editor couldn’t start, so you’re working in a plain text box.";
    }
  }

  let savedMd = editor.getMarkdown();
  const modeBtns = $$(".ed-switch [data-mode]");
  function setMode(m, remember = true) {
    try {
      if (editor.getCurrentModeEditor && editor.isMarkdownMode() !== (m === "markdown")) editor.changeMode(m, true);
    } catch (err) {
      console.error(err);
      try {
        editor.changeMode("markdown", true);
      } catch {}
      m = "markdown";
      setStatus("The Visual editor couldn’t show this text, so it stays in Markdown mode.", true);
    }
    mode = m;
    for (const b of modeBtns) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    if (!remember || style !== "switch") return;
    try {
      localStorage.setItem("ed-mode", m);
    } catch {}
  }
  for (const b of modeBtns) b.addEventListener("click", () => setMode(b.dataset.mode));
  // A mode chosen by the page itself (because of what the text contains) isn't remembered as the person's own choice.
  setMode(mode, !startNote);
  if (startNote) setStatus(startNote, true);

  // Replaces the whole text, with unsafe link addresses neutralised. If the Visual editor can't take it, it moves to Markdown mode.
  function setBody(md) {
    const clean = cleanLinks(md);
    try {
      editor.setMarkdown(clean);
    } catch (err) {
      console.error(err);
      setMode("markdown", false);
      try {
        editor.setMarkdown(clean);
      } catch {}
    }
  }

  const countEl = $("#ed-count");
  function updateCount() {
    const words = (editor.getMarkdown().replace(/```[\s\S]*?```/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    countEl.textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"} · ${Math.max(1, Math.round(words / 220))} min read`;
  }
  updateCount();

  // Insert bar
  const insert = {
    image: () =>
      window.Admin.pickMedia?.((item) => {
        putImage(item.url, item.alt || "");
        markDirty();
      }),
    table: () => editor.exec("addTable", { rowCount: 3, columnCount: 3 }),
    code: () => {
      if (editor.isMarkdownMode()) editor.replaceSelection("\n```cpp\n// A short snippet that explains one step\n```\n");
      else editor.exec("codeBlock");
    },
    callout: () => {
      if (editor.isMarkdownMode()) editor.replaceSelection("\n> [!TIP]\n> Write the tip here.\n");
      else {
        editor.exec("blockQuote");
        editor.insertText("[!TIP] ");
      }
    },
    faq: () => {
      setBody(`${editor.getMarkdown().trimEnd()}\n\n## FAQ\n\n### Your first question?\n\nThe answer, in two or three sentences.\n`);
      editor.moveCursorToEnd();
    },
  };
  for (const b of $$("[data-insert]")) b.addEventListener("click", () => {
    insert[b.dataset.insert]?.();
    editor.focus?.();
  });
  for (const b of $$("[data-jump]")) b.addEventListener("click", () => byId(b.dataset.jump)?.scrollIntoView({ behavior: "smooth" }));

  // ---------- Title, URL and search preview ----------
  const title = $("#f-title");
  const slug = field("slug");
  const slugEcho = $("#slug-echo");
  let slugTouched = Boolean(slug.value) && (state !== "draft" || Boolean(id));
  const fitTitle = () => {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  };
  fitTitle();
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editor.focus?.();
    }
  });
  const serp = () => {
    $("#serp-title").textContent = field("seo_title")?.value || title.value || "Title";
    $("#serp-desc").textContent = field("excerpt")?.value || "Your meta description appears here.";
    $("#serp-url").textContent = `${data.urlPrefix}${slug.value || "…"}/`;
    slugEcho.textContent = slug.value || "…";
  };
  title.addEventListener("input", () => {
    fitTitle();
    if (!slugTouched) slug.value = slugify(title.value);
    serp();
  });
  slug.addEventListener("input", () => {
    slugTouched = true;
    serp();
  });
  for (const n of ["seo_title", "excerpt"]) field(n)?.addEventListener("input", serp);
  addEventListener("resize", fitTitle);

  // ---------- Feature image ----------
  const feature = $("#ed-feature");
  const featureId = field("feature_image_id");
  const showFeature = (item) => {
    featureId.value = item ? item.id : "";
    $(".ed-feature-fig", feature).hidden = !item;
    $(".ed-add-feature", feature).hidden = Boolean(item);
    if (item) {
      $(".ed-feature-fig img", feature).src = item.thumb || item.url;
      const alt = field("feature_image_alt");
      if (!alt.value && item.alt) alt.value = item.alt;
    }
    markDirty();
  };
  for (const b of $$("[data-feature-pick]", feature)) b.addEventListener("click", () => window.Admin.pickMedia?.(showFeature));
  $("[data-feature-clear]", feature).addEventListener("click", () => showFeature(null));

  // ---------- At a glance rows ----------
  const glance = $("#glance");
  function addGlance(k = "", v = "") {
    if (!glance) return;
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = '<input aria-label="Label" placeholder="Difficulty" maxlength="60"><input aria-label="Value" placeholder="Beginner" maxlength="200"><button type="button" class="btn btn-small btn-ghost" title="Remove row">✕</button>';
    const [a, b] = row.querySelectorAll("input");
    a.value = k;
    b.value = v;
    row.querySelector("button").addEventListener("click", () => {
      row.remove();
      markDirty();
    });
    glance.append(row);
  }
  for (const [k, v] of data.glance || []) addGlance(k, v);
  $("[data-add-glance]")?.addEventListener("click", () => {
    addGlance();
    glance.lastElementChild.querySelector("input").focus();
  });

  // ---------- Source code files ----------
  const srcList = $("#src-list");
  const srcTpl = byId("src-tpl");
  function addSource(f = { name: "", lang: "arduino", code: "" }) {
    if (!srcList) return;
    const node = srcTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('[data-k="name"]').value = f.name || "";
    node.querySelector('[data-k="lang"]').value = f.lang || "arduino";
    node.querySelector('[data-k="code"]').value = f.code || "";
    node.querySelector("[data-remove]").addEventListener("click", () => {
      if (node.querySelector('[data-k="code"]').value.trim() && !confirm(`Remove ${node.querySelector('[data-k="name"]').value || "this file"}?`)) return;
      node.remove();
      markDirty();
    });
    node.querySelector("[data-up]").addEventListener("click", () => {
      if (node.previousElementSibling) srcList.insertBefore(node, node.previousElementSibling);
      markDirty();
    });
    const nameInput = node.querySelector('[data-k="name"]');
    nameInput.addEventListener("change", () => {
      const ext = nameInput.value.split(".").pop().toLowerCase();
      const guess = { ino: "arduino", h: "cpp", hpp: "cpp", cpp: "cpp", c: "c", py: "python", js: "javascript", json: "json", html: "xml", css: "css", ini: "ini", yml: "yaml", yaml: "yaml", sh: "bash", md: "markdown", txt: "plaintext" }[ext];
      if (guess) node.querySelector('[data-k="lang"]').value = guess;
    });
    // Tab indents inside the code box instead of leaving it.
    node.querySelector('[data-k="code"]').addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    });
    srcList.append(node);
    return node;
  }
  for (const f of data.sourceFiles || []) addSource(f);
  $("[data-add-file]")?.addEventListener("click", () => {
    const n = srcList.children.length;
    addSource({ name: n ? "" : "main.ino", lang: n ? "cpp" : "arduino", code: "" }).querySelector(n ? '[data-k="name"]' : '[data-k="code"]').focus();
    markDirty();
  });

  // ---------- Downloads (PDF, STL, ZIP from the media library) ----------
  const dlList = $("#dl-list");
  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  function addDownload(f) {
    if (!dlList) return;
    const row = document.createElement("div");
    row.className = "dl-item";
    row.dataset.mediaId = f.media_id;
    row.innerHTML = '<span class="tag"></span><div><input class="input" aria-label="Button label" maxlength="80"><small></small></div><button type="button" class="btn btn-small btn-ghost" title="Remove">✕</button>';
    row.querySelector(".tag").textContent = (f.ext || "").toUpperCase();
    row.querySelector("input").value = f.label || "";
    row.querySelector("small").textContent = `${f.name || ""}${f.size ? ` · ${kb(f.size)}` : ""}`;
    row.querySelector("button").addEventListener("click", () => {
      row.remove();
      markDirty();
    });
    dlList.append(row);
  }
  for (const f of data.downloads || []) addDownload(f);
  $("[data-add-download]")?.addEventListener("click", () =>
    window.Admin.pickMedia?.((item) => {
      const label = item.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\b\w/, (c) => c.toUpperCase());
      addDownload({ media_id: item.id, label, name: item.name, ext: item.ext, size: item.size });
      markDirty();
    }, { kind: "file" }),
  );

  // Any other change in the form marks it dirty.
  root.addEventListener("input", (e) => {
    if (e.target.closest(".ed-drawer, .ed-feature, .ed-section, .ed-title")) markDirty();
  });
  root.addEventListener("change", (e) => {
    if (e.target.closest(".ed-drawer, .ed-section")) markDirty();
  });

  // ---------- Saving ----------
  // The save times the page was loaded with (updated after every save): the server refuses a save that comes after someone else's.
  let version = data.version || null;
  // A field this page doesn't have (a page has no category, a contributor has no "noindex") is left out, not sent as empty,
  // and the server keeps what is stored for a field that is left out.
  function collect() {
    const v = (n) => field(n)?.value;
    const on = (n) => (field(n) ? Boolean(field(n).checked) : undefined);
    return {
      id,
      ...(id && version ? { loaded_modified_at: version.modified, loaded_updated_at: version.updated } : {}),
      type,
      title: title.value,
      slug: slug.value,
      body_md: cleanLinks(editor.getMarkdown()),
      excerpt: v("excerpt"),
      seo_title: v("seo_title"),
      short_title: v("short_title"),
      canonical_url: v("canonical_url"),
      noindex: on("noindex"),
      og_title: v("og_title"),
      og_description: v("og_description"),
      og_image_id: v("og_image_id"),
      feature_image_id: featureId.value,
      feature_image_alt: v("feature_image_alt"),
      feature_image_caption: v("feature_image_caption"),
      category_id: v("category_id"),
      tags: v("tags"),
      author_id: v("author_id"),
      featured: on("featured"),
      level: v("level"),
      quick_answer: v("quick_answer"),
      at_a_glance: glance ? $$(".kv-row", glance).map((r) => [...r.querySelectorAll("input")].map((i) => i.value.trim())).filter(([k, val]) => k && val) : undefined,
      tested_with: v("tested_with"),
      video_youtube: v("video_youtube"),
      video_title: v("video_title"),
      video_description: v("video_description"),
      video_upload: v("video_upload"),
      video_duration: v("video_duration"),
      chapters: v("chapters"),
      source_files: srcList ? $$(".src-item", srcList).map((n) => ({ name: n.querySelector('[data-k="name"]').value.trim(), lang: n.querySelector('[data-k="lang"]').value, code: n.querySelector('[data-k="code"]').value })).filter((f) => f.name || f.code.trim()) : undefined,
      download_github: v("download_github"),
      download_files: dlList ? $$(".dl-item", dlList).map((r) => ({ media_id: Number(r.dataset.mediaId), label: r.querySelector("input").value.trim() })) : undefined,
      comments_enabled: on("comments_enabled"),
      published_at: v("published_at"),
      updated_at: v("updated_at"),
      keep_updated_date: on("keep_updated_date"),
    };
  }

  const btnSave = $("#btn-save");
  const btnPublish = $("#btn-publish");
  const btnUnpublish = $("#btn-unpublish");
  const btnView = $("#btn-view");
  function afterSave(p) {
    const isNew = !id;
    id = p.id;
    root.dataset.id = String(p.id);
    state = p.state;
    root.dataset.state = state;
    stateEl.textContent = state[0].toUpperCase() + state.slice(1);
    stateEl.dataset.state = state;
    if (isNew || location.pathname !== p.editUrl) history.replaceState(null, "", p.editUrl);
    $("#ed-danger").hidden = false;
    if (btnPublish) btnPublish.hidden = state !== "draft";
    if (btnUnpublish) btnUnpublish.hidden = state === "draft";
    btnSave.textContent = state === "draft" ? "Save draft" : "Update";
    btnView.hidden = state !== "published";
    btnView.href = p.url;
    if (slug.value !== p.slug) {
      slug.value = p.slug;
      serp();
    }
    slugTouched = true;
    if (p.version) version = p.version;
    // A date typed on a draft that the server didn't keep (only editors can date a draft) stays in the box until Publish.
    if (field("published_at") && (p.published_at || state !== "draft")) field("published_at").value = p.published_at || "";
    if (field("updated_at") && p.updated_at) field("updated_at").value = p.updated_at;
    if (field("keep_updated_date")) field("keep_updated_date").checked = false;
  }

  const checksEl = $("#ed-checks");
  function showChecks(checks, force = false) {
    if (!checks) return;
    const { errors = [], warnings = [] } = checks;
    if (!errors.length && !warnings.length) {
      checksEl.hidden = true;
      return;
    }
    if (!force && checksEl.hidden && !errors.length) return;
    const item = (c) => {
      const li = document.createElement("li");
      li.append(`${c.label || c.field}: ${c.message} `);
      const b = document.createElement("button");
      b.type = "button";
      if (c.field === "body_md" && c.line) {
        b.textContent = `Go to line ${c.line}`;
        b.addEventListener("click", () => {
          setMode("markdown");
          editor.setSelection([c.line, 1], [c.line, 1]);
          editor.focus();
        });
      } else {
        const target = c.field === "source_files" ? $("#ed-source") : c.field === "downloads" ? $("#ed-downloads") : field(c.field) || (c.field === "title" ? title : null);
        if (!target) return li;
        b.textContent = "Fix";
        b.addEventListener("click", () => {
          const d = target.closest("details");
          if (d) d.open = true;
          if (target.closest(".ed-drawer")) $("#ed-drawer").hidden = false;
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.focus?.();
        });
      }
      li.append(b);
      return li;
    };
    checksEl.textContent = "";
    if (errors.length) {
      const h = document.createElement("h2");
      h.textContent = `${errors.length} ${errors.length === 1 ? "thing blocks" : "things block"} publishing`;
      const ul = document.createElement("ul");
      ul.className = "errs";
      errors.forEach((c) => ul.append(item(c)));
      checksEl.append(h, ul);
    }
    if (warnings.length) {
      const h = document.createElement("h2");
      h.textContent = `${warnings.length} ${warnings.length === 1 ? "suggestion" : "suggestions"}`;
      const ul = document.createElement("ul");
      ul.className = "warns";
      warnings.forEach((c) => ul.append(item(c)));
      checksEl.append(h, ul);
    }
    checksEl.hidden = false;
  }

  // Set when the server says someone else saved the post first: nothing is saved (or autosaved) again until the page is reloaded.
  let stale = false;
  async function save(intent) {
    if (saving) return;
    if (stale) {
      setStatus("Someone else saved this post a moment ago. Copy your changes, reload, and apply them again.", true);
      return;
    }
    saving = true;
    setStatus(intent === "publish" ? "Publishing…" : intent === "unpublish" ? "Unpublishing…" : "Saving…");
    try {
      const res = await api(id ? `/api/posts/${id}` : "/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...collect(), intent }) });
      if (res.post && (res.ok !== false || res.saved)) afterSave(res.post);
      showChecks(res.checks, intent !== "autosave");
      if (res.ok === false) {
        if (res.saved) {
          dirty = false;
          savedMd = editor.getMarkdown();
        }
        setStatus(res.error || "Not saved", true);
      } else {
        dirty = false;
        savedMd = editor.getMarkdown();
        const when = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setStatus(intent === "publish" ? (state === "scheduled" ? "Scheduled" : "Published") : intent === "unpublish" ? "Unpublished: back to draft" : `Saved at ${when}`);
      }
    } catch (err) {
      if (err.status === 409) stale = true;
      setStatus(err.message, true);
    } finally {
      saving = false;
    }
  }
  btnSave.addEventListener("click", () => save("save"));
  btnPublish?.addEventListener("click", () => save("publish"));
  btnUnpublish?.addEventListener("click", () => {
    if (confirm(`Unpublish this ${type}? It goes back to draft and its page disappears from the site.`)) save("unpublish");
  });
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save("save");
    }
  });
  setInterval(() => {
    if (dirty && !saving && !stale && state === "draft" && (title.value.trim() || editor.getMarkdown().trim())) save("autosave");
  }, 15000);
  addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  // Preview opens the full page, unsaved changes included, in a new tab.
  $("#btn-preview").addEventListener("click", () => {
    const form = byId("preview-form");
    form.querySelector("[name=payload]").value = JSON.stringify(collect());
    form.submit();
  });

  // Delete
  $('[data-action="delete"]')?.addEventListener("click", async () => {
    if (!confirm(`Delete this ${type} for good? ${state === "published" ? "Its URL will tell search engines it’s gone." : ""}`)) return;
    try {
      const res = await api(`/api/posts/${id}/delete`, { method: "POST" });
      dirty = false;
      location.href = res.redirect || `${A}/posts`;
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // History
  const history_ = $("#ed-history");
  history_?.addEventListener("toggle", async () => {
    if (!history_.open || !id) return;
    const list = $("#revisions");
    list.innerHTML = '<li class="meta">Loading…</li>';
    try {
      const { revisions } = await api(`/api/posts/${id}/revisions`);
      list.textContent = "";
      if (!revisions.length) list.innerHTML = '<li class="meta">No earlier versions yet.</li>';
      for (const r of revisions) {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${new Date(r.created_at).toLocaleString()}${r.author_name ? ` · ${r.author_name}` : ""}`;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-small";
        b.textContent = "Restore";
        b.addEventListener("click", async () => {
          if (!confirm("Replace the title and text with this version? Save afterwards to keep it.")) return;
          const rev = await api(`/api/posts/${id}/revisions/${r.id}`);
          title.value = rev.title;
          fitTitle();
          setBody(rev.body_md);
          markDirty();
          setStatus("Version restored: save to keep it");
        });
        li.append(label, b);
        // Editors can delete one older version (for example one that holds a pasted password).
        if (data.canPurge) {
          const d = document.createElement("button");
          d.type = "button";
          d.className = "btn btn-small btn-danger";
          d.textContent = "Delete";
          d.addEventListener("click", async () => {
            if (!confirm("Delete this older version for good? This can’t be undone.")) return;
            try {
              await api(`/api/posts/${id}/revisions/${r.id}/delete`, { method: "POST" });
              li.remove();
              setStatus("Older version deleted");
            } catch (err) {
              setStatus(err.message, true);
            }
          });
          li.append(d);
        }
        list.append(li);
      }
    } catch (err) {
      list.innerHTML = "";
      setStatus(err.message, true);
    }
  });

  // Delete every older version (the newest, which is the text as saved now, stays).
  $("#btn-purge-revisions")?.addEventListener("click", async () => {
    if (!id) return;
    if (!confirm("Delete ALL older versions of this " + type + " for good? Only the newest one stays. This can’t be undone.")) return;
    try {
      const res = await api(`/api/posts/${id}/revisions/purge`, { method: "POST" });
      $("#revisions").innerHTML = '<li class="meta">No earlier versions yet.</li>';
      setStatus(`${res.removed} older ${res.removed === 1 ? "version" : "versions"} deleted`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // Settings drawer
  const drawer = $("#ed-drawer");
  const btnSettings = $("#btn-settings");
  const narrow = matchMedia("(max-width: 1100px)");
  const setDrawer = (open) => {
    drawer.hidden = !open;
    btnSettings.setAttribute("aria-expanded", String(open));
  };
  let drawerPref = null;
  try {
    drawerPref = localStorage.getItem("ed-drawer");
  } catch {}
  setDrawer(narrow.matches ? false : drawerPref !== "closed");
  btnSettings.addEventListener("click", () => {
    const open = drawer.hidden;
    setDrawer(open);
    try {
      localStorage.setItem("ed-drawer", open ? "open" : "closed");
    } catch {}
  });
  $("[data-close-drawer]").addEventListener("click", () => setDrawer(false));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && narrow.matches && !drawer.hidden) setDrawer(false);
  });

  serp();
  if (!id && !title.value) title.focus();
})();
