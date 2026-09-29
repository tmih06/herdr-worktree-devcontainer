// ESLint flat config. `npm run lint`.
//
// Recommended rules only, no stylistic ones: Prettier owns formatting, so a
// formatting rule here would be a second opinion on the same line and a
// disagreement between the two tools about which one to believe.
//
// The one rule switched off is `no-control-regex`. Every pane in this plugin is a
// TUI, and the escape sequences are matched literally — `/\x1b\[/` is how you
// recognise an ANSI sequence, not an accident. Turning the rule off here rather
// than suppressing it per line, because the alternative is an eslint-disable on
// every regex that does the only job it has.

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-control-regex": "off",
      // `_name` is this codebase's way of saying "deliberately unused" — a
      // destructured field kept for shape, a CLI flag accepted and ignored.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
