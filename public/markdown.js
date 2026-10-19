// Минимальный безопасный рендерер Markdown: весь текст экранируется до разметки,
// поэтому HTML из ответа модели никогда не попадает на страницу как код.
(function () {
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(text) {
    const codes = [];
    let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/~~(.+?)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  function render(src) {
    const lines = src.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Блок кода (в т.ч. незакрытый — пока ответ ещё стримится)
      const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(
          `<pre><div class="code-head"><span>${escapeHtml(lang || "код")}</span>` +
            `<button type="button" data-copy-code>Копировать</button></div>` +
            `<code>${escapeHtml(body.join("\n"))}</code></pre>`
        );
        continue;
      }

      if (!line.trim()) { i++; continue; }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const n = heading[1].length;
        out.push(`<h${n}>${inline(heading[2])}</h${n}>`);
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${render(body.join("\n"))}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
            rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
            `</tbody></table>`
        );
        continue;
      }

      const listMatch = line.match(/^\s*([-*+]|\d+[.)])\s+/);
      if (listMatch) {
        const ordered = /\d/.test(listMatch[1]);
        const itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(itemRe);
          if (m) { items.push(m[1]); i++; continue; }
          // продолжение пункта списка с отступом
          if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
          break;
        }
        const start = ordered ? parseInt(listMatch[1], 10) : 1;
        const tag = ordered ? "ol" : "ul";
        const attr = ordered && start !== 1 ? ` start="${start}"` : "";
        out.push(`<${tag}${attr}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
        continue;
      }

      const para = [];
      while (
        i < lines.length && lines[i].trim() &&
        !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])
      ) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return out.join("");
  }

  window.renderMarkdown = render;
})();
