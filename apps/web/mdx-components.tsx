import type { MDXComponents } from "mdx/types";

/**
 * House type for docs prose (SPEC §9 branding: PAPER/INK/AMBER, 0-2px
 * radius, no gradients/glow/dark chrome — apps/web/app/globals.css defines
 * the tokens these classes reference). Required by @next/mdx's App Router
 * integration — this file's default export wires every `.mdx` route.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props) => <h1 className="mb-6 mt-2 text-3xl font-semibold tracking-tight text-ink" {...props} />,
    h2: (props) => (
      <h2
        className="mb-4 mt-10 border-t border-rule pt-6 text-xl font-semibold tracking-tight text-ink first:mt-0 first:border-t-0 first:pt-0"
        {...props}
      />
    ),
    h3: (props) => <h3 className="mb-2 mt-6 text-base font-semibold text-ink" {...props} />,
    p: (props) => <p className="mb-4 leading-7 text-ink/90" {...props} />,
    ul: (props) => <ul className="mb-4 list-disc space-y-1 pl-6 text-ink/90" {...props} />,
    ol: (props) => <ol className="mb-4 list-decimal space-y-1 pl-6 text-ink/90" {...props} />,
    li: (props) => <li className="leading-7" {...props} />,
    a: (props) => <a className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber" {...props} />,
    strong: (props) => <strong className="font-semibold text-ink" {...props} />,
    blockquote: (props) => (
      <blockquote className="mb-4 border-l-2 border-amber pl-4 italic text-ink/80" {...props} />
    ),
    code: (props) => (
      <code className="rounded-none bg-ink/5 px-1.5 py-0.5 font-mono text-[0.85em] text-ink" {...props} />
    ),
    pre: (props) => (
      <pre
        className="mb-4 overflow-x-auto border border-rule bg-ink px-4 py-3 font-mono text-[0.85em] leading-6 text-paper [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-paper"
        {...props}
      />
    ),
    table: (props) => (
      <div className="mb-4 overflow-x-auto border border-rule">
        <table className="w-full border-collapse text-left text-sm" {...props} />
      </div>
    ),
    thead: (props) => <thead className="border-b border-rule bg-ink/5" {...props} />,
    th: (props) => <th className="px-3 py-2 font-semibold text-ink" {...props} />,
    td: (props) => <td className="border-t border-rule px-3 py-2 align-top text-ink/90" {...props} />,
    hr: (props) => <hr className="my-8 border-rule" {...props} />,
    ...components,
  };
}
