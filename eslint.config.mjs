import typescriptEslint from "typescript-eslint";

const typescriptRules = {
  "@typescript-eslint/naming-convention": [
    "warn",
    {
      selector: "import",
      format: ["camelCase", "PascalCase"],
    },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",

  curly: "warn",
  eqeqeq: ["warn", "always", { null: "ignore" }],
  "no-throw-literal": "warn",
  semi: "warn",
  "no-console": ["warn", { allow: ["info", "warn", "error"] }],
  "prefer-const": "warn",
  "no-var": "error",
  "no-unused-expressions": ["warn", { allowShortCircuit: true, allowTernary: true }],
  "no-duplicate-imports": "warn",
  "no-useless-rename": "warn",
  "no-useless-return": "warn",
  "no-empty": ["warn", { allowEmptyCatch: true }],
  "object-shorthand": ["warn", "always"],
  "no-implicit-coercion": ["warn", { allow: ["!!"] }],
};

export default [
  {
    files: ["**/*.ts"],
  },
  {
    plugins: {
      "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },

    rules: typescriptRules,
  },
  {
    // Tests assert on a config shape we build inline, so non-null
    // assertions on cfg.folder![i] etc. are more readable than guards.
    // The stub also re-exports underscore-prefixed test hooks that would
    // trip naming-convention. Keep prod strict, relax here.
    files: ["src/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/naming-convention": "off",
      "no-console": "off",
    },
  },
];
