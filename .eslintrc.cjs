/**
 * Det-math guard rails (0.8.0, docs/detmath-plan.md "Guard rails").
 *
 * Everything under src/ that feeds the simulation or spawn data must produce the
 * same bits on every engine, so it may not call the engine's own transcendental
 * functions (their last bit is implementation-defined), Math.random, the `**`
 * operator (Math.pow), or three's methods that run trig internally (rotations,
 * angles, slerps, spherical / cylindrical coordinates). Use
 * src/detmath.ts (detSin / detCos / detSinCos) and src/vecmath.ts instead, and
 * createSeededRandom (src/rng.ts) for randomness.
 *
 * `Math` reached through the global object (`globalThis.Math`, `window.Math`,
 * `self.Math`) is restricted too, since it would sidestep the `Math.*` rule.
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

/**
 * three methods that call Math.sin / cos / acos / atan2 internally (r184). Not
 * listed, because they use only exact operations: `setFromRotationMatrix` on
 * Quaternion (sqrt), `makeRotationFromQuaternion`, `setFromUnitVectors`
 * (sqrt). `applyQuaternion` is listed for its op order (three's to change),
 * not for trig.
 */
const RESTRICTED_THREE_METHODS = [
  'setFromAxisAngle', 'applyQuaternion', 'applyAxisAngle', 'setFromEuler', 'applyEuler',
  // Vector2 / Vector3 angles, and rotation about a point
  'angleTo', 'angle', 'rotateAround',
  // Matrix3 / Matrix4 rotations
  'makeRotationX', 'makeRotationY', 'makeRotationZ', 'makeRotationAxis', 'makeRotationFromEuler',
  // Spherical / Cylindrical coordinates (sin / cos one way, atan2 / acos the other)
  'setFromSphericalCoords', 'setFromCylindricalCoords', 'setFromSpherical', 'setFromCylindrical',
  'setFromCartesianCoords',
  // Quaternion interpolation and stepping
  'slerp', 'slerpQuaternions', 'rotateTowards',
];

/** three classes whose whole purpose is angle <-> vector conversion (via the setFrom* above). */
const RESTRICTED_THREE_CLASSES = ['Spherical', 'Cylindrical'];

/** Ways to reach Math without writing `Math.`. */
const GLOBAL_OBJECTS = ['globalThis', 'window', 'self'];

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
          ...GLOBAL_OBJECTS.map((object) => ({
            object,
            property: 'Math',
            message: `\`${object}.Math\` sidesteps the det-math lint on \`Math.*\`. ${DET_MATH_MESSAGE}`,
          })),
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
            message: `three's rotation / angle helpers use Math.sin / Math.cos / Math.atan2 / Math.acos: ${DET_MATH_MESSAGE}`,
          },
          {
            selector: `NewExpression[callee.name=/^(${RESTRICTED_THREE_CLASSES.join('|')})$/]`,
            message: `three's ${RESTRICTED_THREE_CLASSES.join(' / ')} convert through Math trig: ${DET_MATH_MESSAGE}`,
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
