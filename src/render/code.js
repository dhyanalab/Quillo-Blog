// Source code: syntax highlighting (highlight.js, BSD-3-Clause) and ZIP downloads of a post's files.
import zlib from "node:zlib";
import hljs from "highlight.js/lib/core";
import arduino from "highlight.js/lib/languages/arduino";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { escapeHtml } from "./util.js";

for (const [name, def] of Object.entries({ arduino, bash, c, cpp, css, ini, javascript, json, markdown, python, xml, yaml })) hljs.registerLanguage(name, def);

// Languages offered in the editor, with the label readers see.
export const LANGUAGES = {
  arduino: "Arduino",
  cpp: "C++",
  c: "C",
  python: "Python",
  javascript: "JavaScript",
  json: "JSON",
  xml: "HTML",
  css: "CSS",
  bash: "Shell",
  ini: "INI",
  yaml: "YAML",
  markdown: "Markdown",
  plaintext: "Plain text",
};
const ALIASES = { ino: "arduino", h: "cpp", hpp: "cpp", cc: "cpp", py: "python", micropython: "python", js: "javascript", html: "xml", htm: "xml", sh: "bash", shell: "bash", cfg: "ini", toml: "ini", yml: "yaml", md: "markdown", txt: "plaintext", text: "plaintext" };

// Picks a highlight.js language from a fence label or a file name ("main.ino" -> arduino).
// Labels come from the page, so lookups use own properties only ("constructor" and "__proto__" are not languages).
const known = (key) => Object.hasOwn(LANGUAGES, key) || Object.hasOwn(ALIASES, key);
const resolve = (key) => (Object.hasOwn(ALIASES, key) ? ALIASES[key] : key);

export function langFor(label = "", fileName = "") {
  const want = String(label || "").toLowerCase().trim();
  if (want && known(want)) return resolve(want);
  const ext = String(fileName).toLowerCase().split(".").pop();
  if (fileName && ext && known(ext)) return resolve(ext);
  return "plaintext";
}

export const langLabel = (lang) => (Object.hasOwn(LANGUAGES, lang) ? LANGUAGES[lang] : "Code");

// Code longer than this is shown as plain text: highlighting it would keep the server busy for no real gain. One article's
// code blocks (and one post's source files) share a total of MAX_HIGHLIGHT_TOTAL characters; past that the rest is plain text.
const MAX_HIGHLIGHT = 20_000;
export const MAX_HIGHLIGHT_TOTAL = 100_000;

// Highlighted HTML (spans with hljs-* classes). Plain text is escaped only. Never throws.
export function highlight(code, lang) {
  try {
    const text = String(code ?? "");
    if (!lang || lang === "plaintext" || text.length > MAX_HIGHLIGHT || !Object.hasOwn(LANGUAGES, lang) || !hljs.getLanguage(lang)) return escapeHtml(text);
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

// A ZIP archive of text files (deflate), built in memory. `files` = [{name, code}], `folder` prefixes every path.
export function zipFiles(files, folder = "") {
  const local = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const f of files) {
    const name = Buffer.from(`${folder ? `${folder}/` : ""}${f.name}`, "utf8");
    const data = Buffer.from(f.code, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Safe file names for source files: letters, digits, dot, dash, underscore; no folders.
export const isSourceName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) && !name.includes("..");
