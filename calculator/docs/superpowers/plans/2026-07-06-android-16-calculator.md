# Android 16 Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Chromium-friendly calculator with Android 16-inspired styling, snappy animations, collapsible scientific menus, keyboard input, and dark mode.

**Architecture:** Use a dependency-free static web app. Keep calculator parsing/evaluation in a small pure module that can be tested with Node's built-in test runner, and keep browser rendering, animation state, keyboard handling, and theme persistence in a separate UI module.

**Tech Stack:** HTML, CSS, JavaScript ES modules, Node `node:test`, local static server for browser verification.

---

## File Structure

- Create `package.json`: marks the project as ES modules and provides a `test` script.
- Create `index.html`: app structure, display, controls, scientific tray, secondary scientific menu, theme button.
- Create `styles.css`: Material 3 Expressive-inspired light/dark themes, responsive layout, reduced-motion handling, button/tray/display/error animations.
- Create `calculator-core.js`: pure expression tokenization, parsing, evaluation, percent/sign handling, scientific functions, and keyboard action mapping.
- Create `calculator.js`: browser state, DOM rendering, click handlers, keyboard handlers, tray/menu toggles, theme persistence.
- Create `calculator-core.test.js`: Node tests for calculator behavior and keyboard mapping.
- Create `README.md`: local run, test, and browser instructions.

## Task 1: Test Harness And Failing Core Tests

**Files:**
- Create: `package.json`
- Create: `calculator-core.test.js`

- [ ] **Step 1: Add the package test script**

```json
{
  "name": "android-16-calculator",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test calculator-core.test.js"
  }
}
```

- [ ] **Step 2: Write failing tests for required calculator behavior**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  createCalculatorState,
  evaluateExpression,
  keyToAction,
} from './calculator-core.js';

test('evaluates multiplication before addition', () => {
  assert.equal(evaluateExpression('2 + 3 * 4').value, 14);
});

test('evaluates parentheses before multiplication', () => {
  assert.equal(evaluateExpression('(2 + 3) * 4').value, 20);
});

test('evaluates decimal arithmetic', () => {
  assert.equal(evaluateExpression('1.5 + 2.25').value, 3.75);
});

test('evaluates percent as value divided by one hundred', () => {
  assert.equal(evaluateExpression('50 %').value, 0.5);
});

test('evaluates common scientific functions', () => {
  assert.equal(evaluateExpression('sqrt(81)').value, 9);
  assert.equal(evaluateExpression('sin(90)').value, 1);
  assert.equal(evaluateExpression('log(100)').value, 2);
});

test('returns a division by zero error', () => {
  assert.equal(evaluateExpression('8 / 0').error, 'Cannot divide by zero');
});

test('returns invalid expression for incomplete input', () => {
  assert.equal(evaluateExpression('2 +').error, 'Invalid expression');
});

test('maps keyboard keys to calculator actions', () => {
  assert.deepEqual(keyToAction({ key: '7' }), { type: 'input', value: '7' });
  assert.deepEqual(keyToAction({ key: '*' }), { type: 'input', value: '*' });
  assert.deepEqual(keyToAction({ key: 'Enter' }), { type: 'evaluate' });
  assert.deepEqual(keyToAction({ key: 'Backspace' }), { type: 'backspace' });
  assert.deepEqual(keyToAction({ key: 'Escape' }), { type: 'clear' });
});

test('updates calculator state through input and evaluation actions', () => {
  let state = createCalculatorState();
  for (const value of ['2', '+', '3', '*', '4']) {
    state = applyAction(state, { type: 'input', value });
  }
  state = applyAction(state, { type: 'evaluate' });
  assert.equal(state.display, '14');
  assert.equal(state.expression, '2 + 3 * 4');
});
```

- [ ] **Step 3: Run the tests and verify they fail for the right reason**

Run: `npm test`

Expected: `ERR_MODULE_NOT_FOUND` for `calculator-core.js`, proving the behavior tests exist before implementation.

- [ ] **Step 4: Commit the failing tests**

```bash
git add calculator/package.json calculator/calculator-core.test.js
git commit -m "test: add calculator behavior tests"
```

## Task 2: Calculator Core

**Files:**
- Create: `calculator-core.js`
- Modify: `calculator-core.test.js`

- [ ] **Step 1: Implement the pure calculator core**

Create `calculator-core.js` with these exported functions and behavior:

```js
export function createCalculatorState() {
  return {
    expression: '',
    display: '0',
    error: '',
    justEvaluated: false,
  };
}

