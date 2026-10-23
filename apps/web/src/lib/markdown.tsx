import { marked } from "marked";
import DOMPurify from "dompurify";
import { createMemo } from "solid-js";

marked.setOptions({ gfm: true, breaks: true });

/** Markdown is untrusted input (agent output, repo docs, pasted text). */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source ?? "") as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function Markdown(props: { content: string; class?: string }) {
  const html = createMemo(() => renderMarkdown(props.content));
  return <div class={props.class ?? "msg-body"} innerHTML={html()} />;
}
