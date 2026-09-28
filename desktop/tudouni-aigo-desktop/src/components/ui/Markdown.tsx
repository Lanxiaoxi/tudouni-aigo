import { Fragment, type ReactNode } from 'react';

/**
 * 极简 Markdown 渲染。
 *
 * 只覆盖模型回答里真正会出现的语法：标题、有序/无序列表、围栏代码、
 * 行内代码、粗体、斜体、链接、引用、分隔线、段落。
 * 刻意不引第三方 md 库 —— 少一个依赖，也不会渲染出设计系统之外的样式。
 */

/* ---------------- 行内 ---------------- */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;

  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (mm) {
        out.push(
          <a key={key} href={mm[2]} target="_blank" rel="noreferrer noopener">
            {mm[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    }
    last = m.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ---------------- 块 ---------------- */

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let i = 0;
  let key = 0;

  const isFence = (l: string) => /^```/.test(l.trim());
  const isUl = (l: string) => /^\s*[-*+]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
  const isHr = (l: string) => /^\s*(-{3,}|\*{3,})\s*$/.test(l);
  const isQuote = (l: string) => /^\s*>\s?/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码
    if (isFence(line)) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳掉收尾 ```
      blocks.push(
        <pre key={`b${key++}`}>
          <code data-lang={lang}>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 分隔线
    if (isHr(line)) {
      blocks.push(<hr key={`b${key++}`} />);
      i += 1;
      continue;
    }

    // 标题
    if (isHeading(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line)!;
      const level = Math.min(m[1].length, 3);
      const content = renderInline(m[2], `b${key}`);
      const k = `b${key++}`;
      if (level === 1) blocks.push(<h1 key={k}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={k}>{content}</h2>);
      else blocks.push(<h3 key={k}>{content}</h3>);
      i += 1;
      continue;
    }

    // 引用
    if (isQuote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote key={`b${key++}`}>
          {renderInline(buf.join(' '), `b${key}`)}
        </blockquote>,
      );
      continue;
    }

    // 无序列表
    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={`b${key++}`}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `b${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`b${key++}`}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `b${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 段落：吃到空行或下一个块起始
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !isQuote(lines[i]) &&
      !isHr(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`b${key++}`}>
        {buf.map((l, idx) => (
          <Fragment key={idx}>
            {idx > 0 ? ' ' : null}
            {renderInline(l, `b${key}-${idx}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
