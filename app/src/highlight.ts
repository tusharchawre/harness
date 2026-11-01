// Code highlighting with Shiki. Colours follow the design canvas (Xcode-style: pink keywords,
// red strings, yellow numbers); everything else stays --code-text. Both themes are emitted as
// --shiki-dark / --shiki-light vars and styles.css picks one per appearance.
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

const theme = (name: string, fg: string, c: { keyword: string; string: string; number: string; comment: string }): ThemeRegistration => ({
  name,
  type: name.endsWith("dark") ? "dark" : "light",
  fg,
  bg: "transparent",
  settings: [
    { settings: { foreground: fg } },
    { scope: ["keyword", "storage", "constant.language", "variable.language", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: c.keyword } },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: fg } },
    { scope: ["string", "punctuation.definition.string", "string.regexp"], settings: { foreground: c.string } },
    { scope: ["constant.numeric"], settings: { foreground: c.number } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.comment } },
  ],
});

const dark = theme("harness-dark", "#E5E5EA", { keyword: "#FF7AB2", string: "#FC6A5D", number: "#D0BF69", comment: "#8D8D93" });
const light = theme("harness-light", "#1D1D1F", { keyword: "#AD3DA4", string: "#D12F1B", number: "#272AD8", comment: "#707F8C" });

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();
const cache = new Map<string, string>();
const key = (code: string, lang: string) => lang + "\0" + code;

export const canHighlight = (lang: string | undefined): lang is string => !!lang && lang in bundledLanguages;

// Already-highlighted HTML, so a block that remounts (stream → saved message) doesn't flash plain.
export const cachedHighlight = (code: string, lang: string | undefined) => (lang ? cache.get(key(code, lang)) ?? null : null);

export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  if (!canHighlight(lang)) return null;
  const hit = cache.get(key(code, lang));
  if (hit) return hit;
  const h = await (highlighter ??= createHighlighterCore({ themes: [dark, light], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));
  if (!loaded.has(lang)) loaded.set(lang, h.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]));
  await loaded.get(lang);
  const html = h.codeToHtml(code, { lang, themes: { dark: "harness-dark", light: "harness-light" }, defaultColor: false });
  cache.set(key(code, lang), html);
  return html;
}