export function keyToAction(event) {
  const key = event.key;
  if (/^[0-9]$/.test(key)) return { type: 'input', value: key };
  if (key === '.') return { type: 'input', value: '.' };
  if (['+', '-', '*', '/', '%', '(', ')'].includes(key)) return { type: 'input', value: key };
  if (key === 'Enter' || key === '=') return { type: 'evaluate' };
  if (key === 'Backspace') return { type: 'backspace' };
  if (key === 'Escape') return { type: 'clear' };
  return null;
}
```

Then add tokenization, parser, and action handling below those exports:

- `evaluateExpression(expression)` returns `{ value: number }` or `{ error: string }`.
- Operators supported: `+`, `-`, `*`, `/`, `%`, `^`.
- Parentheses supported.
- Functions supported: `sqrt`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `log`, `ln`.
- Constants supported: `pi`, `e`.
- Trig functions take degrees for user-friendly calculator behavior.
- Division by zero returns `{ error: 'Cannot divide by zero' }`.
- Invalid expressions return `{ error: 'Invalid expression' }`.
- Scientific domain errors return `{ error: 'Invalid expression' }`.
- No use of `eval`, `Function`, or string-to-code execution.

- [ ] **Step 2: Add focused tests for constants and domain errors**

Append to `calculator-core.test.js`:

```js
test('evaluates constants and powers', () => {
  assert.equal(evaluateExpression('pi').value, Math.PI);
  assert.equal(evaluateExpression('2 ^ 3').value, 8);
});

