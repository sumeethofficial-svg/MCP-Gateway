import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { cx } from "./ui";

const nav: {
  to: string;
  label: string;
  admin?: boolean;
}[] = [
  { to: "/", label: "Dashboard" },
  { to: "/chat", label: "Chat" },
  { to: "/stores", label: "Stores" },
  { to: "/servers", label: "Servers" },
  { to: "/keys", label: "API keys" },
  { to: "/connect", label: "Connect a client" },
  { to: "/audit", label: "Audit log" },
  { to: "/team", label: "Team", admin: true },
];

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = document.documentElement.dataset.theme;
    return saved === "dark" ? "dark" : "light";
  });

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;

    try {
      localStorage.setItem("sg-theme", next);
    } catch {
      // The theme still works if storage is unavailable.
    }

    setTheme(next);
  };

  return { theme, toggle };
}

export function Layout() {
  const { me, logout } = useAuth();
  const { theme, toggle } = useTheme();

  if (!me) return null;

  const items = nav.filter(
    (item) => !item.admin || me.user.role === "admin",
  );

  const tab = ({ isActive }: { isActive: boolean }) =>
    cx(
      "flex items-center gap-2 whitespace-nowrap border-r border-line px-4 py-2.5 text-[12px] font-medium uppercase tracking-wider transition",
      isActive
        ? "bg-ink text-bg"
        : "text-muted hover:bg-raised hover:text-ink",
    );

  const ghost =
    "px-3 py-2.5 text-[12px] uppercase tracking-wider text-muted transition hover:bg-raised hover:text-ink";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink bg-bg">
        <div className="flex items-stretch">
          <div className="flex items-center gap-2 border-r border-ink px-4 py-2.5">
            <span className="size-2.5 bg-accent" aria-hidden />
            <span className="text-[13px] font-semibold uppercase tracking-[0.12em]">
              MCP//Portal
            </span>
          </div>

          <nav
            className="hidden flex-1 overflow-x-auto border-l-0 md:flex"
            aria-label="Main"
          >
            {items.map(({ to, label }) => (
              <NavLink key={to} to={to} end={to === "/"} className={tab}>
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-stretch border-l border-line">
            <div className="hidden items-center px-4 text-[12px] text-muted xl:flex">
              {me.user.email}
            </div>

            <div className="hidden items-center border-l border-line px-4 text-right leading-tight xl:flex">
              <div>
                <p className="max-w-[12rem] truncate text-[12px] font-medium">
                  {me.user.name}
                </p>
                <p className="text-[10px] uppercase tracking-wider text-muted">
                  {me.user.role}
                </p>
              </div>
            </div>

            <button
              onClick={toggle}
              className={cx(ghost, "border-l border-line")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              type="button"
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>

            <button
              onClick={() => void logout()}
              className={cx(ghost, "border-l border-line")}
              title={me.user.email}
              type="button"
            >
              Sign out
            </button>
          </div>
        </div>

        <nav
          className="flex overflow-x-auto border-t border-line md:hidden"
          aria-label="Main"
        >
          {items.map(({ to, label }) => (
            <NavLink key={to} to={to} end={to === "/"} className={tab}>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="min-w-0 px-4 py-6 md:px-8 md:py-10">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}