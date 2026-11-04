import type { ReactNode } from "react";
import { useStore } from "../lib/hooks";
import type { View } from "../lib/logic";
import { useWorkspace } from "../lib/workspace";
import { Icon } from "./Icon";

/** Narrow icon rail. Labels show as tooltips; the approvals badge is the porch light. */
export function Sidebar() {
  const { rt, route, go } = useWorkspace();
  const approvals = useStore(rt.approvals);
  const pending = approvals.items.length;

  const item = (view: View, label: string, icon: ReactNode, extra?: ReactNode) => (
    <button
      data-testid={`nav-${view}`}
      className={`rail-item${route.view === view ? " active" : ""}`}
      aria-current={route.view === view ? "page" : undefined}
      aria-label={label}
      title={label}
      onClick={() => go(view)}
    >
      {icon}
      {extra}
    </button>
  );

  return (
    <nav className="rail">
      <div className="rail-drag" />
      <div className="rail-items">
        {item("inbox", "Inbox", <Icon name="inbox" size={21} />)}
        {item(
          "approvals",
          "Approvals",
          <Icon name="approvals" size={21} />,
          pending > 0 ? (
            <span data-testid="nav-approvals-badge" className="rail-badge">
              {pending}
            </span>
          ) : null,
        )}
        {item("tasks", "Tasks", <Icon name="tasks" size={21} />)}
        {item("connect", "Connect", <Icon name="plus" size={21} />)}
      </div>
      <div className="rail-items rail-bottom">{item("settings", "Settings", <Icon name="gear" size={21} />)}</div>
    </nav>
  );
}
