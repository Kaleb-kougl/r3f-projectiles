/**
 * Det-math guard rails (0.8.0, docs/detmath-plan.md "Guard rails").
 *
 * Everything under src/ that feeds the simulation or spawn data must produce the
 * same bits on every engine, so it may not call the engine's own transcendental
 * functions (their last bit is implementation-defined), Math.random, the `**`
 * operator (Math.pow), or three's trig-backed rotation helpers. Use
 * src/detmath.ts (detSin / detCos / detSinCos) and src/vecmath.ts instead, and
 * createSeededRandom (src/rng.ts) for randomness.
 *
 * Out of scope: src/render/** and src/dev.ts (drawing / dev tooling only, never
 * part of the simulated state), and src/__tests__/** (tests use Math.sin as a
 * reference implementation).
 */
const DET_MATH_MESSAGE =
  'Not bit-identical across JS engines. Use detSin / detCos / detSinCos from src/detmath.ts ' +
  '(or the helpers in src/vecmath.ts); for randomness take an rng and use createSeededRandom.';

const RESTRICTED_MATH = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'exp', 'expm1', 'log', 'log1p', 'log2', 'log10',
  'pow', 'hypot', 'cbrt', 'random',
];

const RESTRICTED_THREE_METHODS = [
  'setFromAxisAngle', 'applyQuaternion', 'applyAxisAngle', 'setFromEuler', 'applyEuler',
];

module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime'
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    'react/no-unknown-property': 'off',
    'react/prop-types': 'off',
    'react/react-in-jsx-scope': 'off'
  },
  overrides: [
    {
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      excludedFiles: ['src/render/**', 'src/dev.ts', 'src/__tests__/**'],
      rules: {
        'no-restricted-properties': [
          'error',
          ...RESTRICTED_MATH.map((property) => ({ object: 'Math', property, message: DET_MATH_MESSAGE })),
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "BinaryExpression[operator='**']",
            message: `\`**\` is Math.pow: ${DET_MATH_MESSAGE} For integer powers of two use exact integer ops.`,
          },
          {
            selector: "AssignmentExpression[operator='**=']",
            message: `\`**=\` is Math.pow: ${DET_MATH_MESSAGE}`,
          },
          {
            selector: `CallExpression[callee.property.name=/^(${RESTRICTED_THREE_METHODS.join('|')})$/]`,
            message: `three's rotation helpers use Math.sin / Math.cos: ${DET_MATH_MESSAGE}`,
          },
          {
            // `const { sin } = Math` / `const M = Math` would sidestep no-restricted-properties.
            selector: "VariableDeclarator[init.type='Identifier'][init.name='Math']",
            message: `Aliasing Math hides restricted calls from the det-math lint. ${DET_MATH_MESSAGE}`,
          },
        ],
      },
    },
  ],
};
