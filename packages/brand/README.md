# @agentstudio/brand

AgentStudio's own icon, and official images of the services AgentStudio connects to. The services' images appear only where AgentStudio names that service, for example on the Connect screen and as an agent's avatar fallback. Each one is a trademark of its owner, and none of these companies endorses AgentStudio.

| File | What | Source |
|---|---|---|
| `agentstudio.png` | AgentStudio's icon: a little house with its door lit, where your agents gather | Made for AgentStudio with GPT Image (the [ip-as-logo](https://github.com/s1dashu/ip-as-logo-skill) approach), recolored to the app's palette; Apache-2.0 like the rest of the repo. The macOS icon (`apps/desktop/resources/icon.icns`) is this image on Apple's icon grid. |
| `grokbot.png` | Grok Bot app icon | The macOS app bundle `Grok Bot.app/Contents/Resources/icon.icns` (0.78.3), cropped |
| `cue.png` | Cue app icon | The macOS app bundle `Cue.app/Contents/Resources/icon.icns` (1.0.12), cropped |
| `muse.jpg` | Muse mascot | `https://muse.ai/images/landing/brand/hatch.jpg` |
| `muse-mark.png` | Muse app mark (blue squiggle) | `https://muse.ai/images/favicon/app-squiggle.svg`, rendered at 256 px |
| `chatgpt.png` | ChatGPT logo (Dots runs in ChatGPT) | `https://chatgpt.com/cdn/assets/favicon-180x180.*.png` |
| `a2a.png` | A2A protocol icon | `a2aproject/A2A` `docs/assets/a2a_logo/icon/color/SVG/a2a_icon_color.svg`, rendered at 256 px |
| `acp.png` | Agent Client Protocol logo | `agentclientprotocol/agent-client-protocol` `docs/logo/fav-light.png` |
| `hermes.png` | Hermes Agent icon (Nous Research) | `NousResearch/hermes-agent` `assets/icon-master.svg`, rendered at 256 px |
| `openclaw.png` | OpenClaw mascot | `openclaw/openclaw` `apps/ios/WatchApp/Assets.xcassets/OpenClawIcon.imageset/openclaw-icon.png` |
| `matrix.png` | Matrix logo | `matrix-org/matrix.org` `static/images/matrix-favicon.svg`, rendered at 256 px |

Grok Bot's bot avatars (its shapes) are not shipped: the Mac app draws them on the user's Mac with the installed Grok Bot app's own code (see `apps/desktop/src/main/connectors/grokavatar.ts`).

AgentStudio's own UI icons come from [Lucide](https://lucide.dev) (ISC) on desktop and [Ionicons](https://ionic.io/ionicons) (MIT) on mobile.
