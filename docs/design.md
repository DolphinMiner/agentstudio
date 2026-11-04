# AgentStudio design system (v0.2)

## What Hullo gets right (from its production CSS and app mockups)

These notes come from `app.hullo.computer`'s production CSS (`index-*.css`) and the mockups on `hullo.computer`.

| Area | Hullo | What it achieves |
|---|---|---|
| Canvas | A "sky" background: layered radial highlights over a vertical blue gradient (`#cfe3fd → #e3eefc → #eff4fb → #f6f3f8`), ending in a faint pink | The app feels like a place rather than a white form |
| Surfaces | Frosted glass (`#ffffff8c`, `blur(18px) saturate(1.15)`), 1 px inner white ring instead of borders, very soft shadows (`0 8px 24px #14213d0f`) | Depth without lines or grey boxes |
| Ink | Navy ink, not black: `#14213d` text, `#46536f` / `#626d86` secondary, lines in ink at 8% alpha | Calm, cohesive contrast |
| Accent | One blue (`#1d4ed8` strong, `#a9cdff` soft) for actions and own messages | Actions are obvious, decoration stays out of the way |
| Radii | Pill (999) for buttons, chips and the composer; 22 for cards; 14 for rows; 18 for bubbles | A soft, consistent family |
| Type | A custom "Hullo Sans" (Rethink Sans), slight negative tracking on display sizes | Friendly, not corporate |
| Chat header | Centered avatar with the name in a white pill under it | A conversation is about a person or an agent, not a toolbar |
| Approval card | White card, title, countdown top-right ("45 min left"), an inset details row, two equal pills (filled approve, soft deny) | A decision is a single object you can act on in one tap |
| List | Agents get a horizontal strip above chats; each avatar carries a small network badge in its corner | You see where a chat lives without reading a label |
| Connectors (Grok Bot) | Rows with a 56 px app-icon tile, the name, and a grey "Connect" pill, grouped by category | Adding services feels like a catalog |

## AgentStudio's own direction: "the porch light"

AgentStudio should feel related to Hullo in quality but not in identity. Its subject is the porch: where you sit at the end of the day, and where a light is left on when someone is waiting for you. That is exactly what approvals are.

### Color

| Name | Hex | Use |
|---|---|---|
| Dusk ink | `#1A2233` | Text, filled primary buttons |
| Slate | `#5A6478` | Secondary text |
| Blue hour | `#D9E2F4 → #ECEFF7 → #F6F0EC` | Canvas gradient, evening sky. It ends in a warm last light, not Hullo's pink. |
| Porch light | `#F2A93B` (glow `#FFD58A`) | The one bold element: anything that waits on you, such as approval cards, the "Needs you" state and the approvals badge |
| Screen door | `#3247A8` | Own messages and links, a deep indigo distinct from Hullo's royal blue |
| Moss | `#2E7D5B` | Done and approved states |

### Type

- **Display:** Bricolage Grotesque (variable, OFL), used for chat titles, screen titles and approval titles, with tight tracking (−0.02em). It has a hand-made warmth.
- **Body:** the system UI font (SF Pro with PingFang for Chinese). It reads natively on macOS and handles CJK.
- **Scale:** 12 / 13 / 15 / 17 / 22 / 30.

### Shape and depth

- **Radii:** 999 for pills, 24 for cards, 14 for rows, 20 for bubbles. The bubble tail corner is 6.
- **Glass:** glass surfaces use a 1 px inner white ring, no grey borders.
- **Shadows:** one shadow token per elevation. Approval cards get the porch-light glow.

### Shape language carries meaning

- **Avatar shape:** people are circles, agents are squircles. On every screen you can tell a person from an agent at a glance.
- **Network badge:** a 16 px tile in the avatar's corner, showing which network the chat lives on.

### Layout (desktop)

```
┌────┬──────────────┬─────────────────────────────────────┐
│rail│ Inbox        │           ( avatar )                │
│    │ ┌search────┐ │            Name · status pill       │
│ ◎  │ agent strip  │                                     │
│ ✓• │ ○ ○ ◇ ◇      │   bubbles …                         │
│ ≡  │ rows …       │   ┌ approval card (porch glow) ┐    │
│ ⊕  │              │   └────────────────────────────┘    │
│    │              │  ( + )  Message …            ( ↑ )  │
└────┴──────────────┴─────────────────────────────────────┘
```

- **Rail:** a narrow 72 px icon rail with tooltips.
- **List pane:** frosted glass.
- **Chat pane:** sits directly on the sky.
- **Composer:** a floating pill.

### Principles

1. **The porch light is reserved.** Amber appears only where something waits on the user.
2. **Use less chrome.** No borders or eyebrow labels. Hierarchy comes from size, weight and glass.
3. **Motion answers actions.** Show sends, decisions and connects. Don't add idle animations.

## Icons and images

Every icon is a real asset. None is drawn by hand.

- **UI icons:** [Lucide](https://lucide.dev) (ISC) on desktop, Ionicons (MIT) on mobile.
- **Services AgentStudio connects to:** their official images, in `packages/brand` (see its README for sources).
- **Agents' and people's avatars:** their own pictures from Matrix, fetched with the session's token.
- **An agent without a picture** shows its service's icon (Grok Bot, Muse, ChatGPT, Cue, Concierge), else AgentStudio's agent icon. Agents never show initials or a generated color; only people do.
