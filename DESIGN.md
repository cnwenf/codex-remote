# Design System

## Direction

Codex Remote uses a quiet, native-feeling control surface optimized for a phone held in one hand. The interface stays visually light so task state, conversation content, approvals, and the next useful action remain dominant. It avoids dashboard decoration, nested cards, and dense desktop chrome.

## Theme

The product follows the operating system through `prefers-color-scheme`. Light mode uses cool near-white canvases and softly tinted surfaces. Dark mode uses blue-tinted charcoal surfaces rather than pure black. Both themes share the same semantic roles:

- `canvas`: page background.
- `surface`: standard controls and content surfaces.
- `surface-muted`: selected rows, user messages, and inactive controls.
- `floating-surface`: navigation pills, composer, and other elevated controls.
- `ink` and `ink-muted`: primary and supporting text.
- `action`: the restrained blue used only for primary actions and active progress.
- `success`, `warning`, and `danger`: explicit state colors.

All tokens are expressed in OKLCH. Text and controls must meet WCAG 2.1 AA contrast in both themes.

## Typography

Use the platform system sans-serif stack. Titles use compact weight and size contrast; body text prioritizes comfortable mobile reading. Long assistant responses stay within 72 characters per line on wide screens. Code continues to use the platform monospace stack.

## Layout

- Mobile navigation uses a centered `Remote` title, a flat project and conversation hierarchy, and bottom search and compose controls within thumb reach.
- Conversation pages use a pill-shaped context header, an unconstrained message canvas, and a floating composer.
- Desktop keeps the existing two-column information architecture while sharing the same tokens, spacing, rounded controls, and flat rows.
- Safe-area insets are respected on every fixed or bottom-aligned control.

## Components and Motion

Interactive targets are at least 44 CSS pixels. Buttons, inputs, list rows, dialogs, and approval sheets retain visible focus, disabled, loading, and error states. Transitions use short ease-out curves and never animate layout. Reduced-motion preferences disable progress and typing animation.
