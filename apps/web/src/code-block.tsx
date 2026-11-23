import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

type CodeNode = {
  type?: string;
  value?: string;
  properties?: { className?: string | string[] };
  children?: CodeNode[];
};

function textOf(node: CodeNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  return (node.children || []).map(textOf).join('');
}

export function CodeBlock({ node }: { node?: CodeNode }) {
  const codeNode = node?.children?.find((child) => child.type === 'element');
  const code = textOf(codeNode || node);
  const className = codeNode?.properties?.className;
  const classes = Array.isArray(className) ? className : [className || ''];
  const language = classes.find((name) => name.startsWith('language-'))?.slice(9) || '';
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span className="code-block-language">{language || 'Code'}</span>
        <button
          type="button"
          className="code-block-copy"
          aria-label={copied ? 'Code copied' : 'Copy code'}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setCopyError(false);
            } catch {
              setCopied(false);
              setCopyError(true);
            }
          }}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <span className="code-block-status" role="status">
        {copied ? 'Code copied to clipboard' : ''}
      </span>
      {copyError && (
        <span className="code-block-copy-error" role="status">
          Copy unavailable. Select the code to copy it.
        </span>
      )}
      <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code'}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
