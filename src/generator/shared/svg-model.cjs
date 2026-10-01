'use strict';

// Canonical, dependency-free XML subset for SVG generation. No DTD/entity
// expansion or browser DOM dependency; malformed input fails before emission.
function decodeXml(value) {
  return value.replace(/&([^;\s<]*);|&/g, (whole, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    if (entity && /^#(?:x[0-9a-f]+|[0-9]+)$/i.test(entity)) {
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && point !== 0xfffe && point !== 0xffff)) return String.fromCodePoint(point);
    }
    throw new Error(`unsupported or invalid XML entity: ${whole}`);
  });
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseAttributes(source) {
  const attrs = [];
  const seen = new Set();
  let rest = source;
  while (rest.trim()) {
    const match = /^\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
    if (!match) throw new Error(`invalid SVG attribute syntax: ${rest.slice(0, 80)}`);
    const name = match[1];
    if (seen.has(name)) throw new Error(`duplicate SVG attribute: ${name}`);
    if (/^on/i.test(name)) throw new Error(`unsupported SVG event attribute: ${name}`);
    seen.add(name);
    const encoded = match[2] ?? match[3];
    if (encoded.includes('<')) throw new Error(`invalid XML attribute: ${name}`);
    attrs.push([name, decodeXml(encoded)]);
    rest = rest.slice(match[0].length);
  }
  return attrs;
}

function parseNodes(source) {
  const root = { children: [] };
  const stack = [root];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end < 0 || source.slice(index + 4, end).includes('--')) throw new Error('invalid XML comment');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end < 0) throw new Error('unclosed SVG CDATA');
      stack.at(-1).children.push({ text: source.slice(index + 9, end) });
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?xml', index) && index === 0) {
      const end = source.indexOf('?>', index + 5);
      if (end < 0) throw new Error('unclosed XML declaration');
      index = end + 2;
      continue;
    }
    if (source[index] !== '<') {
      const end = source.indexOf('<', index);
      const text = decodeXml(source.slice(index, end < 0 ? source.length : end));
      // Formatting whitespace outside text nodes has no SVG paint semantics.
      if (text.trim() || ['text', 'tspan'].includes(stack.at(-1).name)) stack.at(-1).children.push({ text });
      index = end < 0 ? source.length : end;
      continue;
    }
    let end = index + 1;
    let quote;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = undefined; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === source.length) throw new Error('unclosed SVG tag');
    const tag = source.slice(index + 1, end);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (stack.length === 1 || stack.at(-1).name !== name) throw new Error(`mismatched SVG closing tag: ${name}`);
      stack.pop();
    } else {
      const selfClosing = /\/\s*$/.test(tag);
      const body = selfClosing ? tag.replace(/\/\s*$/, '') : tag;
      const match = /^([A-Za-z_][\w:.-]*)/.exec(body);
      if (!match || /^(?:script|foreignObject)$/i.test(match[1])) throw new Error(`unsupported SVG element: ${body.slice(0, 80)}`);
      const node = { name: match[1], attrs: parseAttributes(body.slice(match[0].length)), children: [] };
      stack.at(-1).children.push(node);
      if (!selfClosing) stack.push(node);
    }
    index = end + 1;
  }
  if (stack.length !== 1) throw new Error(`unclosed SVG element: ${stack.at(-1).name}`);
  return root.children;
}

function parseSvg(source) {
  const nodes = parseNodes(source.trim());
  if (nodes.length !== 1 || nodes[0].name !== 'svg') throw new Error('SVG document must have one svg root');
  const root = nodes[0];
  return { viewBox: new Map(root.attrs).get('viewBox') ?? '0 0 24 24', rootAttrs: root.attrs, children: root.children };
}

function serializeNodes(nodes) {
  return nodes.map((node) => Object.hasOwn(node, 'text') ? escapeXml(node.text) :
    `<${node.name}${node.attrs.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('')}${node.children.length ? `>${serializeNodes(node.children)}</${node.name}>` : ' />'}`).join('');
}

const ROOT_METADATA = new Set(['viewBox', 'width', 'height', 'xmlns', 'xmlns:xlink', 'version']);
function rootPaintAttributes(rootAttrs, strategy) {
  const attrs = new Map(rootAttrs.filter(([name]) => !ROOT_METADATA.has(name)));
  if (strategy === 'outline') {
    if (!attrs.has('stroke')) attrs.set('stroke', 'currentColor');
    if (!attrs.has('fill')) attrs.set('fill', 'none');
    if (!attrs.has('stroke-width')) attrs.set('stroke-width', '2');
  } else if (strategy === 'solid' && !attrs.has('fill')) attrs.set('fill', 'currentColor');
  return attrs;
}

function normalizePaintChildren(children, strategy, rootAttrs = []) {
  const graphic = new Set(['path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text', 'use', 'image']);
  const rootWidth = new Map(rootAttrs).get('stroke-width') ?? '2';
  return children.map((node) => {
    if (Object.hasOwn(node, 'text')) return node;
    const attrs = node.attrs.flatMap(([name, value]) => {
      if (!graphic.has(node.name)) return [[name, value]];
      if (strategy === 'outline' && name === 'stroke-width' && value === '2' && rootWidth === '2') return [];
      const tint = /^(?:black|#000(?:000)?)$/i.test(value);
      return [[name, tint && ((strategy === 'outline' && name === 'stroke') || (strategy === 'solid' && name === 'fill')) ? 'currentColor' : value]];
    });
    const inherited = new Map(rootAttrs);
    const localWidth = new Map(node.attrs).get('stroke-width');
    if (localWidth !== undefined) inherited.set('stroke-width', localWidth);
    return { ...node, attrs, children: normalizePaintChildren(node.children, strategy, [...inherited]) };
  });
}

function prepareSvg(source, strategy) {
  const model = parseSvg(source);
  // Approved Figma artboard pair. Never remove a lone/other painted rect.
  const [first, second] = model.children;
  if (first?.name === 'rect' && second?.name === 'rect' && !first.children.length && !second.children.length) {
    const a = new Map(first.attrs), b = new Map(second.attrs);
    if (a.size === 3 && a.get('width') === '24' && a.get('height') === '24' && a.get('fill') === '#1E1E1E' &&
        b.size === 4 && /^\d+$/.test(b.get('width') ?? '') && /^\d+$/.test(b.get('height') ?? '') &&
        /^translate\(-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?\)$/.test(b.get('transform') ?? '') && b.get('fill') === 'white') model.children = model.children.slice(2);
  }
  model.children = normalizePaintChildren(model.children, strategy, model.rootAttrs);
  return model;
}

module.exports = { decodeXml, escapeXml, parseAttributes, parseNodes, parseSvg, prepareSvg, serializeNodes, rootPaintAttributes };
