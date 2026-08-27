import { render, screen } from '@testing-library/react';
import { Markdown } from '../Markdown';
import { describe, it, expect } from 'vitest';

describe('Markdown Component', () => {
    it('renders basic text and headings', () => {
        const md = '# Title\n\nSome **bold** and *italic* text.';
        render(<Markdown content={md} />);

        const heading = screen.getByRole('heading', { level: 1 });
        expect(heading.textContent).toBe('Title');
        expect(screen.getByText(/Some/)).toBeDefined();
        expect(screen.getByText('bold')).toBeDefined();
        expect(screen.getByText('italic')).toBeDefined();
    });

    it('renders links with target="_blank" and rel="noopener noreferrer"', () => {
        const md = 'Check out [OctoDeck](https://github.com/tallclair/octodeck)!';
        render(<Markdown content={md} />);

        const link = screen.getByRole('link', { name: 'OctoDeck' });
        expect(link).toBeDefined();
        expect(link.getAttribute('href')).toBe('https://github.com/tallclair/octodeck');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('renders inline code and code blocks', () => {
        const md = 'Here is `inline code` and:\n\n```go\nfunc main() {}\n```';
        render(<Markdown content={md} />);

        expect(screen.getByText('inline code')).toBeDefined();
        expect(screen.getByText('func main() {}')).toBeDefined();
    });

    it('renders lists and GFM task lists', () => {
        const md = '- Item 1\n- Item 2\n- [x] Done task\n- [ ] Open task';
        render(<Markdown content={md} />);

        expect(screen.getByText('Item 1')).toBeDefined();
        expect(screen.getByText('Item 2')).toBeDefined();
        expect(screen.getByText('Done task')).toBeDefined();
        expect(screen.getByText('Open task')).toBeDefined();
    });

    it('renders GFM tables', () => {
        const md = '| Col 1 | Col 2 |\n|---|---|\n| Val 1 | Val 2 |';
        render(<Markdown content={md} />);
        expect(screen.getByText('Col 1')).toBeDefined();
        expect(screen.getByText('Val 1')).toBeDefined();
    });

    it('does not render HTML comments', () => {
        const md = 'Hello <!-- this is a comment --> world\n\n<!--\nmultiline comment\n-->\n\nVisible paragraph';
        const { container } = render(<Markdown content={md} />);
        expect(container.textContent).toContain('Hello');
        expect(container.textContent).toContain('world');
        expect(container.textContent).toContain('Visible paragraph');
        expect(container.textContent).not.toContain('this is a comment');
        expect(container.textContent).not.toContain('multiline comment');
        expect(container.innerHTML).not.toContain('this is a comment');
    });

    it('returns null when content only consists of HTML comments and whitespace', () => {
        const md = '<!-- only comments here -->\n\n<!--\nanother comment\n-->';
        const { container } = render(<Markdown content={md} />);
        expect(container.firstChild).toBeNull();
    });

    it('preserves HTML comments inside code blocks and inline code', () => {
        const md = 'Here is inline: `<!-- inline code comment -->` and block:\n\n```html\n<!-- code block comment -->\n```';
        const { container } = render(<Markdown content={md} />);
        expect(container.textContent).toContain('<!-- inline code comment -->');
        expect(container.textContent).toContain('<!-- code block comment -->');
    });
});
