// @purpose App-shell nav bar (W1-D) — client component rendered by the root layout on
// every page except /login. Brand + primary tabs (Home/Tank/Curve/Savings/Optimize/Control) with
// active-state derived from the current pathname, an Advanced overflow link, and a
// sign-out form that POSTs to /api/logout.
"use client";
import { usePathname } from "next/navigation";

export function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return (
    <nav className="nav">
      <span className="nav-brand">A2W Control</span>
      <span className="nav-sub">analytics & control</span>
      <div className="nav-tabs">
        <a href="/" className={pathname === "/" ? "active" : undefined}>
          Home
        </a>
        <a href="/hbx" className={pathname.startsWith("/hbx") ? "active" : undefined}>
          Tank
        </a>
        <a href="/curve" className={pathname.startsWith("/curve") ? "active" : undefined}>
          Curve
        </a>
        <a href="/savings" className={pathname.startsWith("/savings") ? "active" : undefined}>
          Savings
        </a>
        <a href="/optimize" className={pathname.startsWith("/optimize") ? "active" : undefined}>
          Optimize
        </a>
        <a href="/control" className={pathname.startsWith("/control") ? "active" : undefined}>
          Control
        </a>
      </div>
      <a className="nav-more" href="/advanced">
        Advanced →
      </a>
      <a className="nav-more" href="/security">
        Security
      </a>
      <form action="/api/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </nav>
  );
}
