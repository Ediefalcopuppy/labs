# Android 16-Inspired Local Calculator Design

## Goal

Build a local browser calculator for Chromium-based browsers. It should feel inspired by Android 16 / Material 3 Expressive: bright but controlled color, soft layered surfaces, rounded controls, tactile feedback, and snappy modern animations.

The calculator must run locally on the user's computer. It should not depend on restricted `brave://` or `chrome://` WebUI internals because normal web pages cannot import those protected browser resources.

## Scope

The app will be a dependency-free local web app made from plain HTML, CSS, and JavaScript.

Included:

- Basic calculator operations: digits, decimal input, clear, backspace, percent, sign toggle, addition, subtraction, multiplication, division, and equals.
- A display area with current value and lightweight expression/history context.
- An `fx` control that expands a scientific tray only when selected.
- A second collapsible menu inside the scientific tray for deeper scientific controls.
- Keyboard input whenever the calculator page is focused.
- Snappy, modern animations for button presses, tray expansion, menu collapse, display changes, and error feedback.
- Reduced-motion handling for users who prefer less animation.

Not included:

- Direct use of Brave or Chromium internal WebUI components.
- Network-backed services.
- Persistent calculation history.
- Unit conversion, graphing, CAS behavior, or programmable functions.

## Visual Direction

The app should borrow Android 16 / Material 3 Expressive cues without copying any proprietary system UI:

- Rounded, touch-friendly buttons with clear visual hierarchy.
- Layered surfaces with subtle translucency and blur.
- Expressive accent colors for operator, equals, and scientific controls.
- High contrast text with a calm calculator-focused layout.
- Responsive sizing that works on desktop and phone-width browser windows.

The main view should not feel like a marketing page. The calculator itself is the first screen.

## Interaction Design

The default state is a basic calculator. Scientific controls are hidden until the user selects `fx`.

When `fx` is selected:

1. The scientific tray expands below or above the main keypad depending on available width.
2. Common scientific controls are shown first, such as square, square root, power, inverse, pi, sin, cos, tan, and log.
3. A second menu button inside the tray expands additional controls, such as arcsin, arccos, arctan, ln, e, factorial, and parentheses.
4. Both the tray and the second menu can collapse independently.

Keyboard input is always available while the page is focused:

- Number keys enter digits.
- `.`, `+`, `-`, `*`, `/`, `%`, and parentheses map to calculator input.
- `Enter` and `=` evaluate.
- `Backspace` deletes the last input.
- `Escape` clears the current expression.
- Scientific shortcut keys are accepted only when the relevant scientific menu is visible, so hidden controls do not create surprising behavior.

## Animation Requirements

Animations should be brief, tactile, and responsive:

- Buttons compress slightly on press and rebound quickly.
- The `fx` tray expands with a spring-like reveal using opacity, transform, and height/grid transitions.
- The second scientific menu uses a tighter nested expansion so it reads as a sub-menu.
- Display updates should use a subtle upward/fade transition.
- Invalid operations should use a restrained shake or color pulse.
- All animations should respect `prefers-reduced-motion: reduce`.

## Architecture

Files:

- `index.html`: app structure and calculator controls.
- `styles.css`: Android 16-inspired visual styling, layout, responsive rules, and animations.
- `calculator.js`: UI state, input handling, keyboard handling, and expression evaluation.
- `calculator.test.js`: focused behavior tests for expression evaluation and key input mapping.
- `README.md`: local run instructions.

The calculator logic should be separated from DOM event wiring where practical:

- Expression state tracks entered tokens, display value, and last result.
- Input actions handle digits, operators, clear, delete, evaluate, and scientific functions.
- A small parser/evaluator handles supported expressions without using `eval`.
- UI rendering reads calculator state and updates display, tray state, and button accessibility attributes.

## Error Handling

The app should handle invalid inputs gracefully:

- Division by zero shows `Cannot divide by zero`.
- Invalid expressions show `Invalid expression`.
- Scientific domain errors, such as square root of a negative number, show a concise error.
- After an error, the next digit input starts a new expression; clear also resets the state.

## Accessibility

- Buttons use real `<button>` elements.
- Controls have clear labels or `aria-label` values.
- Expanded tray states use `aria-expanded`.
- Keyboard input does not trap focus.
- Visible focus styling is preserved.
- Color is not the only signal for active or error states.

## Testing

Use test-driven development for calculator behavior before implementation code.

Initial tests should cover:

- Operator precedence for `2 + 3 * 4`.
- Parentheses for `(2 + 3) * 4`.
- Decimal math.
- Percent behavior.
- Basic scientific functions.
- Division by zero.
- Keyboard mapping for digits, operators, equals, backspace, and escape.

Manual verification should cover:

- Opening the app locally in a Chromium-based browser.
- Basic calculations with mouse and keyboard.
- Expanding and collapsing the `fx` tray.
- Expanding and collapsing the second scientific menu.
- Responsive layout at desktop and narrow mobile widths.
- Reduced-motion behavior through browser or OS settings when available.
