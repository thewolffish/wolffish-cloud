"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

const components: Components = {
  h1: (props) => <h1 className="text-3xl font-bold text-white mt-10 mb-4" {...props} />,
  h2: (props) => <h2 className="text-2xl font-bold text-white mt-8 mb-3" {...props} />,
  h3: (props) => <h3 className="text-xl font-semibold text-white mt-6 mb-2" {...props} />,
  p: (props) => <p className="text-white/70 leading-relaxed mb-4" {...props} />,
  ul: (props) => <ul className="list-disc list-inside text-white/70 mb-4 space-y-1" {...props} />,
  ol: (props) => <ol className="list-decimal list-inside text-white/70 mb-4 space-y-1" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  strong: (props) => <strong className="text-white font-semibold" {...props} />,
  a: (props) => <a className="text-blue-400 underline hover:text-blue-300" {...props} />,
  code: ({ children, className, ...props }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className="text-sm font-mono text-white/80" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm font-mono text-white/80" {...props}>
        {children}
      </code>
    );
  },
  pre: (props) => (
    <pre className="bg-white/5 border border-white/10 rounded-xl p-4 overflow-x-auto mb-4" {...props} />
  ),
  blockquote: (props) => (
    <blockquote className="border-s-4 border-blue-400/40 ps-4 italic text-white/60 my-4" {...props} />
  ),
  hr: () => <hr className="border-white/10 my-8" />,
};

export default function Markdown({ content }: { content: string }) {
  return <ReactMarkdown components={components}>{content}</ReactMarkdown>;
}
