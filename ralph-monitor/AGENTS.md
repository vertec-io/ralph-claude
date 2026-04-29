# ralph-monitor — agent notes

Reusable patterns picked up while implementing this app. Keep this file
short — only patterns we'd genuinely want to reach for again.

## UI

### Dedup-by-uuid Map for partial-record streams

When a stream emits both partial and final records sharing a uuid (Claude's
`is_partial: true` then the same record without it), build the renderable
list with `Map<uuid, record>`:

```ts
const map = new Map<string, Turn>()
for (const t of turns) map.set(t.uuid, t)
return [...map.values()]
```

The Map preserves first-insertion slot order while letting later writes
overwrite earlier ones in place — exactly the live-tail replacement
semantics we want. See `ui/components/SessionTranscript.tsx`
(`dedupeAndFilter`) for the production form, which also folds in the
sidechain / meta / raw filter.

### Sticky-bottom auto-scroll

Track a single `autoScroll` boolean toggled by a scroll listener that
checks `scrollHeight - scrollTop - clientHeight < 5`. Auto-scroll only
fires on new turns when `autoScroll` is true. Disable on scroll-up,
re-enable when the user comes back to the bottom. See `SessionTranscript`
for the canonical wiring.

### Code-fence rendering without a markdown lib

The session renderer intentionally does NOT use `marked` for chat text:
the only required formatting is triple-backtick code fences, and full
markdown parsing would inject paragraph/list semantics we don't want.
Splitter pattern:

```ts
const parts = text.split(/```(\w*)\n([\s\S]*?)```/g)
// parts[0] = text, parts[1] = lang, parts[2] = code, parts[3] = text, ...
```

Walk with `i % 3` to dispatch on text vs. language vs. code chunk. The
language tag is captured but ignored (no language-aware tokenization in
v1).

### Agent-tool-id propagation via context

To label an Agent tool's `tool_result` as "Final answer" without prop-
drilling, walk the turn list once to build a `Set<string>` of tool_use
ids whose name === 'Agent', then pass it down via React context. The
`tool_result` view consumes the set in O(1) per render.