test('returns invalid expression for scientific domain errors', () => {
  assert.equal(evaluateExpression('sqrt(-1)').error, 'Invalid expression');
});
```

- [ ] **Step 3: Run the tests and verify they pass**

Run: `npm test`

Expected: all calculator-core tests pass.

- [ ] **Step 4: Commit the core implementation**

```bash
git add calculator/calculator-core.js calculator/calculator-core.test.js
git commit -m "feat: implement calculator core"
```

## Task 3: Browser Markup And Styling

**Files:**
- Create: `index.html`
- Create: `styles.css`

- [ ] **Step 1: Create the browser app shell**

`index.html` should include:

- A root `<main class="calculator-shell">`.
- A top app bar with the calculator title, theme toggle button, and `fx` toggle button.
- A display region with expression and result lines.
- A basic keypad with buttons for clear, backspace, sign, percent, digits, decimal, operators, and equals.
- A scientific tray with common scientific buttons.
- A nested collapsible secondary scientific menu with deeper functions and parentheses.
- `<script type="module" src="./calculator.js"></script>`.

- [ ] **Step 2: Style the Android 16-inspired interface**

`styles.css` should include:

- Light and dark theme variables on `:root` and `:root[data-theme="dark"]`.
- Deep dark surfaces and luminous accents in dark mode.
- Touch-friendly button dimensions with stable grid sizing.
- Springy button press animation using transform and box-shadow.
- Tray expansion/collapse using grid-template-rows, opacity, and transform.
- Display update transition.
- Error pulse/shake animation.
- Responsive layout for desktop and narrow browser widths.
- `@media (prefers-reduced-motion: reduce)` that removes nonessential animation.

- [ ] **Step 3: Run a static syntax smoke check**

Run: `node --check calculator.js`

Expected before Task 4: failure because `calculator.js` does not exist yet. This is acceptable at this task boundary.

- [ ] **Step 4: Commit the markup and styles**

```bash
git add calculator/index.html calculator/styles.css
git commit -m "feat: add calculator interface"
```

## Task 4: Browser UI Wiring, Keyboard Input, Trays, And Theme

**Files:**
- Create: `calculator.js`
- Modify: `index.html`
- Modify: `styles.css`

- [ ] **Step 1: Create browser state and rendering**

`calculator.js` should:

- Import `applyAction`, `createCalculatorState`, and `keyToAction` from `./calculator-core.js`.
- Hold state for calculator expression, display, errors, `isScientificOpen`, `isAdvancedOpen`, and `theme`.
- Render display text after every action.
- Add transient CSS classes for display update and error animation.

- [ ] **Step 2: Add click handling**

Button handling should use `data-action` and `data-value` attributes:

```js
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const value = button.dataset.value;
  handleUiAction(action, value);
});
```

`handleUiAction` should route:

- `input` to `applyAction(state, { type: 'input', value })`.
- `evaluate`, `clear`, and `backspace` to matching core actions.
- `toggle-scientific` to open or close the `fx` tray.
- `toggle-advanced` to open or close the nested menu.
- `theme` to switch light/dark mode.

- [ ] **Step 3: Add keyboard handling**

```js
document.addEventListener('keydown', (event) => {
  const action = keyToAction(event);
  if (!action) return;
  event.preventDefault();
  state = applyAction(state, action);
  render();
});
```

Scientific keyboard shortcuts should be explicit and accepted only when the relevant tray is visible:

- `p` inserts `pi` when scientific tray is open.
- `s` inserts `sin(` when scientific tray is open.
- `c` inserts `cos(` when scientific tray is open.
- `t` inserts `tan(` when scientific tray is open.
- `l` inserts `log(` when scientific tray is open.
- `n` inserts `ln(` when advanced menu is open.

- [ ] **Step 4: Add theme persistence**

Theme logic should:

- Read `localStorage.getItem('calculator-theme')`.
- Fall back to `matchMedia('(prefers-color-scheme: dark)')`.
- Apply the active theme through `document.documentElement.dataset.theme`.
- Save user changes with `localStorage.setItem('calculator-theme', nextTheme)`.
- Update the theme button `aria-label` to the next action.

- [ ] **Step 5: Run automated checks**

Run: `npm test`

Expected: all calculator-core tests pass.

Run: `node --check calculator.js`

Expected: no syntax errors.

- [ ] **Step 6: Commit UI wiring**

```bash
git add calculator/calculator.js calculator/index.html calculator/styles.css
git commit -m "feat: wire calculator interactions"
```

## Task 5: README And Browser Verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Add local run instructions**

`README.md` should include:

```md
# Android 16-Inspired Calculator

A dependency-free local browser calculator for Chromium-based browsers.

## Run

From this folder:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173` in Brave, Chrome, Chromium, or another Chromium-based browser.

## Test

```bash
npm test
```

## Controls

- Type numbers and operators directly on the keyboard.
- Press `Enter` or `=` to evaluate.
- Press `Backspace` to delete.
- Press `Escape` to clear.
- Select `fx` to reveal scientific controls.
- Use the nested menu inside `fx` for advanced functions.
- Use the theme button to switch light and dark mode.
```

- [ ] **Step 2: Run all automated checks**

Run: `npm test`

Expected: all tests pass.

Run: `node --check calculator.js`

Expected: no syntax errors.

- [ ] **Step 3: Start a local browser server**

Run: `python3 -m http.server 4173`

Expected: local server starts at `http://localhost:4173`.

- [ ] **Step 4: Manually verify in Chromium-based browser**

Verify:

- Basic click calculation: `2 + 3 * 4 = 14`.
- Keyboard calculation: type `(2+3)*4`, press `Enter`, see `20`.
- `fx` tray opens and closes with a snappy animation.
- Nested scientific menu opens and closes independently.
- Scientific calculation: `sqrt(81) = 9`.
- Theme button switches between light and dark mode.
- Reload preserves the selected theme.
- Narrow viewport keeps buttons readable and non-overlapping.

- [ ] **Step 5: Commit docs and final verification**

```bash
git add calculator/README.md
git commit -m "docs: add calculator run instructions"
```

## Self-Review

- Spec coverage: basic operations are covered by Tasks 1-2 and Task 4; scientific tray and nested menu by Tasks 3-4; keyboard input by Tasks 1 and 4; Android 16-inspired styling, dark mode, and animations by Tasks 3-4; README and local run instructions by Task 5.
- Placeholder scan: no unresolved planning markers or vague deferred-work language is present.
- Type consistency: exported functions are `createCalculatorState`, `evaluateExpression`, `applyAction`, and `keyToAction`; those names are used consistently in tests and browser wiring.
