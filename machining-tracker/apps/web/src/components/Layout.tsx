import { useState, type ComponentType } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, Bell, ClipboardCheck, ClipboardList, Cog, Factory, FileBarChart, FileSpreadsheet, Gauge, IndianRupee, MessageCircle, HeartPulse, Home, ListChecks, LogOut, Menu, PlusCircle, Scale, ShieldCheck, UserCircle, Users, X } from "lucide-react";
import type { PermissionKey } from "@cess/shared";
import { useAuth } from "../auth/AuthProvider";
import { useUnreadCount } from "../hooks/notifications";
import { cx } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  anyOf?: PermissionKey[];
}

// Only modules that are fully working are listed.
const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/jobs", label: "Jobs Register", icon: ClipboardList, anyOf: ["jobs.view_all", "jobs.view_assigned"] },
  { to: "/jobs/new", label: "New Job", icon: PlusCircle, anyOf: ["jobs.create"] },
  { to: "/vendors", label: "Vendors", icon: Factory, anyOf: ["vendors.view"] },
  { to: "/vendors/reliability", label: "Vendor Reliability", icon: Gauge, anyOf: ["reliability.view"] },
  { to: "/quotes", label: "Cost Comparison", icon: Scale, anyOf: ["costcompare.view"] },
  { to: "/payments", label: "Payments", icon: IndianRupee, anyOf: ["payments.view"] },
  { to: "/whatsapp", label: "WhatsApp", icon: MessageCircle, anyOf: ["whatsapp.send"] },
  { to: "/quality", label: "Quality", icon: ClipboardCheck, anyOf: ["quality.manage", "returns.record", "reports.view"] },
  { to: "/reports", label: "Weekly Reports", icon: FileBarChart, anyOf: ["reports.view"] },
  { to: "/jobs/review", label: "Missing Data", icon: ListChecks, anyOf: ["jobs.view_all", "jobs.view_assigned"] },
  { to: "/data", label: "Excel Import / Export", icon: FileSpreadsheet, anyOf: ["data.import", "reports.export"] },
  { to: "/admin/users", label: "Users", icon: Users, anyOf: ["users.manage"] },
  { to: "/admin/permissions", label: "Roles & Permissions", icon: ShieldCheck, anyOf: ["users.manage"] },
  { to: "/settings", label: "Settings", icon: Cog, anyOf: ["settings.change", "users.manage"] },
  { to: "/activity", label: "Activity History", icon: Activity, anyOf: ["activity.view"] },
  { to: "/system", label: "System Health", icon: HeartPulse, anyOf: ["system.view"] },
  { to: "/account", label: "My Account", icon: UserCircle },
];

export function Layout() {
  const { access, can, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const items = NAV.filter((n) => !n.anyOf || n.anyOf.some((p) => can(p)));
  const unread = useUnreadCount();

  const nav = (
    <nav className="flex-1 space-y-0.5 px-2 py-3" aria-label="Main">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/" || item.to === "/jobs" || item.to === "/vendors"}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
              isActive ? "bg-white/10 text-white" : "text-brand-100 hover:bg-white/5 hover:text-white",
            )
          }
        >
          <item.icon className="h-4 w-4" />
          {item.label}
          {item.to === "/notifications" && unread > 0 && (
            <span className="ml-auto rounded-full bg-accent-500 px-2 py-0.5 text-xs font-semibold text-brand-900" aria-label={`${unread} unread`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full w-64 flex-col bg-brand-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-4">
        <img src="/favicon.svg" alt="" className="h-8 w-8" />
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">CESS Machining</p>
          <p className="text-xs text-brand-100">Job &amp; Vendor Tracker</p>
        </div>
      </div>
      {nav}
      <div className="border-t border-white/10 p-3">
        <p className="truncate text-sm font-medium text-white">{access?.full_name || access?.email}</p>
        <p className="truncate text-xs text-brand-100">{access?.role_label}</p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-brand-100 hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <div className="relative">{sidebar}</div>
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="relative m-3 h-9 w-9 rounded-md bg-white p-2">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="rounded-md p-1.5 hover:bg-slate-100">
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-slate-800">CESS Machining Tracker</span>
          <NavLink to="/notifications" className="relative ml-auto rounded-md p-1.5 hover:bg-slate-100" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Bell className="h-5 w-5 text-slate-700" />
            {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
          </NavLink>
        </header>
        <main key={location.pathname} className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
