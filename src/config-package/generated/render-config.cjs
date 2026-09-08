'use strict';

// Canonical renderer for the user-project `moeicons.config.jsonc`.
//
// Ownership: this module (moe-icons-code-library/config-package) is the single
// source of truth for the editable config skeleton. The CLI bundles a generated
// copy of this module plus a source digest and must never maintain a second
// full renderer.
//
// Behaviour contract:
// - schemaVersion 2 output is byte-stable with the historical CLI renderer for
//   the same catalog/target/tier inputs (semantics and ordering must not drift).
// - When `integration` is supplied (adapter/entry/style confirmed by the user),
//   the renderer emits schemaVersion 3 and adds the `integration` block. It
//   never invents integration paths on its own.
// - Deterministic output for identical inputs.

/**
 * @param {object} options
 * @param {"react"|"vue"|"vanilla"|"assets"} options.target
 * @param {"react"|"vue"} [options.framework] legacy alias; resolves to target
 * @param {"free"|"pro"} [options.tier]
 * @param {object} [options.integration] optional {adapter, entry, style}
 * @returns {string} JSONC skeleton text
 */
function renderMoeiconsConfigJsonc(options) {
  const ALLOWED = new Set(['target', 'framework', 'tier', 'catalog', 'integration']);
  for (const key of Object.keys(options)) {
    if (!ALLOWED.has(key)) {
      throw new Error(`unknown render option "${key}"`);
    }
  }
  const tier = options.tier ?? 'free';
  if (!options.catalog) {
    throw new Error('catalog is required');
  }
  const target = options.target ?? options.framework ?? 'react';

  const availableGroups = (options.catalog ? options.catalog.styleGroups : [])
    .filter((g) => Array.isArray(g.tiers) && g.tiers.includes(tier))
    .sort((a, b) => a.id.localeCompare(b.id));

  const defaultThemeName = 'outline';

  const themeLines = [];
  for (const group of availableGroups) {
    const themeName = group.id.replace(/^moe-/, '');
    if (group.type === 'bitmap') {
      const formatsComment = `// format options: ${group.formats.join(', ')}`;
      const sizesComment = `// imageSize options: ${group.imageSizes.join(', ')}`;
      themeLines.push(
        `    // ${themeName} — bitmap style (${group.id})`,
        `    // ${formatsComment}`,
        `    // ${sizesComment}`,
        `    // ${JSON.stringify(themeName)}: {`,
        `    //   "styleGroup": ${JSON.stringify(group.id)},`,
        `    //   "format": "webp",`,
        `    //   "imageSize": 256`,
        `    // },`,
      );
    } else {
      themeLines.push(
        `    ${JSON.stringify(themeName)}: {`,
        `      "styleGroup": ${JSON.stringify(group.id)}`,
        `    },`,
      );
    }
  }

  const tierGroupIds = new Set(availableGroups.map((g) => g.id));
  const groups = new Map();
  for (const icon of options.catalog ? options.catalog.icons : []) {
    if (!icon.availableIn.some((sg) => tierGroupIds.has(sg))) continue;
    const ids = groups.get(icon.prefix) ?? [];
    ids.push(icon.id);
    groups.set(icon.prefix, ids);
  }
  const iconLines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([prefix, ids]) => [
      `    // ${prefix} icons`,
      `    ${JSON.stringify(prefix)}: [`,
      ...ids.map((id) => `      ${JSON.stringify(id)},`),
      '    ],',
    ]);

  const schemaVersion = options.integration ? 3 : 2;
  const integrationBlock = options.integration
    ? [
        '',
        '  // User-confirmed application/style anchors (written only after',
        '  // confirmation; never auto-guessed).',
        `  "integration": {`,
        `    "adapter": ${JSON.stringify(options.integration.adapter)},`,
        ...(options.integration.entry !== undefined
          ? [`    "entry": ${JSON.stringify(options.integration.entry)},`]
          : []),
        ...(options.integration.style !== undefined
          ? [`    "style": ${JSON.stringify(options.integration.style)},`]
          : []),
        '  }',
      ]
    : [];

  return [
    '{',
    `  "schemaVersion": ${schemaVersion},`,
    `  "tier": ${JSON.stringify(tier)},`,
    `  "target": ${JSON.stringify(target)},`,
    `  "outputDir": "src/moeicons",`,
    `  "defaultTheme": ${JSON.stringify(defaultThemeName)},`,
    '  "themes": {',
    ...themeLines,
    `    // Set defaultTheme above to one of: ${availableGroups
      .filter((g) => g.type !== 'bitmap')
      .map((g) => JSON.stringify(g.id.replace(/^moe-/, '')))
      .join(', ')}`,
    '  },',
    '  // Comment out individual IDs or a complete prefix group to exclude it.',
    '  "icons": {',
    ...iconLines,
    '  },',
    `  "missingIconPolicy": "fallback"${options.integration ? ',' : ''}`,
    ...integrationBlock,
    '}',
    '',
  ].join('\n');
}

module.exports = { renderMoeiconsConfigJsonc };
