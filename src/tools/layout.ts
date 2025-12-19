/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { zod } from '../third_party/index.js';

import { ToolCategory } from './categories.js';
import { defineTool, timeoutSchema } from './ToolDefinition.js';

export const selectActivePage = defineTool({
    name: 'select_active_page',
    description: 'Automatically selects the first page that is currently visible (active) on the screen. Useful for identifying the main webview in a multi-webview app.',
    annotations: { category: ToolCategory.NAVIGATION, readOnlyHint: false },
    schema: {},
    handler: async (_request, response, context) => {
        let selectedPageUrl = '';

        for (let i = 0; ; i++) {
            try {
                const page = context.getPageByIdx(i);
                const isVisible = await page.evaluate(() => document.visibilityState === 'visible');
                if (isVisible) {
                    context.selectPage(page);
                    selectedPageUrl = page.url();
                    break;
                }
            } catch (e) {
                // Ignore pages that are closed or detached during check
                break;
            }
        }

        if (selectedPageUrl) {
            response.appendResponseLine(`Successfully selected active page: ${selectedPageUrl}`);
        } else {
            response.appendResponseLine('No active (visible) page found to select.');
        }
    },
});

export const scrollElement = defineTool({
    name: 'scroll_element',
    description: 'Scrolls the window or a specific element to a position. Returns the new scroll position to verify movement.',
    annotations: { category: ToolCategory.INPUT, readOnlyHint: false },
    schema: {
        selector: zod.string().optional().describe('CSS selector of the element to scroll. If omitted, scrolls the main window.'),
        x: zod.number().optional().describe('Absolute X pixel position to scroll to.'),
        y: zod.number().optional().describe('Absolute Y pixel position to scroll to.'),
        deltaX: zod.number().optional().describe('Relative pixels to scroll horizontally (e.g., 100 or -100).'),
        deltaY: zod.number().optional().describe('Relative pixels to scroll vertically.'),
        behavior: zod.enum(['auto', 'smooth']).optional().default('auto'),
    },
    handler: async (request, response, context) => {
        const page = context.getSelectedPage();
        const { selector, x, y, deltaX, deltaY, behavior } = request.params;

        try {
            const result = await page.evaluate((args) => {
                let target: Element | Window = window;
                let tagName = 'WINDOW';

                if (args.selector) {
                    const el = document.querySelector(args.selector);
                    if (!el) return { error: `Element not found: ${args.selector}` };
                    target = el;
                    tagName = el.tagName;
                }

                // Determine current position
                const currentX = target instanceof Window ? target.scrollX : target.scrollLeft;
                const currentY = target instanceof Window ? target.scrollY : target.scrollTop;

                // Calculate new position
                let newX = args.x !== undefined ? args.x : currentX + (args.deltaX || 0);
                let newY = args.y !== undefined ? args.y : currentY + (args.deltaY || 0);

                // Perform Scroll
                target.scrollTo({ left: newX, top: newY, behavior: args.behavior });

                // Get updated metrics to verify
                const finalX = target instanceof Window ? target.scrollX : target.scrollLeft;
                const finalY = target instanceof Window ? target.scrollY : target.scrollTop;
                const maxX = target instanceof Window
                    ? document.documentElement.scrollWidth - window.innerWidth
                    : (target as Element).scrollWidth - (target as Element).clientWidth;
                const maxY = target instanceof Window
                    ? document.documentElement.scrollHeight - window.innerHeight
                    : (target as Element).scrollHeight - (target as Element).clientHeight;

                return {
                    target: args.selector || 'window',
                    tagName,
                    didScroll: finalX !== currentX || finalY !== currentY,
                    position: { x: finalX, y: finalY },
                    bounds: { maxX, maxY }
                };
            }, { selector, x, y, deltaX, deltaY, behavior });

            response.appendResponseLine(JSON.stringify(result, null, 2));
        } catch (err) {
            // @ts-ignore
            response.appendResponseLine(`Error scrolling: ${err.message}`);
        }
    }
});

