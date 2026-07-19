import { useEffect, useMemo, useState } from "react";
import { clearConsoleData } from "./storage";
import type { Policy } from "./types";
import Dashboard from "./pages/Dashboard";
import VerdictLab from "./pages/VerdictLab";
import Approvals from "./pages/Approvals";
import TokenWorkbench from "./pages/TokenWorkbench";
import TelegramBinding from "./pages/TelegramBinding";
import Policies from "./pages/Policies";
import Spend from "./pages/Spend";
import Access from "./pages/Access";

export type RouteId = "dashboard" | "verdict" | "approvals" | "spend" | "tokens" | "telegram" | "policies" | "access";

const ROUTES: { id: RouteId; label: string; mark: string }[] = [
  { id: "dashboard", label: "Dashboard", mark: "01" },
  { id: "verdict", label: "Verdict Lab", mark: "02" },
  { id: "approvals", label: "Approvals", mark: "03" },
  { id: "spend", label: "Spend", mark: "04" },
  { id: "tokens", label: "Token Workbench", mark: "05" },
  { id: "telegram", label: "Telegram Binding", mark: "06" },
  { id: "policies", label: "Policies", mark: "07" },
  { id: "access", label: "Access & Recovery", mark: "08" },
];

function routeFromHash(): RouteId {
  const value = window.location.hash.replace(/^#\/?/, "") as RouteId;
  return ROUTES.some((route) => route.id === value) ? value : "dashboard";
}

export default function App() {
  const [route, setRoute] = useState<RouteId>(routeFromHash);
  const [activeApprovalId, setActiveApprovalId] = useState("");
  const [labPolicy, setLabPolicy] = useState<Policy | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function navigate(next: RouteId) {
    window.location.hash = next;
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const page = useMemo(() => {
    if (route === "dashboard") return <Dashboard />;
    if (route === "verdict") {
      return (
        <VerdictLab
          initialPolicy={labPolicy}
          onApproval={(id) => {
            setActiveApprovalId(id);
            navigate("approvals");
          }}
        />
      );
    }
    if (route === "approvals") return <Approvals initialApprovalId={activeApprovalId} />;
    if (route === "spend") return <Spend />;
    if (route === "tokens") return <TokenWorkbench />;
    if (route === "telegram") return <TelegramBinding />;
    if (route === "access") return <Access />;
    return (
      <Policies
        onUsePolicy={(policy) => {
          setLabPolicy(policy);
          navigate("verdict");
        }}
      />
    );
  }, [route, labPolicy, activeApprovalId]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#dashboard" aria-label="Claw Console dashboard">
          <img src="./logo.png" alt="" />
          <span>
            <strong>Claw Console</strong>
            <small>Operator workbench</small>
          </span>
        </a>

        <nav className="primary-nav" aria-label="Console sections">
          {ROUTES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={route === item.id ? "active" : ""}
              aria-current={route === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <span>{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="live-dot" />
          <strong>Judge mode</strong>
          <p>Public, browser-only, and connected to the real free API.</p>
        </div>

        <button
          type="button"
          className="clear-data"
          onClick={() => {
            if (window.confirm("Clear this browser’s Console history, tokens, preferences, and credential slots?")) {
              clearConsoleData();
              window.location.reload();
            }
          }}
        >
          Clear local data
        </button>
      </aside>

      <main className="main-content">
        <div className="safety-banner">
          <span>Free API only</span>
          The Console is hard-blocked from all paid routes. Generated IDs start with <code>console-</code>.
        </div>
        {page}
        <footer className="console-footer">
          <span>Your agent asks before it spends.</span>
          <span>
            <a href="https://clawinabox.xyz/documentation.html" target="_blank" rel="noreferrer">Docs</a>
            <a href="https://api.clawinabox.xyz/skill.md" target="_blank" rel="noreferrer">Skill</a>
            <a href="https://github.com/ckeda/claw-in-a-box" target="_blank" rel="noreferrer">Source</a>
          </span>
        </footer>
      </main>
    </div>
  );
}
