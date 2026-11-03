# Example: the Design system section for an SLDS file

Drop this in place of the **Design system** section of `../CLAUDE.md` if your files are
built on the Salesforce Lightning Design System. It is also a worked example of the level
of detail that section wants — name libraries, token paths and style names exactly, and
say which rules are absolute.

---

## Design system

- Files use SLDS v2 (Salesforce Lightning Design System) through the SLDS v2 Community,
  Salesforce Icons and Helpers libraries.
- Tokens live under `color/*`, `spacing/*`, `radius-border/*`. Text styles are
  `Body/font-scale-*` and `Titles/font-scale-3`. Bind to these instead of raw values.
- Reuse existing library components before drawing anything new.
- Layer names in the libraries start with ⚡, which is non-ASCII: use `findAllWithCriteria`
  or `findOne`, never `node.query()`.
- Body text is SF Pro. `characters` writes on SF Pro can silently fail to commit — use the
  Inter-first recipe in the Text section.
- Handoff specs should map each SLDS component to its Lightning base component
  (`lightning-button`, `lightning-datatable`, …) where one exists.
- Copy voice: clear and concise, sentence case, plain verbs, no filler, labels that say
  what happens.

### Modal assembly (SLDS modal component)

- After an INSTANCE_SWAP of the body slot the modal keeps its old fixed height and clips.
  Leave the inner Content frame on FILL and `resize()` the instance:
  height = 32 + 60 + 32 + body content + 64.
