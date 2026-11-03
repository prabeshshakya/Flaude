# Figma working rules

Loaded into every Claude Bridge session. Edit freely; changes apply to the next new chat.

Everything below **Design system** is generic Figma Plugin API behaviour and applies to any
file. The Design system section is the part you fill in for your own team.

## Design system

<!-- Replace this section with your own. Delete any line you can't answer yet;
     a wrong rule costs more than a missing one. -->

- **Libraries**: the published libraries this file draws from, by name. Reuse their
  components before drawing anything new.
- **Variables**: where tokens live, by collection and path prefix (for example
  `color/*`, `spacing/*`, `radius/*`). Bind to these instead of typing raw values.
- **Text styles**: the naming scheme (for example `Body/*`, `Heading/*`) and which style
  is the default body text.
- **Fonts**: the families this file uses, and which one is safe to write with (see Text).
- **Conventions**: anything a newcomer would get wrong — layer naming, page structure,
  how states and variants are organised, what must never be detached.

Without this section Claude still works: it reads the file and infers the system from
what's there. Filling it in makes it faster and stops it guessing.

## Text

- `characters` writes can silently fail to commit on some font families: the call
  reports the new string, the document keeps the old one. Set `fontName` to a reliable
  family (Inter is a safe default) before writing characters. Read `node.fontName`
  first and restore it afterwards; a mixed value falls back to Regular silently, so
  compare weights against a reference row.
- Set `textAutoResize = 'WIDTH_AND_HEIGHT'` before writing characters. Toggling it after
  a write leaves stale wrapped heights that never remeasure; the only fix then is to
  replace the text node.
- Create text nodes at natural size first, then pin fixed widths that are already wider
  than the string.
- `setProperties` on a nested button's TEXT property can fail with "font isn't available"
  even when the font is loaded. Write `characters` on the nested label text node with the
  recipe above instead; the button still hugs.

## Instances and layout

- Sizing overrides (`resize`, `layoutSizingHorizontal`, `textAutoResize`) on instance
  descendants are silently ignored. Detach the wrapper, or `swapComponent` to a cloned
  local component.
- `appendChild` into a live instance subtree is not allowed.
- To reuse parts with editable text, `clone()` a node from an existing instance. Paints
  copied this way keep their `boundVariables`, so tokens stay bound without importing
  variables.
- `resize()` resets auto-layout sizing modes to FIXED. Re-apply HUG after resizing or the
  frame collapses.
- `node.query()` throws on non-ASCII layer names (icons, emoji and symbols in names are
  common in design-system libraries). Use `findAllWithCriteria` or `findOne`.

## Composite components (modals, drawers, cards with slots)

- Assembly: build the body as a plain frame (clone an existing one so tokens come along),
  `createComponentFromNode`, clone the container instance, then `setProperties` its
  INSTANCE_SWAP slot to the new component id. No detaching.
- After swapping a slot the container keeps its old fixed height and clips. Leave the
  inner content frame on FILL and `resize()` the instance to padding + header + body +
  footer.

## Checking work

- `get_metadata` reflects document truth when a screenshot looks wrong.
- After edits, take one screenshot of the edited area and compare before reporting done.
  Don't screenshot every intermediate step.
