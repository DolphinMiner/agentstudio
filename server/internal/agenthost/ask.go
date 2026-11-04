package agenthost

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/DolphinMiner/agentstudio/server/internal/agentproto"
)

// AskPrompt turns an "Ask an agent" payload into a plain prompt for agents
// that have no notion of asks (A2A, ACP, web connectors). The agent is asked
// for numbered drafts so ParseDrafts can split the answer.
func AskPrompt(ask *agentproto.Ask) string {
	var b strings.Builder
	request := strings.TrimSpace(ask.Request)
	if request == "" {
		request = "Draft a reply"
	}
	fmt.Fprintf(&b, "%s for this conversation", request)
	if ask.Chat != "" {
		fmt.Fprintf(&b, " with %s", ask.Chat)
	}
	if ask.App != "" {
		fmt.Fprintf(&b, " on %s", ask.App)
	}
	b.WriteString(":\n\n")
	for _, l := range ask.Lines {
		fmt.Fprintf(&b, "%s: %s\n", l.Speaker, l.Text)
	}
	b.WriteString("\nWrite 3 short reply options I could send, as a numbered list (1., 2., 3.), with no other text.")
	return b.String()
}

var draftLine = regexp.MustCompile(`^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$`)

// ParseDrafts extracts reply drafts from an agent's answer: numbered or
// bulleted lines when there are any, otherwise the whole answer as one draft.
func ParseDrafts(answer string) []string {
	var drafts []string
	for _, line := range strings.Split(answer, "\n") {
		if m := draftLine.FindStringSubmatch(line); m != nil {
			d := strings.Trim(m[1], `"“”`)
			if d != "" {
				drafts = append(drafts, d)
			}
		}
	}
	if len(drafts) == 0 {
		if t := strings.TrimSpace(answer); t != "" {
			drafts = []string{t}
		}
	}
	if len(drafts) > agentproto.MaxDrafts {
		drafts = drafts[:agentproto.MaxDrafts]
	}
	return drafts
}