export const injectCustomCss = defineTool({
    name: 'inject_custom_css',
    description: 'Injects inline CSS into an element and returns the updated layout metrics to verify the fix (e.g., check if scrollWidth reduced).',
    annotations: { category: ToolCategory.DEBUGGING, readOnlyHint: false },
    schema: {
        selector: zod.string().describe('CSS selector of the element to modify.'),
        css: zod.record(zod.string()).describe('Key-value pairs of CSS properties to set (e.g. {"overflow": "hidden", "min-width": "0"}). Set value to "" to remove.'),
    },
    handler: async (request, response, context) => {
        const page = context.getSelectedPage();
        const { selector, css } = request.params;

        const result = await page.evaluate((args) => {
            const el = document.querySelector(args.selector) as HTMLElement;
            if (!el) return { error: `Element not found: ${args.selector}` };

            const prevStyle = { ...el.style };
            const prevRect = el.getBoundingClientRect();
            const prevScrollWidth = el.scrollWidth;

            // Apply new styles
            for (const [prop, value] of Object.entries(args.css)) {
                // Handle standard properties
                if (value === '') {
                    el.style.removeProperty(prop);
                } else {
                    el.style.setProperty(prop, value as string);
                }
            }

            // Force layout calculation
            const newRect = el.getBoundingClientRect();
            const newComputed = window.getComputedStyle(el);

            return {
                success: true,
                selector: args.selector,
                applied: args.css,
                metrics: {
                    before: {
                        width: Math.round(prevRect.width),
                        height: Math.round(prevRect.height),
                        scrollWidth: prevScrollWidth
                    },
                    after: {
                        width: Math.round(newRect.width),
                        height: Math.round(newRect.height),
                        scrollWidth: el.scrollWidth,
                        scrollHeight: el.scrollHeight
                    }
                },
                // Verify crucial properties that fix layout issues
                computedStatus: {
                    display: newComputed.display,
                    position: newComputed.position,
                    overflow: newComputed.overflow,
                    zIndex: newComputed.zIndex,
                    visibility: newComputed.visibility
                }
            };
        }, { selector, css });

        if (result.error) {
            response.appendResponseLine(result.error);
        } else {
            response.appendResponseLine(JSON.stringify(result, null, 2));
        }
    }
});

