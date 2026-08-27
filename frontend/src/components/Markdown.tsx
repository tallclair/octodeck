import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Root, Node, Parent, Html } from 'mdast';
import { stripHtmlComments } from '../utils/text';

interface MarkdownProps {
    content: string;
    className?: string;
    size?: 'normal' | 'compact';
}

function isHtmlComment(node: Node): boolean {
    return (
        node.type === 'html' &&
        'value' in node &&
        typeof (node as Html).value === 'string' &&
        (node as Html).value.trim().startsWith('<!--')
    );
}

function removeHtmlComments(node: Node) {
    if ('children' in node && Array.isArray((node as Parent).children)) {
        const parent = node as Parent;
        parent.children = parent.children.filter((child) => !isHtmlComment(child));
        for (const child of parent.children) {
            removeHtmlComments(child);
        }
    }
}

function remarkStripHtmlComments() {
    return (tree: Root) => {
        removeHtmlComments(tree);
    };
}

export const Markdown: React.FC<MarkdownProps> = ({ content, className = '', size = 'normal' }) => {
    if (!stripHtmlComments(content).trim()) {
        return null;
    }

    const sizeClass = size === 'compact' ? 'prose-compact' : 'prose-normal';
    return (
        <div className={`prose prose-slate dark:prose-invert prose-a:text-blue-600 dark:prose-a:text-blue-400 hover:prose-a:underline ${sizeClass} max-w-none break-words ${className}`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkStripHtmlComments]}
                components={{
                    a: ({ href, children, ...props }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                            {...props}
                        >
                            {children}
                        </a>
                    ),
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
};
