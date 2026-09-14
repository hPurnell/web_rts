/**
 * Local ESLint rules enforcing the architecture invariants in PLAN.md.
 *
 *   no-nondeterminism  — invariant 2: the simulation is deterministic.
 *   no-renderer-import — invariant 3: the simulation never imports the renderer.
 *
 * Both are applied to `src/sim/**` by eslint.config.js.
 */

const BANNED_MEMBERS = [
  ['Date', 'now'],
  ['performance', 'now'],
];

const BANNED_GLOBALS = new Set(['Date', 'performance', 'requestAnimationFrame']);

/** Math.imul is 32-bit integer multiply — the one Math member fixed-point needs. */
const ALLOWED_MATH = new Set(['imul', 'trunc', 'floor', 'ceil', 'abs', 'min', 'max', 'sign', 'round']);

const noNondeterminism = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban non-deterministic operations and float literals inside the simulation.' },
    schema: [],
    messages: {
      math: "Math.{{name}} is banned in the simulation (invariant 2). Use src/sim/fixed.ts or the trig tables.",
      member: '{{object}}.{{name}} is banned in the simulation (invariant 2). Time comes from the tick counter.',
      global: '`{{name}}` is banned in the simulation (invariant 2).',
      float: 'Float literal `{{raw}}` is banned in the simulation (invariant 2). Use Q16.16 via fromRatio/fromInt.',
    },
  },
  create(context) {
    function memberName(node) {
      if (node.computed) return node.property.type === 'Literal' ? String(node.property.value) : null;
      return node.property.type === 'Identifier' ? node.property.name : null;
    }
    return {
      MemberExpression(node) {
        const name = memberName(node);
        if (name === null) return;
        if (node.object.type === 'Identifier' && node.object.name === 'Math') {
          // Deny by default: only the integer helpers in ALLOWED_MATH are safe.
          if (!ALLOWED_MATH.has(name)) {
            context.report({ node, messageId: 'math', data: { name } });
          }
          return;
        }
        for (const [object, prop] of BANNED_MEMBERS) {
          if (node.object.type === 'Identifier' && node.object.name === object && name === prop) {
            context.report({ node, messageId: 'member', data: { object, name } });
          }
        }
      },
      Identifier(node) {
        if (!BANNED_GLOBALS.has(node.name)) return;
        // Only flag reads of the actual global, not properties or locals of the same name.
        const parent = node.parent;
        if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        if (parent && (parent.type === 'Property' && parent.key === node && !parent.computed)) return;
        const scope = context.sourceCode.getScope(node);
        const resolved = scope.references.find((r) => r.identifier === node)?.resolved;
        if (resolved && resolved.defs.length > 0) return; // locally declared, not the global
        context.report({ node, messageId: 'global', data: { name: node.name } });
      },
      Literal(node) {
        if (typeof node.value !== 'number') return;
        if (Number.isInteger(node.value)) return;
        context.report({ node, messageId: 'float', data: { raw: node.raw } });
      },
    };
  },
};

const noRendererImport = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban renderer, DOM and Babylon dependencies inside the simulation.' },
    schema: [],
    messages: {
      source: "The simulation must not import '{{source}}' (invariant 3).",
      dom: '`{{name}}` is a DOM global and is banned in the simulation (invariant 3).',
    },
  },
  create(context) {
    const DOM_GLOBALS = new Set(['window', 'document', 'navigator', 'HTMLElement', 'localStorage', 'fetch']);
    function checkSource(node, value) {
      if (typeof value !== 'string') return;
      const bad =
        value.includes('/render/') ||
        value.startsWith('babylonjs') ||
        value.startsWith('@babylonjs') ||
        /(^|\/)render($|\/)/.test(value);
      if (bad) context.report({ node, messageId: 'source', data: { source: value } });
    }
    return {
      ImportDeclaration: (node) => checkSource(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && checkSource(node, node.source.value),
      ExportAllDeclaration: (node) => node.source && checkSource(node, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && checkSource(node, node.source.value),
      Identifier(node) {
        if (!DOM_GLOBALS.has(node.name)) return;
        const parent = node.parent;
        if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
        const scope = context.sourceCode.getScope(node);
        const resolved = scope.references.find((r) => r.identifier === node)?.resolved;
        if (resolved && resolved.defs.length > 0) return;
        context.report({ node, messageId: 'dom', data: { name: node.name } });
      },
    };
  },
};

export default {
  rules: {
    'no-nondeterminism': noNondeterminism,
    'no-renderer-import': noRendererImport,
  },
};