interface BoxModel {
    margin: string;
    padding: string;
    border: string;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface InspectResult {
    tagName: string;
    id: string;
    className: string;
    xpath: string;
    selector: string;
    rect: Rect;
    boxModel: BoxModel;
    layout: Record<string, string>;
    flex?: Record<string, string>;
    grid?: Record<string, string>;
    typography: Record<string, string>;
    background: Record<string, string>;
    attributes: Record<string, string>;
    error?: string;
}

export const inspectElement = defineTool({
    name: 'inspect_element',
    description: 'Inspects an element by selector or coordinates, highlighting it on the page and returning detailed computed styles, box model, and attributes. Useful for debugging specific element styling and layout.',
    annotations: { category: ToolCategory.DEBUGGING, readOnlyHint: true },
    schema: {
        selector: zod.string().optional().describe('CSS selector of the element to inspect.'),
        x: zod.number().optional().describe('X coordinate to find element at (if selector not provided).'),
        y: zod.number().optional().describe('Y coordinate to find element at (if selector not provided).'),
        highlight: zod.boolean().default(true).describe('Whether to draw a visual overlay on the element (default: true).'),
    },
    handler: async (request, response, context) => {
        const page = context.getSelectedPage();
        const { selector, x, y, highlight } = request.params;

        if (!selector && (x === undefined || y === undefined)) {
            throw new Error('Either "selector" or "x" and "y" coordinates must be provided.');
        }

        const result = await page.evaluate(
            (args: { selector?: string; x?: number; y?: number; highlight: boolean }): InspectResult => {
                let el: Element | null = null;

                // 1. Find Element
                if (args.selector) {
                    el = document.querySelector(args.selector);
                } else if (args.x !== undefined && args.y !== undefined) {
                    el = document.elementFromPoint(args.x, args.y);
                }

                if (!el) {
                    return {
                        error: 'Element not found',
                        tagName: '',
                        id: '',
                        className: '',
                        xpath: '',
                        selector: '',
                        rect: { x: 0, y: 0, width: 0, height: 0 },
                        boxModel: { margin: '', padding: '', border: '' },
                        layout: {},
                        typography: {},
                        background: {},
                        attributes: {}
                    };
                }

                // 2. Highlight (Draw Overlay)
                if (args.highlight) {
                    // Remove existing overlay
                    const existing = document.getElementById('mcp-inspect-overlay');
                    if (existing) existing.remove();

                    const rect = el.getBoundingClientRect();
                    const overlay = document.createElement('div');
                    overlay.id = 'mcp-inspect-overlay';
                    overlay.style.position = 'fixed';
                    overlay.style.left = `${rect.left}px`;
                    overlay.style.top = `${rect.top}px`;
                    overlay.style.width = `${rect.width}px`;
                    overlay.style.height = `${rect.height}px`;
                    overlay.style.backgroundColor = 'rgba(100, 149, 237, 0.3)'; // Cornflower blue
                    overlay.style.border = '2px solid rgba(100, 149, 237, 0.8)';
                    overlay.style.zIndex = '2147483647'; // Max z-index
                    overlay.style.pointerEvents = 'none'; // Don't block interactions

                    // Add label
                    const label = document.createElement('span');
                    label.textContent = `<${el.tagName.toLowerCase()}> ${Math.round(rect.width)}x${Math.round(rect.height)}`;
                    label.style.position = 'absolute';
                    label.style.top = '-20px';
                    label.style.left = '0';
                    label.style.backgroundColor = '#333';
                    label.style.color = '#fff';
                    label.style.padding = '2px 4px';
                    label.style.fontSize = '10px';
                    label.style.borderRadius = '2px';
                    overlay.appendChild(label);

                    document.body.appendChild(overlay);
                }

                // 3. Extract Details
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();

                // Helper to get only meaningful styles
                const getStyles = (props: string[]): Record<string, string> => {
                    const res: Record<string, string> = {};
                    props.forEach(p => res[p] = style.getPropertyValue(p));
                    return res;
                };

                function getSelector(element: Element | null): string {
                    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';

                    const path: string[] = [];
                    let current: Element | null = element;

                    while (current) {
                        // Strategy 1: Use ID if available
                        // IDs are assumed to be unique in valid HTML, making this the shortest anchor.
                        if (current.id) {
                            path.unshift(`#${CSS.escape(current.id)}`);
                            break;
                        }

                        // Strategy 2: Stop at Root elements
                        if (current === document.body) {
                            path.unshift('body');
                            break;
                        }
                        if (current === document.documentElement) {
                            path.unshift('html');
                            break;
                        }

                        // Strategy 3: Calculate structural selector
                        let selector = current.tagName.toLowerCase();
                        const parent: HTMLElement | null = current.parentElement;

                        if (parent) {
                            const siblings: HTMLCollection = parent.children;

                            // Optimization: Only append :nth-child if there are siblings
                            if (siblings.length > 1) {
                                let index = 1;
                                for (let i = 0; i < siblings.length; i++) {
                                    if (siblings[i] === current) break;
                                    index++;
                                }
                                selector += `:nth-child(${index})`;
                            }
                        }

                        path.unshift(selector);
                        current = current.parentElement;
                    }

                    return `${path.join(' > ')}`;
                }

                return {
                    tagName: el.tagName.toLowerCase(),
                    id: el.id,
                    className: el.className,
                    xpath: '', // Could use previous helper if injected
                    selector: getSelector(el),
                    rect: {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    },
                    boxModel: {
                        margin: style.margin,
                        padding: style.padding,
                        border: style.borderWidth
                    },
                    layout: getStyles(['display', 'position', 'top', 'left', 'right', 'bottom', 'z-index', 'float', 'clear', 'overflow']),
                    flex: style.display.includes('flex') ? getStyles(['flex-direction', 'justify-content', 'align-items', 'flex-wrap', 'gap']) : undefined,
                    grid: style.display.includes('grid') ? getStyles(['grid-template-columns', 'grid-template-rows', 'gap']) : undefined,
                    typography: getStyles(['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'text-align']),
                    background: getStyles(['background-color', 'background-image']),
                    attributes: Array.from(el.attributes).reduce((acc: Record<string, string>, attr) => {
                        acc[attr.name] = attr.value;
                        return acc;
                    }, {})
                };
            },
            { selector, x, y, highlight }
        );

        if (result.error) {
            response.appendResponseLine(`Error: ${result.error}`);
        } else {
            response.appendResponseLine(JSON.stringify(result, null, 2));
        }
    },
});

interface DomNode {
  tagName: string;
  id?: string;
  className?: string;
  attributes?: Record<string, string>;
  text?: string;
  children?: DomNode[];
  childCount?: number;
}

export const getDomTree = defineTool({
  name: 'get_dom_tree',
  description: 'Returns a simplified hierarchical JSON representation of the DOM tree. Useful for understanding page structure and parent-child relationships.',
  annotations: { category: ToolCategory.DEBUGGING, readOnlyHint: true },
  schema: {
    rootSelector: zod.string().optional().describe('CSS selector for the root element of the tree dump. Defaults to "body".'),
    maxDepth: zod.number().default(2).describe('Maximum depth to traverse children. Default is 2 to save tokens.'),
    includeAttributes: zod.boolean().default(false).describe('Whether to include all element attributes.'),
    includeText: zod.boolean().default(true).describe('Whether to include text content of nodes.'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const { rootSelector, maxDepth, includeAttributes, includeText } = request.params;

    const tree = await page.evaluate(
      (args) => {
        const root = args.rootSelector ? document.querySelector(args.rootSelector) : document.body;
        
        if (!root) {
          return { error: `Root element not found: ${args.rootSelector || 'body'}` };
        }

        function serializeNode(node: Element, currentDepth: number): DomNode {
          const result: DomNode = {
            tagName: node.tagName.toLowerCase(),
          };

          if (node.id) result.id = node.id;
          if (node.className && typeof node.className === 'string' && node.className.trim()) {
            result.className = node.className.trim();
          }

          if (args.includeAttributes && node.hasAttributes()) {
            result.attributes = {};
            for (let i = 0; i < node.attributes.length; i++) {
              const attr = node.attributes[i];
              // Skip style attribute to keep it clean, inspect_element handles styles better
              if (attr.name !== 'style' && attr.name !== 'class' && attr.name !== 'id') {
                result.attributes[attr.name] = attr.value;
              }
            }
          }

          if (args.includeText) {
            // Get direct text content, ignoring children's text
            let text = '';
            node.childNodes.forEach(child => {
              if (child.nodeType === Node.TEXT_NODE && child.textContent) {
                text += child.textContent.trim() + ' ';
              }
            });
            text = text.trim();
            if (text && text.length > 0) {
                result.text = text.length > 50 ? text.substring(0, 50) + '...' : text;
            }
          }

          const children = Array.from(node.children);
          if (children.length > 0) {
            if (currentDepth < args.maxDepth) {
              result.children = children.map(child => serializeNode(child, currentDepth + 1));
            } else {
              result.childCount = children.length;
            }
          }

          return result;
        }

        return serializeNode(root, 0);
      },
      { rootSelector, maxDepth, includeAttributes, includeText }
    );

    // @ts-ignore
    if (tree.error) {
      // @ts-ignore
      response.appendResponseLine(`Error: ${tree.error}`);
    } else {
      response.appendResponseLine(JSON.stringify(tree, null, 2));
    }
  },
});