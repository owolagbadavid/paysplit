export interface EmailContent {
  subject: string;
  heading: string;
  paragraphs: string[];
  rows?: [string, string][];
  code?: string;
  button?: { label: string; url: string };
  footnote?: string;
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Renders one layout to HTML and plain text. Every value is escaped, including names people typed. */
export function renderEmail(content: EmailContent): { html: string; text: string } {
  const rows = content.rows?.length
    ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:16px 0">${content.rows
        .map(
          ([k, v]) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid #eef0f3;color:#6b7280">${escape(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eef0f3;text-align:right;font-weight:600">${escape(v)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const code = content.code
    ? `<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:20px 0">${escape(content.code)}</p>`
    : '';
  const button = content.button
    ? `<p style="margin:24px 0"><a href="${escape(content.button.url)}" style="background:#1d6fc4;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escape(content.button.label)}</a></p>`
    : '';
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f5f8fc;font-family:Inter,Arial,sans-serif;color:#111">
<div style="max-width:520px;margin:0 auto;padding:32px 16px"><div style="background:#fff;border:1px solid #eef0f3;border-radius:16px;padding:28px">
<p style="font-weight:700;margin:0 0 20px">Paysplit</p><h1 style="font-size:20px;margin:0 0 12px">${escape(content.heading)}</h1>
${content.paragraphs.map((p) => `<p style="line-height:1.55;margin:0 0 12px">${escape(p)}</p>`).join('')}${code}${rows}${button}
${content.footnote ? `<p style="color:#6b7280;font-size:13px;line-height:1.5;margin:20px 0 0">${escape(content.footnote)}</p>` : ''}
</div></div></body></html>`;
  const text = [
    content.heading,
    '',
    ...content.paragraphs,
    ...(content.code ? ['', content.code] : []),
    ...(content.rows?.length ? ['', ...content.rows.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(content.button ? ['', `${content.button.label}: ${content.button.url}`] : []),
    ...(content.footnote ? ['', content.footnote] : []),
  ].join('\n');
  return { html, text };
}
