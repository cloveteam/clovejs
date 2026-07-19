import js from "@eslint/js"
import tseslint from "typescript-eslint"
import globals from "globals"

export default tseslint.config(
  {
    // Generated or vendored output is never linted.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "docs/.vitepress/dist/**",
      "docs/.vitepress/cache/**",
      // Fixtures are deliberately minimal apps, not library source.
      "test/fixtures/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      // Unused args are common in middleware/handler signatures; allow the
      // conventional underscore opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // `node` is the cursor in the container's scope-chain walks, which
      // legitimately start at `this`.
      "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["node"] }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": ["error", { destructuring: "all" }],
      "no-var": "error",
    },
  },

  {
    // The CLI and dev server talk to the user over stdout by design.
    files: ["src/cli/**/*.ts", "src/dev/**/*.ts", "src/container/logger.ts"],
    rules: { "no-console": "off" },
  },

  {
    files: ["test/**/*.ts", "*.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
)
